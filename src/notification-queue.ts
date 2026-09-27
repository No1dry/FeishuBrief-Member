import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './db';
import type { AuthContext } from './auth';
import { writeAudit } from './auth';
import { ContentError, type ContentService } from './content';
import { personalHash } from './engine/personal-contract';
import type { ExternalChannel, NotificationProvider, ProviderResult, DeliveryRequest } from './notification-providers';

type Row = Record<string, any>;
export type DeliveryStatus = 'queued' | 'sending' | 'accepted' | 'provider_confirmed' | 'retryable_failed' | 'permanent_failed' | 'unknown' | 'cancelled';
export interface ResolvedBinding { bindingId: string; revision: number; target: string }
export interface BindingResolver { resolve(memberId: string, channel: ExternalChannel): ResolvedBinding | null }
const Channel = z.enum(['feishu', 'wechat']);
const EditionId = z.string().regex(/^[a-f0-9]{64}$/);
const RequestId = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const Reason = z.string().trim().min(3).max(300);
const EnqueueRequest = z.object({ editionId: EditionId, channel: Channel, requestId: RequestId, confirmSend: z.literal(true) }).strict();
const ResendRequest = z.object({ sourceIntentId: z.string().uuid(), requestId: RequestId, reason: Reason, confirmDuplicate: z.literal(true) }).strict();
const ReconcileRequest = z.object({ intentId: z.string().uuid(), reason: Reason }).strict();
const ReviewRequest = z.object({ intentId: z.string().uuid(), reason: Reason, confirmUnknown: z.literal(true) }).strict();
function fail(status: number, code: string, message: string): never { throw new ContentError(status, code, message); }
const iso = (time: number | null): string | null => time === null ? null : new Date(time).toISOString();

/** Synchronous: callers may include this in their account/binding/subscription transaction. */
export function cancelPendingForMember(store: Store, memberId: string, reason: string, now = Date.now(), channel?: ExternalChannel): number {
  const filter = channel ? ' AND channel=?' : '', args: (string | number)[] = [reason, now, memberId, ...(channel ? [channel] : [])];
  const result = store.db.prepare(`UPDATE notification_intents SET status='cancelled',error_code=?,next_attempt_at=NULL,updated_at=? WHERE member_id=? AND status IN ('queued','retryable_failed')${filter}`).run(...args);
  // Already dispatched calls cannot be recalled. The provider's beforeSend guard handles
  // work still waiting for credentials; completed network calls keep their honest result.
  store.db.prepare(`UPDATE notification_intents SET cancel_requested=1,updated_at=? WHERE member_id=? AND status='sending'${filter}`).run(now, memberId, ...(channel ? [channel] : []));
  const scheduleFilter = channel ? " AND EXISTS (SELECT 1 FROM content_preferences p JOIN content_subscriptions s ON s.revision_id=p.revision WHERE p.member_id=notification_schedule_runs.member_id AND json_extract(s.subscription_json,'$.channel')=?)" : '';
  store.db.prepare(`UPDATE notification_schedule_runs SET status='cancelled',error_code=?,updated_at=? WHERE member_id=? AND status='waiting'${scheduleFilter}`)
    .run(reason, now, memberId, ...(channel ? [channel] : []));
  return Number(result.changes);
}

/** Browser-only authorization, independently refreshed for notification endpoints. */
export function requireNotificationActor(store: Store, actor: AuthContext, now: number, owner = false, writable = true): void {
  const user = store.db.prepare('SELECT * FROM users WHERE id=?').get(actor.user.userId) as Row | undefined;
  const session = store.db.prepare('SELECT * FROM sessions WHERE id=? AND user_id=?').get(actor.sessionId, actor.user.userId) as Row | undefined;
  if (!user || user.status !== 'active' || !session || session.revoked_at || session.expires_at <= now || session.last_seen_at + 12 * 3600000 <= now)
    fail(401, 'session_expired', '会话已失效，请重新登录');
  if (owner && user.role !== 'lab_owner') fail(403, 'forbidden', '仅管理员可操作投递队列');
  if (!owner && writable && user.role === 'viewer') fail(403, 'read_only', '只读成员不能设置个人通知');
}

