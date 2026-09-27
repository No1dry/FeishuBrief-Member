import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContentError, ContentService, type VerifiedExport } from '../src/content';
import { Store } from '../src/db';
import { cancelPendingForMember, NotificationQueue } from '../src/notification-queue';
import type { DeliveryRequest, ProviderResult } from '../src/notification-providers';
import { harness, setSubscription } from './notification-fixture';

const code = (expected: string) => (error: unknown) => error instanceof ContentError && error.code === expected;

test('two members get fixed distinct editions and destinations; requests and normal versions do not duplicate', async () => {
  const sent: DeliveryRequest[] = [];
  const h = harness({ provider: { send: async request => { sent.push(request); return { status: 'accepted', providerMessageId: `message-${sent.length}` }; } } });
  try {
    const a = h.enqueue(), b = h.enqueue(h.bob);
    assert.notEqual(a.delivery.editionId, b.delivery.editionId);
    assert.equal(h.enqueue().delivery.intentId, a.delivery.intentId);
    assert.throws(() => h.enqueue(h.alice, 'different_request'), code('delivery_exists'));
    assert.throws(() => h.queue.enqueue(h.bob, { editionId: a.delivery.editionId, channel: 'feishu', requestId: 'foreign_edition', confirmSend: true }), code('not_found'));
    assert.equal((await h.queue.runOnce()).processed, 1);
    h.time.now += 1000; assert.equal((await h.queue.runOnce()).processed, 1);
    assert.equal((await h.queue.runOnce()).processed, 0);
    assert.deepEqual(new Set(sent.map(item => item.target)), new Set(['synthetic-alice', 'synthetic-bob']));
    for (const request of sent) {
      const id = request.target.endsWith('alice') ? a.delivery.editionId : b.delivery.editionId;
      assert.match(request.text, new RegExp(`/app/briefs/${id}$`));
      assert.equal(request.text.includes('Synthetic evidence'), false);
    }
    assert.equal(h.queue.list(h.alice).deliveries.length, 1);
    assert.equal(h.queue.adminList(h.admin).deliveries.length, 2);
    assert.equal(JSON.stringify(h.queue.adminList(h.admin)).includes('synthetic-alice'), false);
    assert.equal(h.content.edition(h.alice, a.delivery.editionId).edition.externalSendAllowed, false);
  } finally { h.store.close(); }
});

test('pause during provider credential wait cancels before dispatch and queued jobs cancel synchronously', async () => {
  let release!: () => void, entered!: () => void, posts = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const h = harness({ provider: { send: async request => { entered(); await gate; if (!request.beforeSend!()) return { status: 'permanent_failed', errorCode: 'cancelled_before_send' }; posts++; return { status: 'accepted' }; } } });
  try {
    const a = h.enqueue(); h.time.now += 1; h.enqueue(h.bob);
    const running = h.queue.runOnce(); await started;
    setSubscription(h.content, h.alice, { frequency: 'paused' });
    h.store.transaction(() => { h.bindings.delete('bob'); cancelPendingForMember(h.store, 'bob', 'binding_unbound', h.time.now, 'feishu'); });
    assert.equal(h.queue.list(h.bob).deliveries[0].status, 'cancelled');
    release(); await running;
    assert.equal(posts, 0); assert.equal(h.queue.list(h.alice).deliveries.find(row => row.intentId === a.delivery.intentId)!.status, 'cancelled');
  } finally { h.store.close(); }
});

test('temporary explicit refusal backs off persistently and caps retries', async () => {
  let sends = 0;
  const h = harness({ provider: { send: async () => { sends++; return { status: 'retryable_failed', errorCode: 'rate_limited', retryAfterMs: 60000 }; } } });
  try {
    h.enqueue(); await h.queue.runOnce();
    assert.equal(h.queue.list(h.alice).deliveries[0].status, 'retryable_failed');
    const restarted = new NotificationQueue(h.store, h.queueOptions);
    await restarted.runOnce(); assert.equal(sends, 1);
    h.time.now += 59999; await restarted.runOnce(); assert.equal(sends, 1);
    h.time.now += 1; await restarted.runOnce(); assert.equal(sends, 2);
    h.time.now += 60000; await restarted.runOnce(); assert.equal(sends, 3);
    const row = restarted.list(h.alice).deliveries[0];
    assert.equal(row.status, 'permanent_failed'); assert.equal(row.errorCode, 'retry_limit_reached');
    h.time.now += 600000; await restarted.runOnce(); assert.equal(sends, 3);
    assert.equal((h.store.db.prepare('SELECT count(*) AS n FROM notification_attempts').get() as any).n, 3);
  } finally { h.store.close(); }
});

