// Pure contracts: crypto hashes are deterministic; this module never reads files, clocks or environment.
import { createHash } from "node:crypto";
import { z } from "zod";
import { RadarItemSchema } from "./radar-contract";

const Id = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().min(1).refine(s => !!s.trim());
const TopicId = z.string().regex(/^[a-z0-9-]+$/).max(60);
const DateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s);
const Instant = z.string().datetime({ offset: true });
const TimeZone = Text.refine(s => { try { new Intl.DateTimeFormat("en", { timeZone: s }); return true; } catch { return false; } });
const Url = z.string().url().refine(s => /^https?:\/\//i.test(s));
const ContentType = z.enum(["paper", "repository", "research", "industry", "opinion", "video"]);
const Keywords = z.array(z.string().trim().min(2).max(100)).max(40);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sortedUnique = (values: string[]) => [...new Set(values)].sort(compare);

export function personalCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(personalCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort(compare).map(k => `${JSON.stringify(k)}:${personalCanonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function personalHash(value: unknown): string {
  return createHash("sha256").update(personalCanonical(value)).digest("hex");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function checkHash<T extends object>(value: T, key: keyof T): T {
  const { [key]: id, ...body } = value;
  if (id !== personalHash(body)) throw new Error(`Personal ${String(key)} hash mismatch`);
  return freeze(value);
}

// Created only by a trusted importer after checking the quote against the qualified raw evidence.
// A content hash, title rewrite, reviewer rerun or codeStatus transition is never an update by itself.
export const EventUpdateRevisionSchema = z.object({
  schemaVersion: z.literal(1), revisionId: Id, qualifiedRevisionId: Id, eventId: Text,
  kind: z.enum(["code_release", "release", "replication", "star_growth"]), updateKey: Text.max(240),
  occurredAt: Instant, evidenceQuote: Text, evidenceUrl: Url, verifiedAt: Instant,
}).strict();
export type EventUpdateRevision = z.infer<typeof EventUpdateRevisionSchema>;
export function createEventUpdateRevision(body: Omit<EventUpdateRevision, "revisionId">): EventUpdateRevision {
  return validateEventUpdateRevision({ ...body, revisionId: personalHash(body) });
}
export function validateEventUpdateRevision(value: unknown): EventUpdateRevision {
  const update = EventUpdateRevisionSchema.parse(value);
  if (Date.parse(update.occurredAt) > Date.parse(update.verifiedAt)) throw new Error("Update cannot occur after verification");
  return checkHash(update, "revisionId");
}

export const PersonalCandidateSchema = RadarItemSchema.extend({
  sourceItemId: Text, contentHash: Id, observedOn: DateKey, verifiedUpdate: EventUpdateRevisionSchema.nullable(),
  contentType: ContentType,
});
export type PersonalCandidate = z.infer<typeof PersonalCandidateSchema>;
export const PersonalTopicSchema = z.object({
  id: TopicId, name: Text, revisionId: Id, scope: z.string(),
  subtopics: z.array(z.object({ id: TopicId, name: Text }).strict()), threshold: z.number().min(70).max(100),
}).strict();
export const CandidateSnapshotSchema = z.object({
  schemaVersion: z.literal(1), snapshotId: Id, reportDate: DateKey, reportTimeZone: TimeZone,
  cutoffAt: Instant, batchIds: z.array(Id).min(1), policyRevisions: z.array(Text).min(1),
  topics: z.array(PersonalTopicSchema).min(1), items: z.array(PersonalCandidateSchema), revokedRevisionIds: z.array(Id),
  diagnostics: z.array(z.object({ revisionId: Id.nullable(), reason: Text }).strict()),
}).strict();
export type CandidateSnapshot = z.infer<typeof CandidateSnapshotSchema>;

function validateCandidateTopics(item: PersonalCandidate, topics: CandidateSnapshot["topics"], cutoffAt: string) {
  const ids = item.assessments.map(a => a.topicId);
  if (new Set(ids).size !== ids.length || !ids.includes(item.primaryTopicId) || item.secondaryTopicIds.length !== ids.length - 1 ||
      new Set(item.secondaryTopicIds).size !== item.secondaryTopicIds.length || item.secondaryTopicIds.some(id => id === item.primaryTopicId || !ids.includes(id)))
    throw new Error("Invalid personal candidate topic assignment");
  for (const assessment of item.assessments) {
    const topic = topics.find(t => t.id === assessment.topicId);
    if (!topic || topic.revisionId !== assessment.topicRevision || assessment.relevance < topic.threshold || assessment.subtopicIds.some(id => !topic.subtopics.some(s => s.id === id)))
      throw new Error("Personal candidate topic revision or threshold mismatch");
  }
  if (item.verifiedUpdate) {
    const update = validateEventUpdateRevision(item.verifiedUpdate);
    if (update.qualifiedRevisionId !== item.revisionId || update.eventId !== item.eventId || !item.evidence.some(e => e.quote.includes(update.evidenceQuote)))
      throw new Error("Substantial update is not bound to current qualified evidence");
    if (Date.parse(update.verifiedAt) > Date.parse(cutoffAt)) throw new Error("Update verification is after cutoff");
  }
}

export function createCandidateSnapshot(body: Omit<CandidateSnapshot, "snapshotId">): CandidateSnapshot {
  const canonical = {
    ...body, batchIds: sortedUnique(body.batchIds), policyRevisions: sortedUnique(body.policyRevisions), revokedRevisionIds: sortedUnique(body.revokedRevisionIds),
    topics: body.topics.map(t => ({ ...t, subtopics: [...t.subtopics].sort((a, b) => compare(a.id, b.id)) })).sort((a, b) => compare(a.id, b.id)),
    items: body.items.map(i => ({ ...i, secondaryTopicIds: sortedUnique(i.secondaryTopicIds),
      assessments: i.assessments.map(a => ({ ...a, subtopicIds: sortedUnique(a.subtopicIds) })).sort((a, b) => compare(a.topicId, b.topicId)),
    })).sort((a, b) => compare(a.revisionId, b.revisionId)),
    diagnostics: [...body.diagnostics].sort((a, b) => compare(a.revisionId ?? "", b.revisionId ?? "") || compare(a.reason, b.reason)),
  };
  return validateCandidateSnapshot({ ...canonical, snapshotId: personalHash(canonical) });
}
export function validateCandidateSnapshot(value: unknown): CandidateSnapshot {
  const snapshot = CandidateSnapshotSchema.parse(value);
  if (new Set(snapshot.topics.map(t => t.id)).size !== snapshot.topics.length || new Set(snapshot.items.map(i => i.revisionId)).size !== snapshot.items.length)
    throw new Error("Duplicate personal topic or candidate revision");
  for (const topic of snapshot.topics) if (new Set(topic.subtopics.map(s => s.id)).size !== topic.subtopics.length) throw new Error("Duplicate subtopic");
  for (const item of snapshot.items) validateCandidateTopics(item, snapshot.topics, snapshot.cutoffAt);
  return checkHash(snapshot, "snapshotId");
}

export const SubscriptionRevisionSchema = z.object({
  schemaVersion: z.literal(1), revisionId: Id, memberId: Text.max(160), effectiveAt: Instant,
  primaryTopicId: TopicId, secondaryTopicIds: z.array(TopicId).max(11),
  subtopicIds: z.record(TopicId, z.array(TopicId).max(20)), contentTypes: z.array(ContentType).min(1).max(6),
  maxItems: z.number().int().min(1).max(50), primaryShare: z.number().min(0).max(1),
  keywords: Keywords, excludeKeywords: Keywords, codeOnly: z.boolean(), preferOpenSource: z.boolean(),
  frequency: z.enum(["daily", "weekdays", "paused"]), channel: z.enum(["in-app", "feishu", "wechat"]),
  firstEditionLookbackDays: z.union([z.literal(1), z.literal(7)]),
}).strict().superRefine((s, ctx) => {
  if (s.secondaryTopicIds.includes(s.primaryTopicId) || new Set(s.secondaryTopicIds).size !== s.secondaryTopicIds.length)
    ctx.addIssue({ code: "custom", message: "Primary and secondary topics must be distinct" });
});
export type SubscriptionRevision = z.infer<typeof SubscriptionRevisionSchema>;
export function createSubscriptionRevision(body: Omit<SubscriptionRevision, "revisionId">): SubscriptionRevision {
  const canonical = { ...body, keywords: sortedUnique(body.keywords), excludeKeywords: sortedUnique(body.excludeKeywords),
    contentTypes: [...new Set(body.contentTypes)].sort(compare),
    subtopicIds: Object.fromEntries(Object.entries(body.subtopicIds).map(([id, values]) => [id, sortedUnique(values)])),
  };
  return validateSubscriptionRevision({ ...canonical, revisionId: personalHash(canonical) });
}
export const validateSubscriptionRevision = (value: unknown): SubscriptionRevision => checkHash(SubscriptionRevisionSchema.parse(value), "revisionId");

export const FeedbackEventSchema = z.object({
  feedbackId: Text, targetEventId: Text, kind: z.enum(["read", "saved", "not-relevant", "retract"]),
  occurredAt: Instant, retractsFeedbackId: Text.nullable(),
}).strict().superRefine((event, ctx) => {
  if ((event.kind === "retract") !== (event.retractsFeedbackId !== null)) ctx.addIssue({ code: "custom", message: "Retraction must reference feedback" });
});
export const FeedbackSnapshotSchema = z.object({
  schemaVersion: z.literal(1), snapshotId: Id, memberId: Text.max(160), cutoffAt: Instant, events: z.array(FeedbackEventSchema),
}).strict();
export type FeedbackSnapshot = z.infer<typeof FeedbackSnapshotSchema>;
export function createFeedbackSnapshot(body: Omit<FeedbackSnapshot, "snapshotId">): FeedbackSnapshot {
  const canonical = { ...body, events: [...body.events].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || compare(a.feedbackId, b.feedbackId)) };
  return validateFeedbackSnapshot({ ...canonical, snapshotId: personalHash(canonical) });
}
export function validateFeedbackSnapshot(value: unknown): FeedbackSnapshot {
  const feedback = FeedbackSnapshotSchema.parse(value);
  if (new Set(feedback.events.map(e => e.feedbackId)).size !== feedback.events.length) throw new Error("Duplicate feedback ID");
  for (const event of feedback.events) {
    if (Date.parse(event.occurredAt) > Date.parse(feedback.cutoffAt)) throw new Error("Feedback is after cutoff");
    if (event.kind === "retract") {
      const target = feedback.events.find(e => e.feedbackId === event.retractsFeedbackId);
      if (!target || target.kind === "retract" || target.targetEventId !== event.targetEventId || Date.parse(target.occurredAt) > Date.parse(event.occurredAt))
        throw new Error("Invalid feedback retraction");
    }
  }
  return checkHash(feedback, "snapshotId");
}

export const HistoryReceiptSchema = z.object({
  editionId: Id, reportDate: DateKey, includedAt: Instant, status: z.literal("official"),
  items: z.array(z.object({ eventId: Text, updateKey: Text, revisionId: Id, topicId: TopicId }).strict()).min(1),
}).strict();
export const HistorySnapshotSchema = z.object({
  schemaVersion: z.literal(1), snapshotId: Id, memberId: Text.max(160), cutoffAt: Instant, receipts: z.array(HistoryReceiptSchema),
}).strict();
export type HistorySnapshot = z.infer<typeof HistorySnapshotSchema>;
export function createHistorySnapshot(body: Omit<HistorySnapshot, "snapshotId">): HistorySnapshot {
  const canonical = { ...body, receipts: body.receipts.map(r => ({ ...r, items: [...r.items].sort((a, b) => compare(a.eventId, b.eventId)) }))
    .sort((a, b) => Date.parse(a.includedAt) - Date.parse(b.includedAt) || compare(a.editionId, b.editionId)) };
  return validateHistorySnapshot({ ...canonical, snapshotId: personalHash(canonical) });
}
export function validateHistorySnapshot(value: unknown): HistorySnapshot {
  const history = HistorySnapshotSchema.parse(value);
  if (new Set(history.receipts.map(r => r.editionId)).size !== history.receipts.length) throw new Error("Duplicate official edition receipt");
  for (const receipt of history.receipts) {
    if (Date.parse(receipt.includedAt) > Date.parse(history.cutoffAt)) throw new Error("History receipt is after cutoff");
    if (new Set(receipt.items.map(i => i.eventId)).size !== receipt.items.length) throw new Error("Duplicate event in official edition receipt");
  }
  return checkHash(history, "snapshotId");
}

export const PersonalEditionItemSchema = z.object({
  item: PersonalCandidateSchema, assignedTopicId: TopicId, slot: z.enum(["primary", "secondary", "fill"]),
  score: z.object({ relevance: z.number().min(70).max(100), quality: z.number().min(80).max(100), freshness: z.number().min(0).max(100), preference: z.number().min(0).max(10), total: z.number().min(0).max(110) }).strict(),
  hitKeywords: z.array(Text), matchedTopicIds: z.array(TopicId).min(1), updateKey: Text,
  recap: z.boolean(), update: z.boolean(), reasons: z.array(Text).min(1),
}).strict();
export const PersonalEditionSchema = z.object({
  schemaVersion: z.literal(1), algorithmVersion: z.literal("personal-assembler-v1"), editionId: Id, contentHash: Id,
  memberId: Text, reportDate: DateKey, reportTimeZone: TimeZone, cutoffAt: Instant,
  inputs: z.object({ candidateSnapshotId: Id, subscriptionRevisionId: Id, feedbackSnapshotId: Id, historySnapshotId: Id,
    batchIds: z.array(Id), policyRevisions: z.array(Text), topicRevisions: z.record(TopicId, Id) }).strict(),
  topics: z.array(PersonalTopicSchema), status: z.enum(["ready", "no-content", "paused", "not-scheduled"]),
  firstEdition: z.boolean(), windowDays: z.number().int().min(1).max(7), windowStartDate: DateKey,
  channel: z.enum(["in-app", "feishu", "wechat"]), externalSendAllowed: z.literal(false),
  items: z.array(PersonalEditionItemSchema),
  quota: z.object({ maxItems: z.number().int().min(1).max(50), primaryTarget: z.number().int().nonnegative(), primarySelected: z.number().int().nonnegative(),
    secondarySelected: z.number().int().nonnegative(), fillSelected: z.number().int().nonnegative(), secondaryOrder: z.array(TopicId), unfilled: z.number().int().nonnegative() }).strict(),
  diagnostics: z.array(z.object({ revisionId: Id, eventId: Text, stage: z.enum(["revoked", "outside-window", "subscription", "hard-filter", "feedback", "history", "duplicate", "quota", "selected"]), reason: Text }).strict()),
}).strict();
export type PersonalEdition = z.infer<typeof PersonalEditionSchema>;
export type PersonalEditionItem = z.infer<typeof PersonalEditionItemSchema>;
export function personalEditionContent(body: Omit<PersonalEdition, "editionId" | "contentHash">) {
  return { memberId: body.memberId, reportDate: body.reportDate, reportTimeZone: body.reportTimeZone, status: body.status,
    topics: body.topics, firstEdition: body.firstEdition, windowDays: body.windowDays, windowStartDate: body.windowStartDate, items: body.items, quota: body.quota };
}
export function createPersonalEdition(body: Omit<PersonalEdition, "editionId" | "contentHash">): PersonalEdition {
  const withContent = { ...body, contentHash: personalHash(personalEditionContent(body)) };
  return validatePersonalEdition({ ...withContent, editionId: personalHash(withContent) });
}
export function validatePersonalEdition(value: unknown): PersonalEdition {
  const edition = PersonalEditionSchema.parse(value);
  const calendarParts = new Intl.DateTimeFormat("en-CA", { timeZone: edition.reportTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(edition.cutoffAt));
  const cutoffDate = ["year", "month", "day"].map(type => calendarParts.find(p => p.type === type)!.value).join("-");
  const expectedStartDate = new Date(Date.parse(edition.reportDate) - (edition.windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
  if (cutoffDate !== edition.reportDate || expectedStartDate !== edition.windowStartDate ||
      (edition.firstEdition ? ![1, 7].includes(edition.windowDays) : edition.windowDays !== 7))
    throw new Error("Invalid personal edition calendar window");
  if ((edition.status === "ready") !== (edition.items.length > 0) || edition.items.length > edition.quota.maxItems ||
      new Set(edition.items.map(i => i.item.eventId)).size !== edition.items.length ||
      edition.quota.primarySelected !== edition.items.filter(i => i.slot === "primary").length ||
      edition.quota.secondarySelected !== edition.items.filter(i => i.slot === "secondary").length ||
      edition.quota.fillSelected !== edition.items.filter(i => i.slot === "fill").length ||
      edition.quota.unfilled !== edition.quota.maxItems - edition.items.length || edition.quota.primaryTarget > edition.quota.maxItems ||
      edition.quota.primarySelected > edition.quota.primaryTarget || edition.quota.secondarySelected > edition.quota.maxItems - edition.quota.primaryTarget)
    throw new Error("Invalid personal edition contents or quota");
  if (new Set(edition.topics.map(t => t.id)).size !== edition.topics.length ||
      personalCanonical(edition.inputs.topicRevisions) !== personalCanonical(Object.fromEntries(edition.topics.map(t => [t.id, t.revisionId]))) ||
      new Set(edition.quota.secondaryOrder).size !== edition.quota.secondaryOrder.length ||
      edition.quota.secondaryOrder.some(id => !edition.topics.some(t => t.id === id)))
    throw new Error("Invalid personal edition topic references");
  for (const selected of edition.items) {
    validateCandidateTopics(selected.item, edition.topics, edition.cutoffAt);
    const assessment = selected.item.assessments.find(a => a.topicId === selected.assignedTopicId);
    const expectedScore = Math.round((0.5 * selected.score.relevance + 0.3 * selected.score.quality + 0.2 * selected.score.freshness + selected.score.preference) * 1000) / 1000;
    const updateKey = selected.item.verifiedUpdate ? `${selected.item.verifiedUpdate.kind}:${selected.item.eventId}:${selected.item.verifiedUpdate.updateKey}` : "initial";
    if (!assessment || !selected.matchedTopicIds.includes(selected.assignedTopicId) ||
        new Set(selected.matchedTopicIds).size !== selected.matchedTopicIds.length ||
        selected.matchedTopicIds.some(id => !selected.item.assessments.some(a => a.topicId === id)) ||
        selected.score.relevance !== assessment.relevance || selected.score.quality !== selected.item.quality || selected.score.total !== expectedScore ||
        selected.updateKey !== updateKey || (selected.update && !selected.item.verifiedUpdate) || (selected.recap && (!edition.firstEdition || edition.windowDays !== 7)))
      throw new Error("Invalid personal edition item references or explanation");
  }
  if (edition.contentHash !== personalHash(personalEditionContent(edition))) throw new Error("Personal edition content hash mismatch");
  return checkHash(edition, "editionId");
}
