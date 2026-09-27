import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './db';
import type { AuthContext } from './auth';
import { writeAudit } from './auth';
import { ContentError, type ContentService } from './content';
import { cancelPendingForMember, requireNotificationActor, type NotificationQueue } from './notification-queue';

type Row = Record<string, any>;
const ScheduleWrite = z.object({ baseRevision: z.string().min(1).max(100), enabled: z.boolean(),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timeZone: z.literal('Asia/Shanghai') }).strict();
const fail = (status: number, code: string, message: string): never => { throw new ContentError(status, code, message); };
function localClock(now: number) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(now));
  const p = (type: string) => parts.find(part => part.type === type)!.value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, time: `${p('hour')}:${p('minute')}`, weekend: ['Sat', 'Sun'].includes(p('weekday')) };
}

/** Small, synchronous local scheduler: no LLM, no network, no fabricated sessions. */
export class NotificationScheduler {
  private readonly clock: () => number;
  private running = false;
  constructor(private readonly store: Store, private readonly options: {
    content: ContentService; queue: NotificationQueue; enabled: boolean; clock?: () => number;
  }) { this.clock = options.clock ?? Date.now; }
  private read(memberId: string) { return this.store.db.prepare('SELECT * FROM notification_schedules WHERE member_id=?').get(memberId) as Row | undefined; }
  private view(row?: Row) {
    return { revision: row?.revision as string ?? 'initial', enabled: !!row?.enabled, localTime: row?.local_time as string ?? '09:00',
      timeZone: 'Asia/Shanghai' as const, systemEnabled: this.options.enabled };
  }
  get(actor: AuthContext) { requireNotificationActor(this.store, actor, this.clock(), false, false); return this.view(this.read(actor.user.userId)); }
  put(actor: AuthContext, input: unknown) {
    requireNotificationActor(this.store, actor, this.clock());
    const request = ScheduleWrite.parse(input), memberId = actor.user.userId;
    return this.store.transaction(() => {
      const current = this.read(memberId);
      if ((current?.revision ?? 'initial') !== request.baseRevision) fail(409, 'revision_conflict', '定时设置已被修改，请刷新后重试');
      if (request.enabled) {
        const subscription = this.options.content.workerSubscription(memberId);
        if (subscription.frequency === 'paused') fail(409, 'subscription_paused', '请先恢复个人订阅，再开启定时生成');
      }
      const now = this.clock(), revision = randomUUID();
      this.store.db.prepare('INSERT INTO notification_schedules VALUES(?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,local_time=excluded.local_time,time_zone=excluded.time_zone,updated_at=excluded.updated_at')
        .run(memberId, revision, Number(request.enabled), request.localTime, request.timeZone, now);
      if (!request.enabled) cancelPendingForMember(this.store, memberId, 'schedule_paused', now);
      writeAudit(this.store, memberId, 'notification.schedule_update', memberId, { enabled: request.enabled, localTime: request.localTime, timeZone: request.timeZone }, now);
      return this.view(this.read(memberId));
    });
  }
  summary(actor: AuthContext) {
    requireNotificationActor(this.store, actor, this.clock(), true);
    const counts = this.store.db.prepare('SELECT count(*) AS total,coalesce(sum(enabled),0) AS enabled FROM notification_schedules').get() as Row;
    const latest = this.store.db.prepare('SELECT max(updated_at) AS latest FROM notification_schedule_runs').get() as Row;
    return { enabled: this.options.enabled, phase: 6, timeZone: 'Asia/Shanghai', configuredMembers: Number(counts.total),
      enabledMembers: Number(counts.enabled), lastRunAt: latest.latest === null ? null : new Date(latest.latest).toISOString() };
  }
  tick() {
    const result = { assembled: 0, queued: 0, waiting: 0, skipped: 0, enabled: this.options.enabled, busy: false };
    if (!this.options.enabled) return result;
    if (this.running) return { ...result, busy: true };
    this.running = true;
    try {
      const now = this.clock(), local = localClock(now);
      const schedules = this.store.db.prepare("SELECT s.* FROM notification_schedules s JOIN users u ON u.id=s.member_id WHERE s.enabled=1 AND u.status='active' AND u.role<>'viewer' ORDER BY s.member_id LIMIT 100").all() as Row[];
      for (const schedule of schedules) {
        if (schedule.local_time > local.time) { result.skipped++; continue; }
        const previous = this.store.db.prepare('SELECT * FROM notification_schedule_runs WHERE member_id=? AND report_date=?').get(schedule.member_id, local.date) as Row | undefined;
        if (previous && previous.status !== 'waiting') { result.skipped++; continue; }
        try {
          const subscription = this.options.content.workerSubscription(schedule.member_id);
          if (subscription.frequency === 'paused' || (subscription.frequency === 'weekdays' && local.weekend)) { result.skipped++; continue; }
          // Reserve one durable daily assembly key. ContentService's own transaction
          // commits edition+history+request atomically; retries recover it after a crash.
          if (!previous) this.store.db.prepare("INSERT OR IGNORE INTO notification_schedule_runs(member_id,report_date,schedule_revision,status,created_at,updated_at) VALUES(?,?,?,'waiting',?,?)")
            .run(schedule.member_id, local.date, schedule.revision, now, now);
          const current = this.store.db.prepare('SELECT * FROM notification_schedule_runs WHERE member_id=? AND report_date=?').get(schedule.member_id, local.date) as Row;
          let editionId = current.edition_id as string | null;
          if (!editionId) {
            const assembled = this.options.content.workerAssemble(schedule.member_id, `scheduled_${local.date.replaceAll('-', '')}`, local.date);
            if (!assembled.finalized || !assembled.edition.items.length) {
              this.store.db.prepare("UPDATE notification_schedule_runs SET error_code='no_new_items',updated_at=? WHERE member_id=? AND report_date=?")
                .run(this.clock(), schedule.member_id, local.date);
              result.waiting++; continue;
            }
            editionId = assembled.edition.editionId;
            this.store.db.prepare('UPDATE notification_schedule_runs SET edition_id=?,updated_at=? WHERE member_id=? AND report_date=?')
              .run(editionId, this.clock(), schedule.member_id, local.date);
            if (!assembled.idempotent) result.assembled++;
          }
          let intentId: string | null = null;
          if (subscription.channel !== 'in-app') {
            const enqueued = this.options.queue.enqueueDaily(schedule.member_id, editionId, subscription.channel, local.date);
            intentId = enqueued.delivery.intentId;
            if (!enqueued.idempotent) result.queued++;
          }
          this.store.db.prepare("UPDATE notification_schedule_runs SET status='complete',intent_id=?,error_code=NULL,updated_at=? WHERE member_id=? AND report_date=?")
            .run(intentId, this.clock(), schedule.member_id, local.date);
        } catch (error) {
          // Expected missing readiness/binding is retried on a later tick; no model
          // calls, history duplication, or external send happens in this method.
          const code = error instanceof ContentError ? error.code : 'schedule_validation_failed';
          this.store.db.prepare('UPDATE notification_schedule_runs SET error_code=?,updated_at=? WHERE member_id=? AND report_date=?')
            .run(code, this.clock(), schedule.member_id, local.date);
          result.waiting++;
        }
      }
      return result;
    } finally { this.running = false; }
  }
}