test('transport uncertainty never retries; unknown review preserves status and explicit admin duplicate acknowledgment is needed', async () => {
  let sends = 0;
  const h = harness({ provider: { send: async () => { sends++; throw new Error('synthetic lost response'); } } });
  try {
    const initial = h.enqueue(); await h.queue.runOnce();
    h.time.now += 300000; await h.queue.runOnce();
    assert.equal(sends, 1); assert.equal(h.queue.list(h.alice).deliveries[0].status, 'unknown');
    const request = { sourceIntentId: initial.delivery.intentId, requestId: 'admin_resend_1', reason: '已检查平台记录并联系收件人', confirmDuplicate: true };
    assert.throws(() => h.queue.adminResend(h.admin, request), code('delivery_unresolved'));
    await assert.rejects(() => h.queue.reconcile(h.admin, { intentId: initial.delivery.intentId, reason: '检查平台' }), code('provider_query_unavailable'));
    assert.throws(() => h.queue.adminReview(h.alice, { intentId: initial.delivery.intentId, reason: '检查平台', confirmUnknown: true }), code('forbidden'));
    const reviewed = h.queue.adminReview(h.admin, { intentId: initial.delivery.intentId, reason: '平台无可查询结果，已人工核对仍不能确定', confirmUnknown: true });
    assert.equal(reviewed.delivery.status, 'unknown'); assert.ok(reviewed.delivery.unknownReviewedAt);
    assert.throws(() => h.queue.adminResend(h.admin, { ...request, confirmDuplicate: false }));
    const resend = h.queue.adminResend(h.admin, request);
    assert.equal(resend.delivery.sourceIntentId, initial.delivery.intentId);
    assert.equal(resend.delivery.editionId, initial.delivery.editionId);
    assert.equal(h.queue.adminResend(h.admin, request).delivery.intentId, resend.delivery.intentId);
    assert.equal(h.queue.list(h.alice).deliveries.length, 2);
  } finally { h.store.close(); }
});

test('expired sending lease is unknown and competing workers cannot claim an in-flight intent', async () => {
  let release!: (value: ProviderResult) => void, entered!: () => void;
  const gate = new Promise<ProviderResult>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const h = harness({ provider: { send: async () => { entered(); return gate; } } });
  try {
    h.enqueue(); const first = h.queue.runOnce(); await started;
    const second = new NotificationQueue(h.store, h.queueOptions);
    assert.equal((await second.runOnce()).processed, 0);
    h.time.now += 120001; assert.equal(second.recoverStale(), 1);
    assert.equal((await second.runOnce()).processed, 0);
    release({ status: 'accepted', providerMessageId: 'late-result' }); await first;
    assert.equal(second.list(h.alice).deliveries[0].status, 'unknown');
    assert.equal((h.store.db.prepare('SELECT status FROM notification_attempts').get() as any).status, 'unknown');
  } finally { h.store.close(); }
});

test('fresh permission, revocation and binding checks protect a queued immutable intent', async () => {
  for (const mutation of ['disabled', 'viewer', 'acl', 'revoked', 'binding'] as const) {
    let sends = 0; const h = harness({ provider: { send: async () => { sends++; return { status: 'accepted' }; } } });
    try {
      const initial = h.enqueue();
      if (mutation === 'disabled') h.store.db.prepare("UPDATE users SET status='disabled' WHERE id='alice'").run();
      if (mutation === 'viewer') h.store.db.prepare("UPDATE users SET role='viewer' WHERE id='alice'").run();
      if (mutation === 'acl') h.store.db.prepare("UPDATE users SET read_topic_ids='[\"agent\"]' WHERE id='alice'").run();
      if (mutation === 'revoked') h.content.revoke(h.admin, { revisionId: h.edition().items[0].item.revisionId, reason: 'synthetic retraction' });
      if (mutation === 'binding') h.bindings.get('alice')!.revision++;
      await h.queue.runOnce(); assert.equal(sends, 0, mutation);
      assert.equal((h.store.db.prepare('SELECT status FROM notification_intents WHERE id=?').get(initial.delivery.intentId) as any).status, 'cancelled', mutation);
      assert.throws(() => h.store.db.prepare("UPDATE notification_intents SET target='other-person' WHERE id=?").run(initial.delivery.intentId), /immutable/);
    } finally { h.store.close(); }
  }
});

