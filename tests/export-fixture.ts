// Independent synthetic engine export; no sibling checkout, sources, models or private state.
import { createHash } from "node:crypto";
import { createMemberExport, type EngineTopicProfile, type MemberExport } from "../src/engine/member-export-contract";
import { createCandidateSnapshot, personalHash, type PersonalCandidate } from "../src/engine/personal-contract";

export const FIXTURE_NOW = "2026-09-26T08:00:00.000Z";
export const fixtureClone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function exportFixture(options: { revokeFirst?: boolean; profileName?: string } = {}): MemberExport {
  const topic = { id: "vla", name: options.profileName ?? "Synthetic VLA", enabled: true, priority: "P0" as const, weight: 1,
    keywords: ["VLA"], aliases: [], excludeKeywords: [], scope: "Synthetic vision language action methods",
    subtopics: [{ id: "policy", name: "Policy", keywords: ["policy"] }], relevanceThreshold: 70, radarLimit: 10 };
  const profiles: EngineTopicProfile[] = [{ protocol: "topic-profile-v1", revisionId: personalHash(topic), topic }];
  const reportDate = "2026-09-26", cutoffAt = "2026-09-26T07:00:00.000Z";
  const candidates = ["alpha", "beta"].map(name => {
    const evidenceText = `Synthetic ${name}: a vision language action policy improves robot control. Code is available.`;
    return { sourceItemId: `synthetic-${name}`, eventId: `event-${name}`, updateId: personalHash(`update-${name}`),
      contentHash: createHash("sha256").update(evidenceText).digest("hex"), sourceId: "synthetic-test",
      title: `Synthetic ${name} VLA policy`, url: `https://example.com/synthetic-${name}`, evidenceText,
      publishedAt: "2026-09-26T01:00:00.000Z", visible: true };
  });
  const rawBody = { schemaVersion: 1 as const, reportDate, candidates };
  const raw = { ...rawBody, rawBatchId: personalHash(rawBody) };
  const qualified = candidates.map(source => {
    const understood = { contentHash: source.contentHash, extractionVersion: "shared-facts-v1" as const, locale: "en" as const,
      summary: source.evidenceText, contentType: "paper" as const, claims: [{ text: source.evidenceText, quote: source.evidenceText }],
      codeStatus: "confirmed" as const, dataStatus: "unknown" as const, codeEvidence: "Code is available.", dataEvidence: "", model: "synthetic-worker" };
    const body = { sourceItemId: source.sourceItemId, eventId: source.eventId, updateId: source.updateId, contentHash: source.contentHash,
      url: source.url, sourceId: source.sourceId, summary: understood.summary, understood,
      assessments: [{ topicId: "vla", topicRevision: profiles[0].revisionId, relevance: 95, reason: "Direct synthetic action policy evidence",
        evidenceQuotes: [source.evidenceText], subtopicIds: ["policy"] }],
      review: { passed: true as const, score: 92, issues: [], evidenceSupported: true as const, model: "synthetic-reviewer", version: "shared-review-v2" as const }, revoked: false as const };
    return { ...body, revisionId: personalHash(body) };
  });
  const batchBody = { schemaVersion: 2 as const, reportDate, rawBatchId: raw.rawBatchId, policyHash: personalHash("synthetic-policy"),
    extractionVersion: "shared-facts-v1" as const, reviewVersion: "shared-review-v2" as const, topicRevisions: { vla: profiles[0].revisionId },
    status: "ready" as const, items: qualified, rejected: [] };
  const batch = { ...batchBody, batchId: personalHash(batchBody) };
  const revokedRevisionIds = options.revokeFirst ? [qualified[0].revisionId] : [];
  const items: PersonalCandidate[] = qualified.filter(item => !revokedRevisionIds.includes(item.revisionId)).map(item => {
    const source = candidates.find(c => c.sourceItemId === item.sourceItemId)!;
    return { revisionId: item.revisionId, sourceItemId: item.sourceItemId, contentHash: item.contentHash, eventId: item.eventId,
      updateId: item.updateId, title: source.title, summary: item.summary, url: item.url, sourceId: item.sourceId,
      publishedAt: source.publishedAt, observedOn: reportDate, contentType: item.understood.contentType,
      codeStatus: item.understood.codeStatus, dataStatus: item.understood.dataStatus, quality: item.review.score,
      primaryTopicId: "vla", secondaryTopicIds: [], evidence: item.understood.claims, assessments: item.assessments, verifiedUpdate: null };
  });
  const snapshot = createCandidateSnapshot({ schemaVersion: 1, reportDate, reportTimeZone: "UTC", cutoffAt, batchIds: [batch.batchId],
    policyRevisions: [batch.policyHash], topics: [{ id: topic.id, name: topic.name, revisionId: profiles[0].revisionId, scope: topic.scope,
      threshold: 70, subtopics: topic.subtopics.map(({ id, name }) => ({ id, name })) }], items, revokedRevisionIds, diagnostics: [] });
  return createMemberExport({ schemaVersion: 1, generatedAt: cutoffAt, catalogBatchId: batch.batchId, snapshot,
    batches: [{ batch, raw, profiles }], revokedRevisionIds });
}

/** Rehash tampered objects so boundary tests check semantic proof checks, not just outer hashes. */
export function rehashFixture(value: MemberExport): MemberExport {
  const copy = fixtureClone(value);
  const revisionMap = new Map<string, string>(), batchMap = new Map<string, string>();
  for (const proof of copy.batches) {
    const { rawBatchId: _rawId, ...rawBody } = proof.raw;
    proof.raw.rawBatchId = personalHash(rawBody);
    for (const item of proof.batch.items) {
      const { revisionId, ...body } = item;
      item.revisionId = personalHash(body); revisionMap.set(revisionId, item.revisionId);
    }
    const oldId = proof.batch.batchId;
    proof.batch.rawBatchId = proof.raw.rawBatchId;
    const { batchId: _batchId, ...batchBody } = proof.batch;
    proof.batch.batchId = personalHash(batchBody); batchMap.set(oldId, proof.batch.batchId);
  }
  copy.catalogBatchId = batchMap.get(copy.catalogBatchId) ?? copy.catalogBatchId;
  copy.snapshot.batchIds = copy.snapshot.batchIds.map(id => batchMap.get(id) ?? id);
  copy.snapshot.items = copy.snapshot.items.map(item => ({ ...item, revisionId: revisionMap.get(item.revisionId) ?? item.revisionId }));
  copy.revokedRevisionIds = copy.revokedRevisionIds.map(id => revisionMap.get(id) ?? id);
  copy.snapshot.revokedRevisionIds = copy.snapshot.revokedRevisionIds.map(id => revisionMap.get(id) ?? id);
  const { snapshotId: _snapshotId, ...snapshotBody } = copy.snapshot;
  copy.snapshot = createCandidateSnapshot(snapshotBody);
  const { exportId: _exportId, ...body } = copy;
  return { ...body, exportId: personalHash(body) };
}
