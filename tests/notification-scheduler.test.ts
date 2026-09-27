import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentError } from '../src/content';
import { NotificationScheduler } from '../src/notification-scheduler';
import { cancelPendingForMember } from '../src/notification-queue';
import { contentFixture, harness, setSubscription } from './notification-fixture';

const count = (store: ReturnType<typeof harness>['store'], table: string) => Number((store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n);

test('scheduler is opt-in globally and per-member; saving preferences or preview never creates jobs', () => {
  const h = harness({ schedulerEnabled: false });
  try {
    h.content.preview(h.alice);
    assert.equal(h.scheduler.get(h.alice).enabled, false);
    assert.equal(h.scheduler.get(h.alice).systemEnabled, false);
    h.schedule(); assert.equal(h.scheduler.tick().assembled, 0);
    assert.equal(count(h.store, 'content_editions'), 0); assert.equal(count(h.store, 'notification_intents'), 0);
    const enabled = new NotificationScheduler(h.store, { content: h.content, queue: h.queue, clock: () => h.time.now, enabled: true });
    assert.equal(enabled.tick().queued, 1); // only Alice explicitly opted in
    assert.equal(h.queue.list(h.bob).deliveries.length, 0);
  } finally { h.store.close(); }
});

test('today scheduler assembles separate editions once without member sessions or sending inside a tick', () => {
  let sends = 0;
  const h = harness({ provider: { send: async () => { sends++; return { status: 'accepted' }; } } });
  try {
    h.schedule(h.alice); h.schedule(h.bob);
    h.store.db.prepare('UPDATE sessions SET revoked_at=?').run(h.time.now);
    const first = h.scheduler.tick();
    assert.equal(first.assembled, 2); assert.equal(first.queued, 2); assert.equal(sends, 0);
    const again = h.scheduler.tick(); assert.equal(again.assembled, 0); assert.equal(again.queued, 0);
    assert.equal(count(h.store, 'content_editions'), 2); assert.equal(count(h.store, 'notification_intents'), 2);
    const stored = h.store.db.prepare('SELECT member_id,edition_json FROM content_editions').all() as any[];
    for (const row of stored) {
      const edition = JSON.parse(row.edition_json);
      assert.equal(edition.items.length, 1);
      assert.equal(edition.items[0].assignedTopicId, row.member_id === 'alice' ? 'vla' : 'agent');
    }
    assert.equal((h.store.db.prepare('SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL').get() as any).n, 0);
  } finally { h.store.close(); }
});

test('in-app schedule produces a private edition, no delivery intent, and respects Shanghai local time', () => {
  const h = harness({ enabledChannels: [] });
  try {
    setSubscription(h.content, h.alice, { channel: 'in-app' }); h.schedule(h.alice, { localTime: '10:00' });
    assert.equal(h.scheduler.tick().assembled, 0);
    h.time.now += 59 * 60000;
    const run = h.scheduler.tick(); assert.equal(run.assembled, 1); assert.equal(run.queued, 0);
    assert.equal(count(h.store, 'notification_intents'), 0); assert.equal(count(h.store, 'content_editions'), 1);
    assert.equal((h.store.db.prepare('SELECT status FROM notification_schedule_runs').get() as any).status, 'complete');
  } finally { h.store.close(); }
});

test('stale content waits; empty selection writes no history and can pick up a later qualified import', () => {
  const h = harness();
  try {
    setSubscription(h.content, h.alice, { excludeKeywords: ['synthetic'] }); h.schedule();
    assert.equal(h.scheduler.tick().waiting, 1);
    assert.equal(count(h.store, 'content_editions'), 0); assert.equal(count(h.store, 'notification_intents'), 0);
    // A new day must not substitute yesterday's import, even with the first-edition lookback window.
    h.time.now += 86400000;
    h.store.db.prepare('UPDATE sessions SET last_seen_at=?').run(h.time.now);
    setSubscription(h.content, h.alice, { excludeKeywords: [], firstEditionLookbackDays: 7 });
    const stale = h.scheduler.tick(); assert.equal(stale.assembled, 0); assert.equal(stale.waiting, 1);
    assert.equal((h.store.db.prepare("SELECT error_code FROM notification_schedule_runs WHERE report_date='2026-09-29'").get() as any).error_code, 'fresh_content_required');
    h.content.importExport(contentFixture('2026-09-29'));
    const ready = h.scheduler.tick(); assert.equal(ready.assembled, 1); assert.equal(ready.queued, 1);
    const intent = h.queue.list(h.alice).deliveries[0]; assert.equal(intent.reportDate, '2026-09-29');
  } finally { h.store.close(); }
});

test('durable assembly request recovers a crash between history commit and intent creation', () => {
  const h = harness();
  try {
    h.schedule();
    const committed = h.content.workerAssemble('alice', 'scheduled_20260928', '2026-09-28');
    assert.equal(committed.finalized, true); assert.equal(count(h.store, 'content_editions'), 1);
    const profile = h.content.catalog(h.admin).profiles.find(item => item.topic.id === 'vla')!;
    h.content.putTopic(h.admin, 'vla', { baseRevision: profile.revisionId, profile: { ...profile.topic, name: 'VLA revised name' } });
    // The new catalog now needs reprocessing, while the already fixed edition is
    // still permitted. Recovery must not require fresh assembly inputs again.
    assert.throws(() => h.content.preview(h.alice), (error: unknown) => error instanceof ContentError && error.code === 'content_unavailable');
    // Simulate process exit immediately after ContentService committed. No run edition pointer yet.
    const restarted = new NotificationScheduler(h.store, { content: h.content, queue: h.queue, clock: () => h.time.now, enabled: true });
    const recovered = restarted.tick(); assert.equal(recovered.assembled, 0); assert.equal(recovered.queued, 1);
    assert.equal(h.queue.list(h.alice).deliveries[0].editionId, committed.edition.editionId);
    assert.equal(count(h.store, 'content_editions'), 1);
    assert.equal(restarted.tick().queued, 0);
  } finally { h.store.close(); }
});

test('scheduler reuses a manual delivery made while its committed edition waited for a binding', async () => {
  for (const status of ['accepted', 'unknown', 'permanent_failed'] as const) {
    let sends = 0;
    const h = harness({ provider: { send: async () => { sends++; return { status }; } } });
    try {
      const binding = h.bindings.get('alice')!; h.bindings.delete('alice'); h.schedule();
      assert.equal(h.scheduler.tick().waiting, 1);
      const run = h.store.db.prepare("SELECT * FROM notification_schedule_runs WHERE member_id='alice'").get() as any;
      assert.ok(run.edition_id); assert.equal(run.error_code, 'binding_required');
      h.bindings.set('alice', binding);
      const manual = h.queue.enqueue(h.alice, { editionId: run.edition_id, channel: 'feishu', requestId: 'manual_while_waiting', confirmSend: true });
      await h.queue.runOnce(); assert.equal(sends, 1);
      assert.equal(h.scheduler.tick().queued, 0);
      const completed = h.store.db.prepare("SELECT * FROM notification_schedule_runs WHERE member_id='alice'").get() as any;
      assert.equal(completed.status, 'complete'); assert.equal(completed.intent_id, manual.delivery.intentId);
      assert.equal(count(h.store, 'notification_intents'), 1);
      h.time.now += 1000; await h.queue.runOnce(); assert.equal(sends, 1);
    } finally { h.store.close(); }
  }
});

test('unbinding an unused channel preserves the waiting schedule for the selected channel', () => {
  const h = harness();
  try {
    const binding = h.bindings.get('alice')!; h.bindings.delete('alice'); h.schedule(); h.scheduler.tick();
    cancelPendingForMember(h.store, 'alice', 'binding_unbound', h.time.now, 'wechat');
    assert.equal((h.store.db.prepare("SELECT status FROM notification_schedule_runs WHERE member_id='alice'").get() as any).status, 'waiting');
    h.bindings.set('alice', binding);
    assert.equal(h.scheduler.tick().queued, 1);
    assert.equal(h.queue.list(h.alice).deliveries[0].status, 'queued');
    cancelPendingForMember(h.store, 'alice', 'binding_unbound', h.time.now, 'feishu');
    assert.equal(h.queue.list(h.alice).deliveries[0].status, 'cancelled');
  } finally { h.store.close(); }
});

test('schedule CAS, weekdays, pause, and account changes cannot revive cancelled work', () => {
  const h = harness();
  try {
    const schedule = h.schedule();
    assert.throws(() => h.scheduler.put(h.alice, { baseRevision: 'initial', enabled: true, localTime: '09:00', timeZone: 'Asia/Shanghai' }),
      (error: unknown) => error instanceof ContentError && error.code === 'revision_conflict');
    assert.throws(() => h.scheduler.put(h.alice, { baseRevision: schedule.revision, enabled: true, localTime: '25:01', timeZone: 'Asia/Shanghai' }));
    h.scheduler.tick(); assert.equal(count(h.store, 'notification_intents'), 1);
    h.schedule(h.alice, { enabled: false });
    assert.equal(h.queue.list(h.alice).deliveries[0].status, 'cancelled');
    h.schedule(); assert.equal(h.scheduler.tick().queued, 0);
    setSubscription(h.content, h.bob, { frequency: 'weekdays' }); h.schedule(h.bob);
    h.time.now += 5 * 86400000; // Saturday
    assert.equal(h.scheduler.tick().queued, 0);
    h.store.db.prepare("UPDATE users SET status='disabled' WHERE id='alice'").run();
    assert.equal(h.scheduler.tick().assembled, 0);
  } finally { h.store.close(); }
});