test('platform reconciliation records evidence without claiming read receipts or retrying uncertain lookups', async () => {
  let next: ProviderResult = { status: 'unknown', errorCode: 'query_unavailable' };
  const h = harness({ provider: { send: async () => ({ status: 'accepted', providerMessageId: 'synthetic-id' }), query: async () => next } });
  try {
    const intent = h.enqueue(); await h.queue.runOnce();
    const first = await h.queue.reconcile(h.admin, { intentId: intent.delivery.intentId, reason: '确认平台处理结果' });
    assert.equal(first.delivery.status, 'accepted');
    next = { status: 'provider_confirmed', providerMessageId: 'synthetic-id' };
    const second = await h.queue.reconcile(h.admin, { intentId: intent.delivery.intentId, reason: '再次确认平台处理结果' });
    assert.equal(second.delivery.status, 'provider_confirmed');
    assert.equal('readAt' in second.delivery, false);
  } finally { h.store.close(); }
});

test('query availability follows the channel and admin cannot resend an ancestor to bypass an unresolved descendant', async () => {
  let sends = 0, queries = 0;
  const h = harness({ provider: { send: async () => ++sends === 1 ? { status: 'accepted', providerMessageId: 'synthetic-id' } : { status: 'unknown' },
    canQuery: channel => channel === 'wechat', query: async () => { queries++; return { status: 'provider_confirmed' }; } } });
  try {
    const original = h.enqueue(); await h.queue.runOnce();
    assert.equal(h.queue.list(h.alice).deliveries[0].canReconcile, false);
    await assert.rejects(() => h.queue.reconcile(h.admin, { intentId: original.delivery.intentId, reason: '不支持此平台查询' }), code('provider_query_unavailable'));
    assert.equal(queries, 0);
    const request = { sourceIntentId: original.delivery.intentId, requestId: 'resend_child_1', reason: '测试明确重复确认', confirmDuplicate: true };
    const child = h.queue.adminResend(h.admin, request);
    assert.equal(h.queue.adminResend(h.admin, request).delivery.intentId, child.delivery.intentId);
    assert.throws(() => h.queue.adminResend(h.admin, { ...request, requestId: 'resend_child_2' }), code('delivery_unresolved'));
    h.time.now += 1000; await h.queue.runOnce();
    assert.equal(h.queue.list(h.alice).deliveries.find(row => row.intentId === child.delivery.intentId)!.status, 'unknown');
    assert.throws(() => h.queue.adminResend(h.admin, { ...request, requestId: 'resend_child_2' }), code('delivery_unresolved'));
    assert.equal(h.queue.adminResend(h.admin, request).delivery.intentId, child.delivery.intentId);
    h.queue.adminReview(h.admin, { intentId: child.delivery.intentId, reason: '已经核对第二次投递仍无法确定结果', confirmUnknown: true });
    assert.equal(h.queue.adminResend(h.admin, { ...request, requestId: 'resend_child_2' }).delivery.status, 'queued');
  } finally { h.store.close(); }
});

test('default disabled worker rejects enqueue, and paused subscriptions do not revive old delivery', async () => {
  const h = harness({ enabledChannels: [] });
  try { assert.throws(() => h.enqueue(), code('delivery_disabled')); }
  finally { h.store.close(); }
  const active = harness();
  try {
    active.enqueue(); setSubscription(active.content, active.alice, { frequency: 'paused' });
    assert.equal(active.queue.list(active.alice).deliveries[0].status, 'cancelled');
    setSubscription(active.content, active.alice, { frequency: 'daily' });
    assert.equal(active.queue.list(active.alice).deliveries[0].status, 'cancelled');
  } finally { active.store.close(); }
});

test('disk database reopen preserves queued work, accepted receipts, and the channel cooldown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-queue-')), databasePath = join(directory, 'test.sqlite');
  let sends = 0, reopened: Store | undefined, originalClosed = false;
  const h = harness({ databasePath, provider: { send: async () => { sends++; return { status: 'accepted', providerMessageId: `synthetic-${sends}` }; } } });
  try {
    h.enqueue(); h.enqueue(h.bob); await h.queue.runOnce();
    assert.equal(sends, 1); h.store.close(); originalClosed = true;
    reopened = new Store(databasePath);
    const content = new ContentService(reopened, { now: () => new Date(h.time.now), verifyExport: value => value as VerifiedExport });
    const queue = new NotificationQueue(reopened, { ...h.queueOptions, content });
    assert.equal((await queue.runOnce()).processed, 0); assert.equal(sends, 1);
    h.time.now += 1000; assert.equal((await queue.runOnce()).processed, 1); assert.equal(sends, 2);
    assert.equal((await queue.runOnce()).processed, 0);
    assert.equal(queue.adminList(h.admin).deliveries.filter(row => row.status === 'accepted').length, 2);
  } finally {
    reopened?.close(); if (!originalClosed) h.store.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(databasePath + suffix)) unlinkSync(databasePath + suffix);
    rmdirSync(directory);
  }
});
