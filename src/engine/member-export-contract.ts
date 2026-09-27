// Shared engine -> Member Service trust boundary. Pure validation only: no model, I/O or network.
import { createHash } from "node:crypto";
import { z } from "zod";
import { createCandidateSnapshot, personalHash, personalCanonical, validateCandidateSnapshot, type PersonalCandidate } from "./personal-contract";

const Id = z.string().regex(/^[a-f0-9]{64}$/);
const TopicId = z.string().regex(/^[a-z0-9-]+$/).max(60);
const Text = z.string().min(1);
const DateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s);
const Keyword = z.string().trim().min(2).max(100);
const HttpUrl = z.string().url().refine(s => /^https?:\/\//i.test(s));
export const EngineTopicSchema = z.object({
  id: TopicId, name: z.string().trim().min(1).max(50), enabled: z.boolean(), priority: z.enum(["P0", "P1", "P2"]), weight: z.number().min(0).max(2),
  keywords: z.array(Keyword).min(1).max(40), aliases: z.array(Keyword).max(40), excludeKeywords: z.array(Keyword).max(40),
  scope: z.string().trim().min(1).max(1200).optional(), exclusions: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  positiveExamples: z.array(z.string().trim().min(1).max(300)).max(20).optional(), negativeExamples: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  subtopics: z.array(z.object({ id: TopicId, name: z.string().trim().min(1).max(60), keywords: z.array(Keyword).min(1).max(20) }).strict()).max(20)
    .refine(values => new Set(values.map(v => v.id)).size === values.length).optional(),
  relevanceThreshold: z.number().int().min(70).max(100).optional(), radarLimit: z.number().int().min(1).max(100).optional(),
}).strict();
export const EngineTopicProfileSchema = z.object({ revisionId: Id, protocol: z.literal("topic-profile-v1"), topic: EngineTopicSchema }).strict();
export type EngineTopicProfile = z.infer<typeof EngineTopicProfileSchema>;
const RawSchema = z.object({ sourceItemId: Text, eventId: Text, updateId: Id, contentHash: Id, sourceId: Text,
  title: z.string(), url: z.string(), evidenceText: z.string(), publishedAt: z.string().nullable(), visible: z.boolean() }).strict();
const UnderstoodSchema = z.object({ contentHash: Id, extractionVersion: z.literal("shared-facts-v1"), locale: z.enum(["zh", "en"]), summary: Text,
  contentType: z.enum(["paper", "repository", "research", "industry", "opinion", "video"]),
  claims: z.array(z.object({ text: Text, quote: Text }).strict()).min(1), codeStatus: z.enum(["confirmed", "absent", "unknown"]), dataStatus: z.enum(["confirmed", "absent", "unknown"]),
  codeEvidence: z.string(), dataEvidence: z.string(), model: Text }).strict();
const QualifiedSchema = z.object({ revisionId: Id, sourceItemId: Text, eventId: Text, updateId: Id, contentHash: Id, url: HttpUrl, sourceId: Text,
  summary: Text, understood: UnderstoodSchema,
  assessments: z.array(z.object({ topicId: TopicId, topicRevision: Id, relevance: z.number().min(0).max(100), reason: Text,
    evidenceQuotes: z.array(Text).optional(), subtopicIds: z.array(TopicId).optional() }).strict()).min(1),
  review: z.object({ passed: z.literal(true), score: z.number().min(80).max(100), issues: z.array(z.string()).max(0), evidenceSupported: z.literal(true), model: Text,
    version: z.literal("shared-review-v2") }).strict(), revoked: z.literal(false) }).strict();
const BatchSchema = z.object({ schemaVersion: z.literal(2), batchId: Id, reportDate: DateKey, rawBatchId: Id, policyHash: z.string().nullable(),
  extractionVersion: z.literal("shared-facts-v1"), reviewVersion: z.literal("shared-review-v2"), topicRevisions: z.record(TopicId, Id), status: z.literal("ready"),
  items: z.array(QualifiedSchema), rejected: z.array(z.object({ sourceItemId: Text, reason: Text }).strict()) }).strict();
const ProofSchema = z.object({ batch: BatchSchema, raw: z.object({ schemaVersion: z.literal(1), rawBatchId: Id, reportDate: DateKey, candidates: z.array(RawSchema) }).strict(),
  profiles: z.array(EngineTopicProfileSchema).min(1).max(12) }).strict();
export const MemberExportSchema = z.object({ schemaVersion: z.literal(1), exportId: Id, generatedAt: z.string().datetime({ offset: true }),
  catalogBatchId: Id, snapshot: z.unknown(), batches: z.array(ProofSchema).min(1).max(64), revokedRevisionIds: z.array(Id) }).strict();
export type MemberExport = Omit<z.infer<typeof MemberExportSchema>, "snapshot"> & { snapshot: ReturnType<typeof validateCandidateSnapshot> };
const shaText = (text: string) => createHash("sha256").update(text).digest("hex");
const contains = (text: string, quote: string) => {
  const normalize = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();
  return !!normalize(quote) && normalize(text).includes(normalize(quote));
};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function validateMemberExport(value: unknown): MemberExport {
  const parsed = MemberExportSchema.parse(value);
  const { exportId, ...body } = parsed;
  if (personalHash(body) !== exportId) throw new Error("Member export hash mismatch");
  const snapshot = validateCandidateSnapshot(parsed.snapshot);
  if (Date.parse(parsed.generatedAt) < Date.parse(snapshot.cutoffAt)) throw new Error("Export generated before its cutoff");
  if (new Set(parsed.batches.map(p => p.batch.batchId)).size !== parsed.batches.length ||
      personalCanonical(snapshot.batchIds) !== personalCanonical(parsed.batches.map(p => p.batch.batchId).sort(compare))) throw new Error("Export batch set mismatch");
  const catalog = parsed.batches.find(p => p.batch.batchId === parsed.catalogBatchId);
  if (!catalog || catalog.batch.reportDate > snapshot.reportDate) throw new Error("Missing current topic catalog proof");
  for (const { batch, raw, profiles } of parsed.batches) {
    const { batchId, ...batchBody } = batch;
    const { rawBatchId, ...rawBody } = raw;
    if (personalHash(batchBody) !== batchId || personalHash(rawBody) !== rawBatchId || batch.rawBatchId !== rawBatchId || batch.reportDate !== raw.reportDate)
      throw new Error("Shared batch/raw hash mismatch");
    if (new Set(profiles.map(p => p.topic.id)).size !== profiles.length ||
        personalCanonical(batch.topicRevisions) !== personalCanonical(Object.fromEntries(profiles.map(p => [p.topic.id, p.revisionId])))) throw new Error("Topic catalog proof mismatch");
    for (const profile of profiles) if (!profile.topic.enabled || profile.topic.weight <= 0 || personalHash(profile.topic) !== profile.revisionId) throw new Error("Invalid frozen topic profile");
    if (new Set(batch.items.map(i => i.revisionId)).size !== batch.items.length || new Set(raw.candidates.map(c => `${c.sourceItemId}:${c.contentHash}`)).size !== raw.candidates.length)
      throw new Error("Duplicate raw or qualified identity");
    for (const source of raw.candidates) if (shaText(source.evidenceText) !== source.contentHash) throw new Error("Source evidence content hash mismatch");
    for (const item of batch.items) {
      const { revisionId, ...itemBody } = item;
      const source = raw.candidates.find(c => c.sourceItemId === item.sourceItemId && c.contentHash === item.contentHash);
      if (personalHash(itemBody) !== revisionId || !source?.visible || source.url !== item.url || source.sourceId !== item.sourceId || source.eventId !== item.eventId || source.updateId !== item.updateId ||
          item.understood.contentHash !== item.contentHash || item.summary !== item.understood.summary) throw new Error("Qualified revision is not bound to visible evidence");
      if (item.understood.claims.some(c => !contains(source.evidenceText, c.quote)) ||
          (item.understood.codeStatus !== "unknown" && !contains(source.evidenceText, item.understood.codeEvidence)) ||
          (item.understood.dataStatus !== "unknown" && !contains(source.evidenceText, item.understood.dataEvidence))) throw new Error("Unsupported shared fact evidence");
      if (item.assessments.length !== profiles.length || new Set(item.assessments.map(a => a.topicId)).size !== profiles.length) throw new Error("Incomplete shared topic review");
      for (const a of item.assessments) {
        const profile = profiles.find(p => p.topic.id === a.topicId);
        if (!profile || a.topicRevision !== profile.revisionId || (a.relevance >= 70 && !a.evidenceQuotes?.length) ||
            a.evidenceQuotes?.some(q => !contains(source.evidenceText, q)) || a.subtopicIds?.some(id => !profile.topic.subtopics?.some(s => s.id === id)))
          throw new Error("Unsupported topic assessment");
      }
    }
  }
  const topics = catalog.profiles.map(({ topic, revisionId }) => ({ id: topic.id, revisionId, name: topic.name, scope: topic.scope || "",
    threshold: topic.relevanceThreshold ?? 70, subtopics: (topic.subtopics || []).map(({ id, name }) => ({ id, name })) }));
  const revocations = new Set(parsed.revokedRevisionIds);
  const expectedRevoked: string[] = [];
  const diagnostics: typeof snapshot.diagnostics = [];
  const candidates = new Map<string, PersonalCandidate>();
  for (const { batch, raw } of parsed.batches) {
    expectedRevoked.push(...batch.items.filter(i => revocations.has(i.revisionId)).map(i => i.revisionId));
    if (personalCanonical(batch.topicRevisions) !== personalCanonical(catalog.batch.topicRevisions) || batch.reportDate > snapshot.reportDate) {
      diagnostics.push({ revisionId: null, reason: `incompatible-or-future-batch:${batch.batchId}` }); continue;
    }
    for (const item of batch.items.filter(i => !revocations.has(i.revisionId))) {
      const source = raw.candidates.find(c => c.sourceItemId === item.sourceItemId && c.contentHash === item.contentHash)!;
      const assessments = item.assessments.filter(a => a.relevance >= (topics.find(t => t.id === a.topicId)?.threshold ?? 101))
        .map(a => ({ ...a, evidenceQuotes: a.evidenceQuotes || [], subtopicIds: a.subtopicIds || [] })).sort((a, b) => b.relevance - a.relevance || compare(a.topicId, b.topicId));
      if (!assessments.length) { diagnostics.push({ revisionId: item.revisionId, reason: "below-configured-topic-threshold" }); continue; }
      const verifiedUpdate = snapshot.items.find(c => c.revisionId === item.revisionId)?.verifiedUpdate || null;
      if (verifiedUpdate && !contains(source.evidenceText, verifiedUpdate.evidenceQuote)) throw new Error("Unsupported update evidence");
      const candidate: PersonalCandidate = { revisionId: item.revisionId, sourceItemId: item.sourceItemId, contentHash: item.contentHash,
        eventId: item.eventId, updateId: item.updateId, title: source.title, summary: item.summary, url: item.url, sourceId: item.sourceId,
        publishedAt: source.publishedAt, observedOn: batch.reportDate, contentType: item.understood.contentType,
        codeStatus: item.understood.codeStatus, dataStatus: item.understood.dataStatus, quality: item.review.score,
        primaryTopicId: assessments[0].topicId, secondaryTopicIds: assessments.slice(1).map(a => a.topicId), evidence: item.understood.claims, assessments, verifiedUpdate };
      if (!candidates.has(item.revisionId) || candidates.get(item.revisionId)!.observedOn > candidate.observedOn) candidates.set(item.revisionId, candidate);
    }
  }
  const rebuilt = createCandidateSnapshot({ schemaVersion: 1, reportDate: snapshot.reportDate, reportTimeZone: snapshot.reportTimeZone, cutoffAt: snapshot.cutoffAt,
    batchIds: parsed.batches.map(p => p.batch.batchId), policyRevisions: parsed.batches.map(p => p.batch.policyHash ?? "unversioned-policy"),
    topics, items: [...candidates.values()], revokedRevisionIds: expectedRevoked, diagnostics });
  if (rebuilt.snapshotId !== snapshot.snapshotId) throw new Error("Candidate snapshot does not reproduce qualified export proof");
  return { ...parsed, snapshot };
}

export function createMemberExport(body: Omit<MemberExport, "exportId">): MemberExport {
  return validateMemberExport({ ...body, exportId: personalHash(body) });
}
