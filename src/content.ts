import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./db";
import type { AuthContext, MemberUser } from "./auth";
import { cancelPendingForMember } from "./notification-queue";
import { assemblePersonalEdition } from "./engine/personal";
import { createCandidateSnapshot, createFeedbackSnapshot, createHistorySnapshot, createSubscriptionRevision,
  personalHash, validateCandidateSnapshot, validatePersonalEdition, validateSubscriptionRevision,
  type CandidateSnapshot, type PersonalCandidate, type PersonalEdition, type SubscriptionRevision,
} from "./engine/personal-contract";
import { RadarItemSchema, RadarPreferencesSchema, RadarSchema, type RadarItem, type RadarPreferences, type RadarSnapshot } from "./engine/radar-contract";
import { EngineTopicSchema, type EngineTopicProfile } from "./engine/member-export-contract";

const TopicId = z.string().regex(/^[a-z0-9-]+$/).max(60);
const Id = z.string().regex(/^[a-f0-9]{64}$/);
const Keyword = z.string().trim().min(2).max(100);
export const TopicSchema = EngineTopicSchema;
export type Topic = z.infer<typeof TopicSchema>;
export type TopicProfile = EngineTopicProfile;
export interface VerifiedExport {
  exportId: string; generatedAt: string; snapshot: CandidateSnapshot; profiles: TopicProfile[]; revokedRevisionIds: string[];
  catalogBatchId: string; rawBatchId: string;
  proof?: unknown;
}
export class ContentError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new ContentError(status, code, message); }
const initialRevision = "initial";
const PreferenceWrite = z.object({ baseRevision: z.string().min(1), preferences: RadarPreferencesSchema }).strict();
export const SubscriptionSettingsSchema = z.object({
  primaryTopicId: TopicId, secondaryTopicIds: z.array(TopicId).max(11), subtopicIds: z.record(TopicId, z.array(TopicId).max(20)),
  keywords: z.array(Keyword).max(40), excludeKeywords: z.array(Keyword).max(40), codeOnly: z.boolean(),
  contentTypes: z.array(z.enum(["paper", "repository", "research", "industry", "opinion", "video"])).min(1).max(6),
  maxItems: z.number().int().min(1).max(50), primaryShare: z.number().min(0).max(1), preferOpenSource: z.boolean(),
  frequency: z.enum(["daily", "weekdays", "paused"]), channel: z.enum(["in-app", "feishu", "wechat"]),
  firstEditionLookbackDays: z.union([z.literal(1), z.literal(7)]),
}).strict();
const SubscriptionWrite = z.object({ baseRevision: z.string().min(1), subscription: SubscriptionSettingsSchema }).strict();
const PreviewRequest = z.object({ subscriptionRevisionId: Id.optional(), subscription: SubscriptionSettingsSchema.optional() }).strict()
  .refine(value => !(value.subscriptionRevisionId && value.subscription), "Choose a saved revision or a draft subscription");
const EditionRequest = z.object({ subscriptionRevisionId: Id.optional(), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/) }).strict();
const FeedbackWrite = z.object({ targetEventId: z.string().min(1).max(500), kind: z.enum(["read", "saved", "not-relevant", "retract"]),
  retractsFeedbackId: z.string().uuid().nullable().optional() }).strict();
const TopicWrite = z.object({ baseRevision: z.string().min(1), profile: TopicSchema }).strict();
const TopicDelete = z.object({ baseRevision: z.string().min(1) }).strict();
// Background work has an explicit, module-private principal. It never creates a
// browser session or bypasses the current SQL account/role/topic checks.
const workerPrincipal = Symbol("member-content-worker");
type Actor = AuthContext | { user: MemberUser; [workerPrincipal]: true };
type Row = Record<string, any>;
type ActiveFeedback = { feedbackId: string; kind: "read" | "saved" | "not-relevant"; occurredAt: string };
type FeedbackState = { read: boolean; saved: boolean; notRelevant: boolean; feedback: ActiveFeedback[] };
type LibraryEntry = { item: RadarItem; origin: "current" | "saved-history"; feedback: FeedbackState };
const defaults = { contentTypes: ["paper", "repository", "research", "industry", "opinion", "video"] as SubscriptionRevision["contentTypes"],
  maxItems: 10, primaryShare: 0.6, preferOpenSource: false, frequency: "daily" as const, channel: "in-app" as const, firstEditionLookbackDays: 7 as const };
const preferencesOf = (s: SubscriptionRevision): RadarPreferences => RadarPreferencesSchema.parse({ primaryTopicId: s.primaryTopicId,
  secondaryTopicIds: s.secondaryTopicIds, keywords: s.keywords, excludeKeywords: s.excludeKeywords, subtopicIds: s.subtopicIds, codeOnly: s.codeOnly });
const dateInZone = (date: Date, zone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return ["year", "month", "day"].map(type => parts.find(p => p.type === type)!.value).join("-");
};