export class NotificationQueue {
  private readonly clock: () => number;
  private running = false;
  private readonly enabledChannels: ExternalChannel[];
  constructor(private readonly store: Store, private readonly options: {
    content: ContentService; bindings: BindingResolver; provider: NotificationProvider; origin: string;
    clock?: () => number; enabledChannels?: ExternalChannel[]; minIntervalMs?: number; maxAttempts?: number; leaseMs?: number;
  }) {
    this.clock = options.clock ?? Date.now;
    this.enabledChannels = options.enabledChannels ?? [];
  }
  private read(id: string): Row | undefined { return this.store.db.prepare('SELECT * FROM notification_intents WHERE id=?').get(id) as Row | undefined; }
  private view(row: Row) {
    return { intentId: row.id as string, editionId: row.edition_id as string, memberId: row.member_id as string,
      reportDate: row.report_date as string, channel: row.channel as ExternalChannel, status: row.status as DeliveryStatus,
      attempts: Number(row.attempts), nextAttemptAt: iso(row.next_attempt_at), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
      providerMessageId: row.provider_message_id as string | null, errorCode: row.error_code as string | null,
      sourceIntentId: row.source_intent_id as string | null, reason: row.reason as string | null,
      unknownReviewedAt: iso(row.unknown_reviewed_at),
      canReconcile: ['unknown', 'accepted'].includes(row.status) && !!row.provider_message_id && !!this.options.provider.query && (this.options.provider.canQuery?.(row.channel) ?? true) };
  }
  list(actor: AuthContext) {
    requireNotificationActor(this.store, actor, this.clock(), false, false);
    return { deliveries: (this.store.db.prepare('SELECT * FROM notification_intents WHERE member_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(actor.user.userId) as Row[]).map(row => this.view(row)) };
  }
  adminList(actor: AuthContext) {
    requireNotificationActor(this.store, actor, this.clock(), true);
    return { deliveries: (this.store.db.prepare('SELECT * FROM notification_intents ORDER BY created_at DESC,id DESC LIMIT 200').all() as Row[]).map(row => this.view(row)) };
  }
  summary(actor: AuthContext) {
    const { deliveries } = this.adminList(actor);
    return { enabled: this.enabledChannels.length > 0, phase: 6, records: deliveries,
      counts: Object.fromEntries((this.store.db.prepare('SELECT status,count(*) AS n FROM notification_intents GROUP BY status').all() as Row[]).map(row => [row.status, Number(row.n)])) };
  }
  private enabled(channel: ExternalChannel) {
    if (!this.enabledChannels.includes(channel)) fail(503, 'delivery_disabled', '该个人通知通道尚未启用');
  }
  private current(memberId: string, editionId: string, channel: ExternalChannel) {
    this.enabled(channel);
    const subscription = this.options.content.workerSubscription(memberId);
    if (subscription.frequency === 'paused') fail(409, 'subscription_paused', '个人简报已暂停');
    if (subscription.channel !== channel) fail(409, 'channel_changed', '请先在个人订阅中选择此接收通道');
    const binding = this.options.bindings.resolve(memberId, channel);
    if (!binding) fail(409, 'binding_required', '请先验证并绑定个人接收账号');
    const { edition, finalized } = this.options.content.workerEdition(memberId, editionId);
    if (!finalized || edition.status !== 'ready' || !edition.items.length) fail(409, 'edition_not_ready', '只有包含合格内容的固定版本可以发送');
    return { subscription, binding, edition };
  }
  private fixed(row: Row) {
    const state = this.current(row.member_id, row.edition_id, row.channel);
    if (state.subscription.revisionId !== row.subscription_revision) fail(409, 'subscription_changed', '订阅已改变');
    if (state.binding.bindingId !== row.binding_id || state.binding.revision !== row.binding_revision || state.binding.target !== row.target)
      fail(409, 'binding_changed', '个人通知绑定已改变');
    if (state.edition.contentHash !== row.edition_hash || personalHash(JSON.parse(row.payload_json)) !== row.payload_hash)
      fail(503, 'delivery_integrity', '投递固定版本校验失败');
    return state;
  }
  private insert(memberId: string, request: { editionId: string; channel: ExternalChannel; requestId: string },
    mode: 'manual' | 'daily' | 'resend', source?: Row, reason: string | null = null) {
    const previous = this.store.db.prepare('SELECT * FROM notification_intents WHERE member_id=? AND request_id=?').get(memberId, request.requestId) as Row | undefined;
    if (previous) {
      if (previous.edition_id !== request.editionId || previous.channel !== request.channel || previous.mode !== mode || previous.source_intent_id !== (source?.id ?? null))
        fail(409, 'request_conflict', '此请求标识已用于另一投递');
      return { delivery: this.view(previous), idempotent: true };
    }
    const state = this.current(memberId, request.editionId, request.channel), now = this.clock();
    if (source && (state.binding.bindingId !== source.binding_id || state.binding.revision !== source.binding_revision || state.binding.target !== source.target))
      fail(409, 'binding_changed', '原接收绑定已失效，不能把补发改投其他目标');
    if (mode === 'manual') {
      const duplicate = this.store.db.prepare("SELECT * FROM notification_intents WHERE member_id=? AND edition_id=? AND channel=? AND binding_id=? AND binding_revision=? AND status NOT IN ('cancelled','permanent_failed') ORDER BY created_at DESC LIMIT 1")
        .get(memberId, request.editionId, request.channel, state.binding.bindingId, state.binding.revision) as Row | undefined;
      if (duplicate) fail(409, 'delivery_exists', '此固定版本已有投递记录；请查看记录，需要重复发送时由管理员确认补发');
    }
    if (mode === 'daily') {
      const daily = this.store.db.prepare("SELECT * FROM notification_intents WHERE member_id=? AND report_date=? AND mode='daily'").get(memberId, state.edition.reportDate) as Row | undefined;
      if (daily) return { delivery: this.view(daily), idempotent: true };
      // A member may have manually sent the edition while the scheduler was
      // waiting for a binding. Attach that receipt instead of sending twice.
      // Even a failed/cancelled receipt requires an explicit later resend.
      const existing = this.store.db.prepare('SELECT * FROM notification_intents WHERE member_id=? AND edition_id=? AND channel=? AND binding_id=? AND binding_revision=? ORDER BY created_at DESC,id DESC LIMIT 1')
        .get(memberId, request.editionId, request.channel, state.binding.bindingId, state.binding.revision) as Row | undefined;
      if (existing) return { delivery: this.view(existing), idempotent: true };
    }
    const intentId = randomUUID();
    // Only a private, authenticated version link leaves the service. No credentials,
    // raw recipient IDs, preferences, or private article body enter public artifacts.
    const payload = { title: `个人研究简报 · ${state.edition.reportDate}`,
      text: `您的 ${state.edition.reportDate} 个人简报已生成，共 ${state.edition.items.length} 条。\n登录 Console 查看此固定版本：\n${this.options.origin}/app/briefs/${state.edition.editionId}` };
    this.store.db.prepare(`INSERT INTO notification_intents(id,member_id,edition_id,report_date,channel,binding_id,binding_revision,target,subscription_revision,
      edition_hash,payload_json,payload_hash,request_id,mode,source_intent_id,reason,status,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`)
      .run(intentId, memberId, state.edition.editionId, state.edition.reportDate, request.channel, state.binding.bindingId, state.binding.revision,
        state.binding.target, state.subscription.revisionId, state.edition.contentHash, JSON.stringify(payload), personalHash(payload), request.requestId, mode,
        source?.id ?? null, reason, now, now, now);
    writeAudit(this.store, memberId, 'notification.enqueue', intentId, { editionId: state.edition.editionId, channel: request.channel, mode }, now);
    return { delivery: this.view(this.read(intentId)!), idempotent: false };
  }
  enqueue(actor: AuthContext, input: unknown) {
    requireNotificationActor(this.store, actor, this.clock());
    const request = EnqueueRequest.parse(input);
    return this.store.transaction(() => this.insert(actor.user.userId, request, 'manual'));
  }
  /** Process-only, no browser session is manufactured for a scheduled member. */
  enqueueDaily(memberId: string, editionId: string, channel: ExternalChannel, reportDate: string) {
    return this.store.transaction(() => this.insert(memberId, { editionId, channel, requestId: `daily_${reportDate.replaceAll('-', '')}` }, 'daily'));
  }
  adminResend(actor: AuthContext, input: unknown) {
    requireNotificationActor(this.store, actor, this.clock(), true);
    const request = ResendRequest.parse(input);
    return this.store.transaction(() => {
      const source = this.read(request.sourceIntentId);
      if (!source) fail(404, 'not_found', '投递记录不存在');
      const previous = this.store.db.prepare('SELECT id FROM notification_intents WHERE member_id=? AND request_id=?').get(source.member_id, request.requestId);
      if (previous) return this.insert(source.member_id, { editionId: source.edition_id, channel: source.channel, requestId: request.requestId }, 'resend', source, request.reason);
      if (['sending', 'queued', 'retryable_failed'].includes(source.status) || (source.status === 'unknown' && !source.unknown_reviewed_at))
        fail(409, 'delivery_unresolved', '先核对尚未结束或结果未知的投递，不能盲目补发');
      const outstanding = this.store.db.prepare("SELECT id FROM notification_intents WHERE member_id=? AND edition_id=? AND channel=? AND binding_id=? AND binding_revision=? AND (status IN ('queued','sending','retryable_failed') OR (status='unknown' AND unknown_reviewed_at IS NULL)) LIMIT 1")
        .get(source.member_id, source.edition_id, source.channel, source.binding_id, source.binding_revision);
      if (outstanding) fail(409, 'delivery_unresolved', '此版本还有未结束或未经核对的投递，请先处理该记录');
      const result = this.insert(source.member_id, { editionId: source.edition_id, channel: source.channel, requestId: request.requestId }, 'resend', source, request.reason);
      if (!result.idempotent) writeAudit(this.store, actor.user.userId, 'notification.admin_resend', result.delivery.intentId,
        { sourceIntentId: source.id, reason: request.reason, duplicateRiskAcknowledged: true }, this.clock());
      return result;
    });
  }
  adminReview(actor: AuthContext, input: unknown) {
    requireNotificationActor(this.store, actor, this.clock(), true);
    const request = ReviewRequest.parse(input);
    return this.store.transaction(() => {
      const row = this.read(request.intentId);
      if (!row) fail(404, 'not_found', '投递记录不存在');
      if (row.status !== 'unknown') fail(409, 'review_not_required', '只有结果未知的投递需要人工核对');
      const now = this.clock();
      this.store.db.prepare('UPDATE notification_intents SET unknown_reviewed_at=?,unknown_reviewed_by=?,unknown_review_reason=?,updated_at=? WHERE id=?')
        .run(now, actor.user.userId, request.reason, now, row.id);
      writeAudit(this.store, actor.user.userId, 'notification.unknown_review', row.id, { reason: request.reason, statusRemainsUnknown: true }, now);
      return { delivery: this.view(this.read(row.id)!) };
    });
  }
  async reconcile(actor: AuthContext, input: unknown) {
    requireNotificationActor(this.store, actor, this.clock(), true);
    const request = ReconcileRequest.parse(input), row = this.read(request.intentId);
    if (!row) fail(404, 'not_found', '投递记录不存在');
    if (!['unknown', 'accepted'].includes(row.status)) fail(409, 'reconcile_not_required', '此投递状态无需平台核对');
    if (!row.provider_message_id || !this.options.provider.query || !(this.options.provider.canQuery?.(row.channel) ?? true)) fail(409, 'provider_query_unavailable', '没有可查询的平台消息标识；保持未知状态，请在平台人工核实');
    let result: ProviderResult;
    try { result = await this.options.provider.query(row.channel, row.provider_message_id); }
    catch { result = { status: 'unknown', errorCode: 'query_unavailable' }; }
    requireNotificationActor(this.store, actor, this.clock(), true);
    return this.store.transaction(() => {
      const current = this.read(row.id)!;
      if (current.status !== row.status) fail(409, 'delivery_changed', '投递状态已变化，请刷新');
      // A failed/ambiguous query cannot downgrade already proven acceptance.
      let next: DeliveryStatus = result.status;
      if (row.status === 'accepted' && !['provider_confirmed', 'permanent_failed'].includes(next)) next = 'accepted';
      if (next === 'retryable_failed') next = 'permanent_failed'; // explicit resending requires a new acknowledged intent
      this.store.db.prepare('UPDATE notification_intents SET status=?,provider_message_id=coalesce(?,provider_message_id),error_code=?,next_attempt_at=NULL,updated_at=? WHERE id=?')
        .run(next, result.providerMessageId ?? null, this.safeCode(result.errorCode), this.clock(), row.id);
      writeAudit(this.store, actor.user.userId, 'notification.reconcile', row.id, { reason: request.reason, previousStatus: row.status, status: next }, this.clock());
      return { delivery: this.view(this.read(row.id)!) };
    });
  }
  private safeCode(code?: string): string | null { return code && /^[A-Za-z0-9_.:-]{1,100}$/.test(code) ? code : code ? 'provider_error' : null; }
  /** Expired in-flight leases are unknown, never automatically returned to the queue. */
  recoverStale() {
    return this.store.transaction(() => {
      const now = this.clock();
      const rows = this.store.db.prepare("SELECT id,attempts FROM notification_intents WHERE status='sending' AND lease_until<=?").all(now) as Row[];
      for (const row of rows) {
        this.store.db.prepare("UPDATE notification_intents SET status='unknown',error_code='worker_interrupted',lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?").run(now, row.id);
        this.store.db.prepare("UPDATE notification_attempts SET status='unknown',error_code='worker_interrupted',finished_at=? WHERE intent_id=? AND attempt_number=? AND finished_at IS NULL").run(now, row.id, row.attempts);
      }
      return rows.length;
    });
  }
  private claim(): Row | null {
    return this.store.transaction(() => {
      const now = this.clock();
      const rows = this.store.db.prepare("SELECT * FROM notification_intents WHERE status IN ('queued','retryable_failed') AND next_attempt_at<=? ORDER BY next_attempt_at,created_at,id LIMIT 100").all(now) as Row[];
      for (const row of rows) {
        if (!this.enabledChannels.includes(row.channel)) continue;
        try { this.fixed(row); }
        catch (error) {
          this.store.db.prepare("UPDATE notification_intents SET status='cancelled',error_code=?,next_attempt_at=NULL,updated_at=? WHERE id=?")
            .run(error instanceof ContentError ? error.code : 'validation_failed', now, row.id);
          continue;
        }
        const slot = this.store.db.prepare('SELECT next_send_at FROM notification_channel_slots WHERE channel=?').get(row.channel) as Row | undefined;
        if (slot && slot.next_send_at > now) continue;
        this.store.db.prepare('INSERT INTO notification_channel_slots VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET next_send_at=excluded.next_send_at')
          .run(row.channel, now + Math.max(1000, this.options.minIntervalMs ?? 10000));
        const changed = this.store.db.prepare("UPDATE notification_intents SET status='sending',attempts=attempts+1,lease_until=?,next_attempt_at=NULL,updated_at=? WHERE id=? AND status IN ('queued','retryable_failed')")
          .run(now + Math.max(30000, this.options.leaseMs ?? 120000), now, row.id);
        if (!changed.changes) continue;
        this.store.db.prepare("INSERT INTO notification_attempts(id,intent_id,attempt_number,started_at,status) VALUES(?,?,?,?,'sending')")
          .run(randomUUID(), row.id, row.attempts + 1, now);
        return this.read(row.id)!;
      }
      return null;
    });
  }
  private beforeSend(id: string): boolean {
    const row = this.read(id);
    if (!row || row.status !== 'sending' || row.cancel_requested) return false;
    try { this.fixed(row); return true; } catch { return false; }
  }
  private finish(row: Row, result: ProviderResult) {
    this.store.transaction(() => {
      const current = this.read(row.id)!;
      if (current.status !== 'sending' || current.attempts !== row.attempts) return; // stale worker cannot overwrite a recovered result
      const now = this.clock(), maxAttempts = Math.max(1, this.options.maxAttempts ?? 3);
      let status: DeliveryStatus = result.status, errorCode = this.safeCode(result.errorCode), retryAt: number | null = null;
      if (status === 'permanent_failed' && errorCode === 'cancelled_before_send') status = 'cancelled';
      if (status === 'retryable_failed') {
        if (current.cancel_requested || !this.beforeSend(row.id)) { status = 'cancelled'; errorCode = 'cancelled_before_retry'; }
        else if (row.attempts >= maxAttempts) { status = 'permanent_failed'; errorCode = 'retry_limit_reached'; }
        else retryAt = now + Math.max(30000 * 2 ** (row.attempts - 1), Math.min(86400000, Math.max(0, result.retryAfterMs ?? 0)));
      }
      if (retryAt !== null) this.store.db.prepare('UPDATE notification_channel_slots SET next_send_at=max(next_send_at,?) WHERE channel=?').run(retryAt, row.channel);
      this.store.db.prepare('UPDATE notification_intents SET status=?,next_attempt_at=?,lease_until=NULL,provider_message_id=?,error_code=?,updated_at=? WHERE id=?')
        .run(status, retryAt, result.providerMessageId ?? null, errorCode, now, row.id);
      this.store.db.prepare('UPDATE notification_attempts SET status=?,finished_at=?,provider_message_id=?,error_code=? WHERE intent_id=? AND attempt_number=?')
        .run(status, now, result.providerMessageId ?? null, errorCode, row.id, row.attempts);
      writeAudit(this.store, null, 'notification.result', row.id, { status, attempt: row.attempts }, now);
    });
  }
  async runOnce(options: { limit?: number } = {}) {
    if (this.running) return { processed: 0, busy: true };
    this.running = true;
    let processed = 0;
    try {
      this.recoverStale();
      const limit = Math.min(20, Math.max(1, options.limit ?? 5));
      for (let index = 0; index < limit; index++) {
        const row = this.claim(); if (!row) break;
        const payload = JSON.parse(row.payload_json) as { title: string; text: string };
        let result: ProviderResult;
        try {
          if (!this.beforeSend(row.id)) result = { status: 'permanent_failed', errorCode: 'cancelled_before_send' };
          else {
            const request: DeliveryRequest = { channel: row.channel, target: row.target, title: payload.title, text: payload.text,
              idempotencyKey: row.id, beforeSend: () => this.beforeSend(row.id) };
            result = await this.options.provider.send(request);
          }
        } catch { result = { status: 'unknown', errorCode: 'transport_result_unknown' }; }
        this.finish(row, result); processed++;
      }
      return { processed, busy: false };
    } finally { this.running = false; }
  }
  tick(options: { limit?: number } = {}) { return this.runOnce(options); }
}