export class ContentService {
  private now: () => Date;
  private verifyExport: (value: unknown) => VerifiedExport;
  constructor(private store: Store, options: { now?: () => Date; verifyExport: (value: unknown) => VerifiedExport }) {
    this.now = options.now ?? (() => new Date()); this.verifyExport = options.verifyExport;
  }
  private read(sql: string, ...args: (string | number)[]): Row | undefined { return this.store.db.prepare(sql).get(...args) as Row | undefined; }
  private rows(sql: string, ...args: (string | number)[]): Row[] { return this.store.db.prepare(sql).all(...args) as Row[]; }
  private audit(actorId: string | null, action: string, target: string | null, metadata: unknown = {}) {
    this.store.db.prepare("INSERT INTO audit_events(id,actor_id,action,target_id,metadata_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), actorId, action, target, JSON.stringify(metadata), this.now().getTime());
  }
  private active(actor: Actor) {
    // Refresh ownership and status even for internal callers holding an older auth context.
    const row = this.read("SELECT * FROM users WHERE id=?", actor.user.userId);
    const now = this.now().getTime();
    const session = "sessionId" in actor ? this.read("SELECT * FROM sessions WHERE id=? AND user_id=?", actor.sessionId, actor.user.userId) : null;
    const trusted = workerPrincipal in actor && actor[workerPrincipal] === true;
    if ((!trusted && (!session || session.revoked_at || session.expires_at <= now || session.last_seen_at + 12 * 60 * 60 * 1000 <= now)) || !row || row.status !== "active")
      fail(401, "session_expired", "会话已失效，请重新登录");
    actor.user = { userId: row.id, email: row.email, displayName: row.display_name, status: row.status, role: row.role,
      revision: row.revision, ownedTopicIds: JSON.parse(row.owned_topic_ids), readTopicIds: JSON.parse(row.read_topic_ids) };
  }
  private writable(actor: Actor) { this.active(actor); if (actor.user.role === "viewer") fail(403, "read_only", "只读成员不能修改内容"); }
  private canRead(actor: Actor, topicId: string) { return actor.user.role === "lab_owner" || actor.user.readTopicIds.includes("*") || actor.user.readTopicIds.includes(topicId); }
  capabilities(actor: Actor) {
    this.active(actor);
    return { schemaVersion: 1, library: true, feedback: true, draftPreview: true, personalEditions: true,
      personalDelivery: { enabled: false, phase: 6, channels: [] }, scheduler: { enabled: false, phase: 6 }, groupDelivery: { mode: "existing-engine" } };
  }
  private topicRows() { return this.rows("SELECT * FROM content_topics WHERE deleted=0 ORDER BY id"); }
  private profiles() { return this.topicRows().map(row => JSON.parse(row.profile_json) as TopicProfile); }
  private activeProfiles() { return this.profiles().filter(profile => profile.topic.enabled && profile.topic.weight > 0); }
  private ensureTopics(actor: Actor, preferences: RadarPreferences) {
    const selected = [preferences.primaryTopicId, ...preferences.secondaryTopicIds];
    const profiles = this.activeProfiles();
    if (selected.some(id => !this.canRead(actor, id) || !profiles.some(p => p.topic.id === id)) ||
      Object.entries(preferences.subtopicIds).some(([id, ids]) => !selected.includes(id) || ids.some(sub => !profiles.find(p => p.topic.id === id)?.topic.subtopics?.some(s => s.id === sub))))
      fail(409, "topics_changed", "主题权限或子方向已变化，请重新选择");
  }
  topics(actor: Actor) {
    this.active(actor);
    return { topics: this.activeProfiles().filter(p => this.canRead(actor, p.topic.id)).map(p => ({ id: p.topic.id, name: p.topic.name,
      revisionId: p.revisionId, scope: p.topic.scope ?? "", subtopics: (p.topic.subtopics ?? []).map(s => ({ id: s.id, name: s.name })) })) };
  }
  catalog(actor?: Actor) {
    if (actor) {
      this.active(actor);
      if (!["lab_owner", "topic_owner"].includes(actor.user.role)) fail(403, "forbidden", "没有主题管理权限");
    }
    const profiles = this.profiles().filter(p => !actor || actor.user.role === "lab_owner" || actor.user.ownedTopicIds.includes(p.topic.id));
    return { revision: personalHash(profiles), profiles };
  }
  putTopic(actor: Actor, topicId: string, input: unknown) {
    this.writable(actor); TopicId.parse(topicId);
    const { baseRevision, profile: topic } = TopicWrite.parse(input);
    if (topic.id !== topicId) fail(400, "topic_id_mismatch", "主题标识不一致");
    return this.store.transaction(() => {
      const current = this.read("SELECT * FROM content_topics WHERE id=?", topicId);
      if (actor.user.role !== "lab_owner" && !(actor.user.role === "topic_owner" && current && !current.deleted && actor.user.ownedTopicIds.includes(topicId)))
        fail(403, "forbidden", "只能管理已授权的主题");
      if ((current?.revision ?? initialRevision) !== baseRevision) fail(409, "revision_conflict", "主题已被其他人修改");
      const other = this.profiles().filter(p => p.topic.id !== topicId);
      if (other.length >= 12) fail(400, "topic_limit", "最多支持十二个主题");
      if (![...other.map(p => p.topic), topic].some(t => t.enabled && t.weight > 0)) fail(400, "empty_catalog", "至少启用一个主题");
      const profile: TopicProfile = { protocol: "topic-profile-v1", revisionId: personalHash(topic), topic };
      this.saveProfile(profile, this.now().getTime());
      this.audit(actor.user.userId, "topic.update", topicId, { revision: profile.revisionId });
      return { profile, reprocessingRequired: true };
    });
  }
  deleteTopic(actor: Actor, topicId: string, input: unknown) {
    this.writable(actor); const { baseRevision } = TopicDelete.parse(input);
    return this.store.transaction(() => {
      const current = this.read("SELECT * FROM content_topics WHERE id=? AND deleted=0", topicId);
      if (!current) fail(404, "not_found", "主题不存在");
      if (actor.user.role !== "lab_owner" && !(actor.user.role === "topic_owner" && actor.user.ownedTopicIds.includes(topicId))) fail(403, "forbidden", "只能管理已授权的主题");
      if (current.revision !== baseRevision) fail(409, "revision_conflict", "主题已被其他人修改");
      if (!this.activeProfiles().some(p => p.topic.id !== topicId)) fail(400, "empty_catalog", "至少保留一个启用主题");
      const revision = personalHash({ deleted: true, previousRevision: current.revision, at: this.now().toISOString() });
      this.store.db.prepare("UPDATE content_topics SET revision=?,deleted=1,updated_at=? WHERE id=?").run(revision, this.now().getTime(), topicId);
      this.audit(actor.user.userId, "topic.delete", topicId, { revision });
      return { revision, deleted: true, reprocessingRequired: true };
    });
  }
  private saveProfile(profile: TopicProfile, now: number) {
    const json = JSON.stringify(profile);
    this.store.db.prepare("INSERT OR IGNORE INTO content_topic_revisions VALUES(?,?,?,?)").run(profile.revisionId, profile.topic.id, json, now);
    this.store.db.prepare("INSERT INTO content_topics(id,revision,profile_json,deleted,updated_at) VALUES(?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,profile_json=excluded.profile_json,deleted=0,updated_at=excluded.updated_at")
      .run(profile.topic.id, profile.revisionId, json, now);
  }
  private verifiedExport(value: unknown) {
    let verified: VerifiedExport;
    try { verified = this.verifyExport(value); } catch { fail(400, "invalid_export", "内容导出校验失败"); }
    const generatedAt = Date.parse(verified.generatedAt), now = this.now().getTime();
    if (!Number.isFinite(generatedAt) || generatedAt > now || Date.parse(verified.snapshot.cutoffAt) > now)
      fail(400, "future_export", "不能导入未来的内容快照");
    return verified;
  }
  importRevocations(value: unknown) {
    const verified = this.verifiedExport(value);
    const ids = [...new Set([...verified.revokedRevisionIds, ...verified.snapshot.revokedRevisionIds])];
    for (const revisionId of ids) Id.parse(revisionId);
    return this.store.transaction(() => {
      let applied = 0;
      for (const revisionId of ids) applied += Number(this.store.db.prepare("INSERT OR IGNORE INTO content_revocations VALUES(?,?,?)")
        .run(revisionId, this.now().getTime(), "engine-export").changes);
      if (applied) this.audit(null, "content.import_revocations", verified.exportId, { applied });
      return { exportId: verified.exportId, received: ids.length, applied };
    });
  }
  importExport(value: unknown) {
    // Verifier reconstructs the candidate snapshot from raw/shared/profile proofs before SQL readiness.
    const verified = this.verifiedExport(value);
    const snapshot = validateCandidateSnapshot(verified.snapshot);
    Id.parse(verified.catalogBatchId); Id.parse(verified.rawBatchId);
    if (!snapshot.batchIds.includes(verified.catalogBatchId)) fail(400, "catalog_mismatch", "目录批次不在已验证快照中");
    const payloadHash = personalHash(value), generatedAt = Date.parse(verified.generatedAt), now = this.now().getTime();
    const profiles = verified.profiles.map(profile => {
      const topic = TopicSchema.parse(profile.topic);
      if (profile.protocol !== "topic-profile-v1" || profile.revisionId !== personalHash(topic)) fail(400, "profile_integrity", "主题修订校验失败");
      return { ...profile, topic };
    });
    if (!profiles.length || profiles.length > 12 || new Set(profiles.map(p => p.topic.id)).size !== profiles.length) fail(400, "invalid_catalog", "主题目录无效");
    const expectedTopics = profiles.filter(p => p.topic.enabled && p.topic.weight > 0).map(p => [p.topic.id, p.revisionId]).sort();
    if (personalHash(expectedTopics) !== personalHash(snapshot.topics.map(t => [t.id, t.revisionId]).sort())) fail(400, "catalog_mismatch", "快照与主题目录不一致");
    for (const id of verified.revokedRevisionIds) Id.parse(id);
    return this.store.transaction(() => {
      const previous = this.read("SELECT * FROM content_imports WHERE export_id=?", verified.exportId);
      if (previous) {
        if (previous.payload_hash !== payloadHash) fail(409, "immutable_import", "同一导入标识对应不同内容");
        return { exportId: verified.exportId, snapshotId: snapshot.snapshotId, ready: true, idempotent: true };
      }
      if (!this.read("SELECT id FROM content_topics LIMIT 1")) for (const profile of profiles) this.saveProfile(profile, now);
      const currentTopics = this.activeProfiles().map(p => [p.topic.id, p.revisionId]).sort();
      if (personalHash(currentTopics) !== personalHash(expectedTopics)) fail(409, "catalog_changed", "请先按成员服务当前主题目录重新处理内容");
      for (const revisionId of [...new Set([...verified.revokedRevisionIds, ...snapshot.revokedRevisionIds])])
        this.store.db.prepare("INSERT OR IGNORE INTO content_revocations VALUES(?,?,?)").run(revisionId, now, "engine-export");
      const existingSnapshot = this.read("SELECT * FROM content_snapshots WHERE snapshot_id=?", snapshot.snapshotId);
      if (existingSnapshot && (personalHash(JSON.parse(existingSnapshot.snapshot_json)) !== personalHash(snapshot) ||
        existingSnapshot.catalog_batch_id !== verified.catalogBatchId || existingSnapshot.raw_batch_id !== verified.rawBatchId))
        fail(409, "snapshot_integrity", "不可变快照内容冲突");
      this.store.db.prepare("INSERT OR IGNORE INTO content_snapshots VALUES(?,?,?,?,?,?)").run(snapshot.snapshotId, JSON.stringify(snapshot), snapshot.reportDate, Date.parse(snapshot.cutoffAt), verified.catalogBatchId, verified.rawBatchId);
      this.store.db.prepare("INSERT INTO content_imports VALUES(?,?,?,?,?,?)").run(verified.exportId, payloadHash, JSON.stringify(value), snapshot.snapshotId, generatedAt, now);
      this.store.db.prepare("INSERT INTO content_ready VALUES(?,?,?,?,?)").run(verified.exportId, snapshot.snapshotId, snapshot.reportDate, Date.parse(snapshot.cutoffAt), now);
      this.audit(null, "content.import", verified.exportId, { snapshotId: snapshot.snapshotId, count: snapshot.items.length });
      return { exportId: verified.exportId, snapshotId: snapshot.snapshotId, ready: true, idempotent: false };
    });
  }
  private defaultPreferences(actor: Actor): RadarPreferences {
    const topics = this.topics(actor).topics;
    if (!topics.length) fail(503, "content_unavailable", "暂无可访问的主题，请联系管理员完成内容导入");
    return { primaryTopicId: topics[0].id, secondaryTopicIds: [], keywords: [], excludeKeywords: [], subtopicIds: {}, codeOnly: false };
  }
  getPreferences(actor: Actor) {
    this.active(actor);
    const current = this.read("SELECT * FROM content_preferences WHERE member_id=?", actor.user.userId);
    return { revision: current?.revision ?? initialRevision, preferences: current ? RadarPreferencesSchema.parse(JSON.parse(current.preferences_json)) : this.defaultPreferences(actor) };
  }
  getSubscription(actor: Actor) {
    this.active(actor);
    const current = this.read("SELECT s.* FROM content_subscriptions s JOIN content_preferences p ON p.revision=s.revision_id WHERE p.member_id=?", actor.user.userId);
    if (current) return { revision: current.revision_id as string, subscription: validateSubscriptionRevision(JSON.parse(current.subscription_json)) };
    return { revision: initialRevision, subscription: null, defaults: { ...defaults, ...this.defaultPreferences(actor) } };
  }
  private writeSubscription(actor: Actor, baseRevision: string, settings: z.infer<typeof SubscriptionSettingsSchema>) {
    const current = this.read("SELECT revision FROM content_preferences WHERE member_id=?", actor.user.userId);
    if ((current?.revision ?? initialRevision) !== baseRevision) fail(409, "revision_conflict", "订阅偏好已在其他页面更新，请重新读取后合并");
    const subscription = createSubscriptionRevision({ ...settings, schemaVersion: 1, memberId: actor.user.userId, effectiveAt: this.now().toISOString() });
    const preferences = preferencesOf(subscription); this.ensureTopics(actor, preferences);
    this.store.db.prepare("INSERT OR IGNORE INTO content_subscriptions VALUES(?,?,?,?)").run(subscription.revisionId, actor.user.userId, JSON.stringify(subscription), this.now().getTime());
    this.store.db.prepare("INSERT INTO content_preferences VALUES(?,?,?) ON CONFLICT(member_id) DO UPDATE SET revision=excluded.revision,preferences_json=excluded.preferences_json")
      .run(actor.user.userId, subscription.revisionId, JSON.stringify(preferences));
    cancelPendingForMember(this.store, actor.user.userId, settings.frequency === "paused" ? "subscription_paused" : "subscription_changed", this.now().getTime());
    this.audit(actor.user.userId, "subscription.update", actor.user.userId, { revision: subscription.revisionId });
    return subscription;
  }
  putPreferences(actor: Actor, input: unknown) {
    this.writable(actor); const { baseRevision, preferences } = PreferenceWrite.parse(input);
    return this.store.transaction(() => {
      const existing = this.getSubscription(actor).subscription;
      const settings = SubscriptionSettingsSchema.parse({ ...defaults, ...(existing ? SubscriptionSettingsSchema.parse(Object.fromEntries(Object.keys(SubscriptionSettingsSchema.shape).map(key => [key, existing[key as keyof SubscriptionRevision]]))) : {}), ...preferences });
      const subscription = this.writeSubscription(actor, baseRevision, settings);
      return { revision: subscription.revisionId, preferences: preferencesOf(subscription) };
    });
  }
  putSubscription(actor: Actor, input: unknown) {
    this.writable(actor); const { baseRevision, subscription: settings } = SubscriptionWrite.parse(input);
    return this.store.transaction(() => { const subscription = this.writeSubscription(actor, baseRevision, settings); return { revision: subscription.revisionId, subscription }; });
  }
  private revoked() { return new Set(this.rows("SELECT revision_id FROM content_revocations").map(row => row.revision_id as string)); }
  private candidateView(actor: Actor, cutoff = this.now()): CandidateSnapshot { return this.candidateViewData(actor, cutoff).snapshot; }
  private candidateViewData(actor: Actor, cutoff = this.now()) {
    this.active(actor);
    const rows = this.rows("SELECT s.* FROM content_ready r JOIN content_snapshots s ON s.snapshot_id=r.snapshot_id WHERE r.cutoff_at<=? ORDER BY r.report_date DESC,r.cutoff_at DESC,r.ready_at DESC,r.export_id DESC", cutoff.getTime());
    const current = this.activeProfiles();
    const currentRevisions = Object.fromEntries(current.map(p => [p.topic.id, p.revisionId]));
    let original: CandidateSnapshot | undefined;
    let originalRow: Row | undefined;
    for (const row of rows) {
      const candidate = validateCandidateSnapshot(JSON.parse(row.snapshot_json));
      if (candidate.reportDate > dateInZone(cutoff, candidate.reportTimeZone)) continue;
      if (personalHash(Object.fromEntries(candidate.topics.map(t => [t.id, t.revisionId]))) !== personalHash(currentRevisions)) continue;
      original = candidate; originalRow = row; break;
    }
    if (!original) fail(503, "content_unavailable", "暂无匹配当前主题目录的合格内容，请等待重新处理");
    const topics = original.topics.filter(topic => this.canRead(actor, topic.id));
    if (!topics.length) fail(403, "no_readable_topics", "没有可访问的主题");
    const permitted = new Set(topics.map(t => t.id)), revoked = this.revoked();
    const items = original.items.flatMap(item => {
      if (revoked.has(item.revisionId) || original!.revokedRevisionIds.includes(item.revisionId)) return [];
      const assessments = item.assessments.filter(a => permitted.has(a.topicId));
      if (!assessments.length) return [];
      const primaryTopicId = assessments.some(a => a.topicId === item.primaryTopicId) ? item.primaryTopicId : [...assessments].sort((a, b) => b.relevance - a.relevance || a.topicId.localeCompare(b.topicId))[0].topicId;
      return [{ ...item, assessments, primaryTopicId, secondaryTopicIds: assessments.filter(a => a.topicId !== primaryTopicId).map(a => a.topicId) }];
    });
    const snapshot = createCandidateSnapshot({ schemaVersion: 1, reportDate: dateInZone(cutoff, original.reportTimeZone), reportTimeZone: original.reportTimeZone,
      cutoffAt: cutoff.toISOString(), batchIds: original.batchIds, policyRevisions: original.policyRevisions, topics, items, revokedRevisionIds: [], diagnostics: [] });
    return { snapshot, sourceReportDate: original.reportDate, catalogBatchId: originalRow!.catalog_batch_id as string, rawBatchId: originalRow!.raw_batch_id as string };
  }
  radar(actor: Actor): RadarSnapshot {
    const { snapshot, catalogBatchId, rawBatchId } = this.candidateViewData(actor);
    const start = new Date(Date.parse(snapshot.reportDate) - 6 * 86400000).toISOString().slice(0, 10);
    const unique = new Map<string, PersonalCandidate>();
    for (const item of [...snapshot.items].sort((a, b) => (b.publishedAt ?? b.observedOn).localeCompare(a.publishedAt ?? a.observedOn) || b.quality - a.quality || a.revisionId.localeCompare(b.revisionId))) {
      const published = item.publishedAt ? Date.parse(item.publishedAt) : null;
      if (item.observedOn > snapshot.reportDate || (published !== null && (!Number.isFinite(published) || published > Date.parse(snapshot.cutoffAt)))) continue;
      const day = item.publishedAt ? dateInZone(new Date(item.publishedAt), snapshot.reportTimeZone) : item.observedOn;
      if (day < start || unique.has(item.eventId)) continue;
      unique.set(item.eventId, item);
    }
    const pool = [...unique.values()], profiles = this.activeProfiles();
    const topics = snapshot.topics.map(t => {
      const available = pool.filter(i => i.assessments.some(a => a.topicId === t.id));
      const limit = profiles.find(p => p.topic.id === t.id)?.topic.radarLimit ?? 20;
      const ranked = available.sort((a, b) => b.assessments.find(x => x.topicId === t.id)!.relevance - a.assessments.find(x => x.topicId === t.id)!.relevance || b.quality - a.quality || a.revisionId.localeCompare(b.revisionId));
      return { ...t, limit, available: available.length, itemIds: ranked.slice(0, limit).map(i => i.revisionId) };
    });
    const visible = new Set(topics.flatMap(t => t.itemIds));
    const items = pool.filter(i => visible.has(i.revisionId)).map(({ sourceItemId: _s, contentHash: _c, observedOn: _o, verifiedUpdate: _u, ...item }) => item);
    const body = { schemaVersion: 1 as const, algorithmVersion: "topic-radar-v1" as const, batchId: catalogBatchId, rawBatchId,
      reportDate: snapshot.reportDate, reportTimeZone: snapshot.reportTimeZone, windowDays: 7 as const, topics, items, diagnostics: [] };
    return RadarSchema.parse({ ...body, radarId: personalHash(body) });
  }
  private feedbackStates(actor: Actor) {
    const rows = this.rows("SELECT * FROM content_feedback WHERE member_id=? AND occurred_at<=? ORDER BY occurred_at,feedback_id", actor.user.userId, this.now().getTime());
    const retracted = new Set(rows.filter(row => row.kind === "retract").map(row => row.retracts_feedback_id));
    const states = new Map<string, FeedbackState>();
    for (const row of rows) {
      if (row.kind === "retract" || retracted.has(row.feedback_id)) continue;
      const state = states.get(row.event_id) ?? { read: false, saved: false, notRelevant: false, feedback: [] };
      state.feedback.push({ feedbackId: row.feedback_id, kind: row.kind, occurredAt: new Date(row.occurred_at).toISOString() });
      if (row.kind === "read") state.read = true;
      if (row.kind === "saved") state.saved = true;
      if (row.kind === "not-relevant") state.notRelevant = true;
      states.set(row.event_id, state);
    }
    return states;
  }
  private accessibleItems(actor: Actor) {
    this.active(actor);
    const activeTopics = new Set(this.activeProfiles().filter(p => this.canRead(actor, p.topic.id)).map(p => p.topic.id));
    const revoked = this.revoked(), feedback = this.feedbackStates(actor);
    const entries = new Map<string, LibraryEntry>();
    const effectiveTimes = new Map<string, number>();
    const accept = (candidate: PersonalCandidate, origin: LibraryEntry["origin"]) => {
      const published = candidate.publishedAt === null ? null : Date.parse(candidate.publishedAt);
      if (revoked.has(candidate.revisionId) || (published !== null && (!Number.isFinite(published) || published > this.now().getTime()))) return;
      const assessments = candidate.assessments.filter(a => activeTopics.has(a.topicId));
      if (!assessments.length) return;
      const primaryTopicId = assessments.some(a => a.topicId === candidate.primaryTopicId) ? candidate.primaryTopicId
        : [...assessments].sort((a, b) => b.relevance - a.relevance || a.topicId.localeCompare(b.topicId))[0].topicId;
      const { sourceItemId: _s, contentHash: _h, observedOn: _o, verifiedUpdate: _u, ...source } = candidate;
      const item = RadarItemSchema.parse({ ...source, assessments, primaryTopicId, secondaryTopicIds: assessments.filter(a => a.topicId !== primaryTopicId).map(a => a.topicId) });
      const previous = entries.get(item.eventId), effectiveTime = published ?? Date.parse(candidate.observedOn);
      if (previous?.origin === "current" && origin === "saved-history") return;
      if (previous && (effectiveTimes.get(item.eventId)! > effectiveTime || (effectiveTimes.get(item.eventId) === effectiveTime &&
        (previous.item.quality > item.quality || (previous.item.quality === item.quality && previous.origin === "current"))))) return;
      effectiveTimes.set(item.eventId, effectiveTime);
      entries.set(item.eventId, { item, origin, feedback: feedback.get(item.eventId) ?? { read: false, saved: false, notRelevant: false, feedback: [] } });
    };
    let currentAvailable = false;
    try {
      const candidates = this.candidateView(actor); currentAvailable = true;
      for (const item of candidates.items) if (item.observedOn <= candidates.reportDate) accept(item, "current");
    } catch (error) {
      if (!(error instanceof ContentError) || !(error.code === "content_unavailable" || error.code === "no_readable_topics")) throw error;
    }
    // Read only this member's immutable receipts. Display one permitted item without disclosing other edition topics/items.
    for (const row of this.rows("SELECT edition_json FROM content_editions WHERE member_id=? AND finalized=1 ORDER BY cutoff_at DESC,edition_id DESC", actor.user.userId)) {
      const edition = validatePersonalEdition(JSON.parse(row.edition_json));
      if (edition.memberId !== actor.user.userId) fail(503, "edition_integrity", "个人简报版本校验失败");
      for (const selected of edition.items) accept(selected.item, "saved-history");
    }
    return { entries, feedback, currentAvailable };
  }
  library(actor: Actor) {
    const { entries, currentAvailable } = this.accessibleItems(actor);
    const items = [...entries.values()].filter(entry => entry.origin === "current" || entry.feedback.saved)
      .sort((a, b) => (b.item.publishedAt ?? "").localeCompare(a.item.publishedAt ?? "") || b.item.quality - a.item.quality || a.item.eventId.localeCompare(b.item.eventId));
    return { items, currentAvailable };
  }
  getFeedback(actor: Actor) {
    const { entries, feedback } = this.accessibleItems(actor);
    const items = [...feedback.entries()].filter(([eventId]) => entries.has(eventId))
      .map(([eventId, state]) => ({ eventId, ...state })).sort((a, b) => a.eventId.localeCompare(b.eventId));
    return { revision: personalHash({ memberId: actor.user.userId, items }), items };
  }
  operations(actor: Actor) {
    this.active(actor); if (actor.user.role !== "lab_owner") fail(403, "forbidden", "仅管理员可查看运行汇总");
    const counts = this.read("SELECT count(*) AS editions,coalesce(sum(finalized),0) AS official,count(DISTINCT member_id) AS members,max(created_at) AS latest FROM content_editions")!;
    const catalogHash = personalHash(Object.fromEntries(this.activeProfiles().map(p => [p.topic.id, p.revisionId])));
    const catalogCurrent = (json: string) => personalHash(Object.fromEntries((JSON.parse(json) as CandidateSnapshot).topics.map(t => [t.id, t.revisionId]))) === catalogHash;
    const currentCatalogReady = this.rows("SELECT s.snapshot_json FROM content_snapshots s JOIN content_ready r ON r.snapshot_id=s.snapshot_id WHERE r.cutoff_at<=?", this.now().getTime())
      .some(row => catalogCurrent(row.snapshot_json));
    const latestImports = this.rows("SELECT i.export_id,i.snapshot_id,i.generated_at,i.imported_at,r.report_date,r.cutoff_at,s.snapshot_json FROM content_imports i JOIN content_ready r ON r.export_id=i.export_id JOIN content_snapshots s ON s.snapshot_id=i.snapshot_id ORDER BY i.imported_at DESC,i.export_id DESC LIMIT 20")
      .map(row => ({ exportId: row.export_id as string, snapshotId: row.snapshot_id as string, reportDate: row.report_date as string,
        cutoffAt: new Date(row.cutoff_at).toISOString(), generatedAt: new Date(row.generated_at).toISOString(), importedAt: new Date(row.imported_at).toISOString(),
        status: "ready" as const, catalogCurrent: catalogCurrent(row.snapshot_json) }));
    return { generatedAt: this.now().toISOString(), content: { readyImports: Number(this.read("SELECT count(*) AS n FROM content_ready")!.n),
      revokedRevisions: Number(this.read("SELECT count(*) AS n FROM content_revocations")!.n), activeTopics: this.activeProfiles().length,
      catalogRevision: this.catalog().revision, currentCatalogReady, latestImports },
      assembly: { status: "on-demand", editions: Number(counts.editions), officialEditions: Number(counts.official), membersWithEditions: Number(counts.members),
        lastCreatedAt: counts.latest === null ? null : new Date(counts.latest).toISOString() },
      delivery: { enabled: false, phase: 6, records: [] }, scheduler: { enabled: false, phase: 6 }, groupDelivery: { mode: "existing-engine" } };
  }
  private subscriptionFor(actor: Actor, revisionId?: string) {
    const current = this.getSubscription(actor);
    if (!current.subscription) fail(409, "subscription_required", "请先保存个人订阅");
    if (revisionId && revisionId !== current.revision) fail(409, "revision_conflict", "订阅版本已变化，请重新预览");
    this.ensureTopics(actor, preferencesOf(current.subscription));
    return current.subscription;
  }
  private assemblyInput(actor: Actor, subscriptionRevisionId?: string, draft?: z.infer<typeof SubscriptionSettingsSchema>) {
    const cutoff = this.now(), candidates = this.candidateView(actor, cutoff);
    const subscription = draft ? createSubscriptionRevision({ ...draft, schemaVersion: 1, memberId: actor.user.userId, effectiveAt: cutoff.toISOString() })
      : this.subscriptionFor(actor, subscriptionRevisionId);
    if (draft) this.ensureTopics(actor, preferencesOf(subscription));
    const events = this.rows("SELECT * FROM content_feedback WHERE member_id=? AND occurred_at<=? ORDER BY occurred_at,feedback_id", actor.user.userId, cutoff.getTime())
      .map(row => ({ feedbackId: row.feedback_id as string, targetEventId: row.event_id as string, kind: row.kind as "read" | "saved" | "not-relevant" | "retract",
        occurredAt: new Date(row.occurred_at).toISOString(), retractsFeedbackId: row.retracts_feedback_id as string | null }));
    const receipts = this.rows("SELECT * FROM content_editions WHERE member_id=? AND finalized=1 AND cutoff_at<=? ORDER BY cutoff_at,edition_id", actor.user.userId, cutoff.getTime())
      .map(row => { const edition = validatePersonalEdition(JSON.parse(row.edition_json)); return { editionId: edition.editionId, reportDate: edition.reportDate,
        includedAt: edition.cutoffAt, status: "official" as const, items: edition.items.map(i => ({ eventId: i.item.eventId, updateKey: i.updateKey, revisionId: i.item.revisionId, topicId: i.assignedTopicId })) }; });
    return { candidates, subscription, feedback: createFeedbackSnapshot({ schemaVersion: 1, memberId: actor.user.userId, cutoffAt: candidates.cutoffAt, events }),
      history: createHistorySnapshot({ schemaVersion: 1, memberId: actor.user.userId, cutoffAt: candidates.cutoffAt, receipts }) };
  }
  // This is a display projection. The stored immutable contract keeps diagnostics and its original hashes;
  // clients must not treat this reduced member response as a replayable PersonalEdition input.
  private publicEdition(edition: PersonalEdition) { const { diagnostics: _d, ...view } = edition; return view; }
  preview(actor: Actor, input: unknown = {}) {
    this.active(actor); const request = PreviewRequest.parse(input);
    return { edition: this.publicEdition(assemblePersonalEdition(this.assemblyInput(actor, request.subscriptionRevisionId, request.subscription))), finalized: false, draft: !!request.subscription };
  }
  createEdition(actor: Actor, input: unknown) {
    this.writable(actor); const request = EditionRequest.parse(input);
    return this.store.transaction(() => {
      const subscription = this.subscriptionFor(actor, request.subscriptionRevisionId);
      const previous = this.read("SELECT * FROM content_edition_requests WHERE member_id=? AND request_id=?", actor.user.userId, request.requestId);
      if (previous) {
        if (previous.subscription_revision !== subscription.revisionId) fail(409, "request_conflict", "该请求标识已用于另一订阅版本");
        return { ...this.edition(actor, previous.edition_id), idempotent: true };
      }
      const assembly = this.assemblyInput(actor, subscription.revisionId);
      const latest = this.read("SELECT cutoff_at FROM content_editions WHERE member_id=? AND finalized=1 ORDER BY cutoff_at DESC LIMIT 1", actor.user.userId);
      if (latest && latest.cutoff_at >= Date.parse(assembly.candidates.cutoffAt)) fail(409, "history_changed", "上一版本刚刚生成，请稍后重新预览");
      const edition = assemblePersonalEdition(assembly), finalized = edition.status === "ready";
      this.store.db.prepare("INSERT OR IGNORE INTO content_editions VALUES(?,?,?,?,?,?,?,?,?)").run(edition.editionId, actor.user.userId, edition.reportDate, Date.parse(edition.cutoffAt), JSON.stringify(edition), JSON.stringify(assembly), personalHash(assembly), Number(finalized), this.now().getTime());
      this.store.db.prepare("INSERT INTO content_edition_requests VALUES(?,?,?,?)").run(actor.user.userId, request.requestId, subscription.revisionId, edition.editionId);
      this.audit(actor.user.userId, "edition.create", edition.editionId, { finalized, count: edition.items.length });
      return { edition: this.publicEdition(edition), finalized, idempotent: false };
    });
  }
  private checkEditionAccess(actor: Actor, edition: PersonalEdition) {
    const revoked = this.revoked();
    const activeTopics = new Set(this.activeProfiles().map(p => p.topic.id));
    if (edition.topics.some(t => !this.canRead(actor, t.id) || !activeTopics.has(t.id)) || edition.items.some(i => revoked.has(i.item.revisionId))) fail(410, "edition_unavailable", "该版本的内容权限或有效性已变化，暂不可查看");
  }
  listEditions(actor: Actor) {
    this.active(actor);
    return { editions: this.rows("SELECT edition_json,finalized FROM content_editions WHERE member_id=? ORDER BY cutoff_at DESC,edition_id DESC LIMIT 100", actor.user.userId).flatMap(row => {
      const edition = validatePersonalEdition(JSON.parse(row.edition_json));
      try { this.checkEditionAccess(actor, edition); } catch (error) { if (error instanceof ContentError) return []; throw error; }
      return [{ editionId: edition.editionId, reportDate: edition.reportDate, cutoffAt: edition.cutoffAt, status: edition.status, count: edition.items.length, finalized: !!row.finalized }];
    }) };
  }
  edition(actor: Actor, editionId: string) {
    this.active(actor); Id.parse(editionId);
    const row = this.read("SELECT * FROM content_editions WHERE member_id=? AND edition_id=?", actor.user.userId, editionId);
    if (!row) fail(404, "not_found", "个人简报不存在");
    const edition = validatePersonalEdition(JSON.parse(row.edition_json));
    if (edition.memberId !== actor.user.userId) fail(404, "not_found", "个人简报不存在");
    if (personalHash(JSON.parse(row.assembly_input_json)) !== row.input_hash || assemblePersonalEdition(JSON.parse(row.assembly_input_json)).editionId !== edition.editionId)
      fail(503, "edition_integrity", "个人简报版本校验失败");
    this.checkEditionAccess(actor, edition);
    return { edition: this.publicEdition(edition), finalized: !!row.finalized };
  }
  private workerActor(memberId: string): Actor {
    const row = this.read("SELECT * FROM users WHERE id=?", memberId);
    if (!row || row.status !== "active") fail(403, "member_inactive", "成员账号未启用");
    const actor: Actor = { [workerPrincipal]: true, user: { userId: row.id, email: row.email, displayName: row.display_name,
      status: row.status, role: row.role, revision: row.revision, ownedTopicIds: JSON.parse(row.owned_topic_ids), readTopicIds: JSON.parse(row.read_topic_ids) } };
    this.writable(actor);
    return actor;
  }
  /** Trusted process-only entry points. HTTP must never accept a member ID for these methods. */
  workerSubscription(memberId: string) {
    const actor = this.workerActor(memberId);
    return this.subscriptionFor(actor);
  }
  workerEdition(memberId: string, editionId: string) {
    return this.edition(this.workerActor(memberId), editionId);
  }
  workerAssemble(memberId: string, requestId: string, reportDate: string) {
    const actor = this.workerActor(memberId), subscription = this.subscriptionFor(actor);
    if (subscription.frequency === "paused") fail(409, "subscription_paused", "个人简报已暂停");
    const previous = this.read("SELECT * FROM content_edition_requests WHERE member_id=? AND request_id=?", memberId, requestId);
    if (previous) {
      if (previous.subscription_revision !== subscription.revisionId) fail(409, "request_conflict", "该请求标识已用于另一订阅版本");
      const recovered = this.edition(actor, previous.edition_id);
      if (recovered.edition.reportDate !== reportDate) fail(409, "request_conflict", "该请求标识已用于其他日期");
      return { ...recovered, idempotent: true };
    }
    if (this.candidateViewData(actor).sourceReportDate !== reportDate)
      fail(409, "fresh_content_required", "等待当天合格内容，旧内容不会补作今日推送");
    const preview = assemblePersonalEdition(this.assemblyInput(actor, subscription.revisionId));
    if (preview.status !== "ready" || !preview.items.length)
      return { edition: this.publicEdition(preview), finalized: false, idempotent: false };
    return this.createEdition(actor, { requestId, subscriptionRevisionId: subscription.revisionId });
  }
  feedback(actor: Actor, input: unknown) {
    this.writable(actor); const request = FeedbackWrite.parse(input);
    return this.store.transaction(() => {
      let retracts: string | null = null;
      if (request.kind === "retract") {
        if (!request.retractsFeedbackId) fail(400, "invalid_retraction", "请指定要撤回的反馈");
        const target = this.read("SELECT * FROM content_feedback WHERE feedback_id=? AND member_id=?", request.retractsFeedbackId, actor.user.userId);
        if (!target || target.kind === "retract" || target.event_id !== request.targetEventId) fail(404, "not_found", "反馈不存在");
        if (this.read("SELECT feedback_id FROM content_feedback WHERE member_id=? AND retracts_feedback_id=?", actor.user.userId, request.retractsFeedbackId)) fail(409, "already_retracted", "该反馈已撤回");
        retracts = request.retractsFeedbackId;
      } else {
        if (request.retractsFeedbackId) fail(400, "invalid_retraction", "普通反馈不能引用撤回标识");
        if (!this.accessibleItems(actor).entries.has(request.targetEventId)) fail(404, "not_found", "内容不存在或没有访问权限");
      }
      const feedbackId = randomUUID(), occurredAt = this.now();
      this.store.db.prepare("INSERT INTO content_feedback VALUES(?,?,?,?,?,?)").run(feedbackId, actor.user.userId, request.targetEventId, request.kind, retracts, occurredAt.getTime());
      this.audit(actor.user.userId, "feedback.create", feedbackId, { kind: request.kind });
      return { feedbackId, targetEventId: request.targetEventId, kind: request.kind, retractsFeedbackId: retracts, occurredAt: occurredAt.toISOString() };
    });
  }
  revoke(actor: Actor, input: unknown) {
    this.writable(actor); if (actor.user.role !== "lab_owner") fail(403, "forbidden", "仅管理员可撤回内容");
    const request = z.object({ revisionId: Id, reason: z.string().trim().min(1).max(300) }).strict().parse(input);
    return this.store.transaction(() => {
      this.store.db.prepare("INSERT OR IGNORE INTO content_revocations VALUES(?,?,?)").run(request.revisionId, this.now().getTime(), request.reason);
      this.audit(actor.user.userId, "content.revoke", request.revisionId);
      return { revoked: true };
    });
  }
}
