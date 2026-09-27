import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/db";
import type { AuthContext, MemberRole } from "../src/auth";
import { ContentError, ContentService, type TopicProfile, type VerifiedExport } from "../src/content";
import { createCandidateSnapshot, personalHash, type PersonalCandidate } from "../src/engine/personal-contract";

const NOW = "2026-09-26T08:00:00.000Z";
const H = (name: string) => personalHash(name);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function profiles(): TopicProfile[] {
  return ["vla", "agent"].map(id => {
    const topic = { id, name: id.toUpperCase(), enabled: true, priority: "P0" as const, weight: 1,
      keywords: [id], aliases: [], excludeKeywords: [], scope: `Synthetic ${id} research`,
      subtopics: [{ id: "methods", name: "Methods", keywords: ["method"] }], relevanceThreshold: 70, radarLimit: 10 };
    return { protocol: "topic-profile-v1", revisionId: personalHash(topic), topic };
  });
}
function fixture(catalog = profiles(), options: { date?: string; cutoff?: string; revocations?: string[]; marker?: string } = {}): VerifiedExport {
  const date = options.date ?? "2026-09-26", cutoff = options.cutoff ?? `${date}T07:00:00.000Z`;
  const items: PersonalCandidate[] = [["vla", ["vla"]], ["overlap", ["vla", "agent"]], ["agent", ["agent"]]].map(([name, ids]) => {
    const selected = (ids as string[]).filter(id => catalog.some(p => p.topic.id === id));
    if (!selected.length) return null;
    return { revisionId: H(`qualified-${name}`), eventId: `event-${name}`, updateId: H(`update-${name}`), title: `Synthetic ${name} method`,
      summary: `Synthetic evidence for ${name}`, url: `https://example.com/${name}`, sourceId: "synthetic",
      sourceItemId: `source-${name}`, contentHash: H(`content-${name}`), observedOn: date, verifiedUpdate: null,
      publishedAt: `${date}T01:00:00.000Z`, contentType: "paper", codeStatus: "confirmed", dataStatus: "unknown", quality: 95,
      primaryTopicId: selected[0], secondaryTopicIds: selected.slice(1), evidence: [{ text: "A reproducible synthetic method", quote: `Synthetic original ${name}` }],
      assessments: selected.map(id => ({ topicId: id, topicRevision: catalog.find(p => p.topic.id === id)!.revisionId, relevance: 95,
        reason: `Direct synthetic ${id} contribution`, evidenceQuotes: [`Synthetic original ${name}`], subtopicIds: ["methods"] })) } as PersonalCandidate;
  }).filter((item): item is PersonalCandidate => !!item);
  const snapshot = createCandidateSnapshot({ schemaVersion: 1, reportDate: date, reportTimeZone: "UTC", cutoffAt: cutoff,
    batchIds: [H(`batch-${date}-${options.marker ?? "default"}`)], policyRevisions: ["synthetic-policy"],
    topics: catalog.map(p => ({ id: p.topic.id, name: p.topic.name, revisionId: p.revisionId, scope: p.topic.scope ?? "",
      subtopics: p.topic.subtopics!.map(s => ({ id: s.id, name: s.name })), threshold: p.topic.relevanceThreshold ?? 70 })),
    items, revokedRevisionIds: [], diagnostics: [{ revisionId: H("hidden-diagnostic"), reason: "private-internal-diagnostic" }] });
  const body = { generatedAt: cutoff, snapshot, profiles: catalog, revokedRevisionIds: options.revocations ?? [], catalogBatchId: snapshot.batchIds[0], rawBatchId: H(`raw-${date}-${options.marker ?? "default"}`) };
  return { ...body, exportId: personalHash(body) };
}
function actor(store: Store, userId: string, role: MemberRole = "member", options: { reads?: string[]; owns?: string[] } = {}): AuthContext {
  const user = { userId, email: `${userId}@example.com`, displayName: userId, status: "active" as const, role, revision: 1,
    ownedTopicIds: options.owns ?? [], readTopicIds: options.reads ?? ["*"] };
  store.db.prepare("INSERT INTO users(id,email,display_name,status,role,revision,owned_topic_ids,read_topic_ids,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(userId, user.email, user.displayName, user.status, role, 1, JSON.stringify(user.ownedTopicIds), JSON.stringify(user.readTopicIds), 0, 0);
  store.db.prepare("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)")
    .run(`synthetic-session-${userId}`, userId, H(`synthetic-session-${userId}`), Date.parse(NOW), Date.parse(NOW), Date.parse(NOW) + 86400000);
  return { user, sessionId: `synthetic-session-${userId}`, csrfToken: "synthetic-csrf", expiresAt: Date.parse(NOW) + 86400000 };
}
function harness(path = ":memory:") {
  const store = new Store(path), time = { value: Date.parse(NOW) };
  const service = new ContentService(store, { now: () => new Date(time.value), verifyExport: value => clone(value as VerifiedExport) });
  return { store, service, time, advance: () => { time.value += 1000; }, member: actor(store, "member"), other: actor(store, "other"), admin: actor(store, "admin", "lab_owner") };
}
function prefs(primaryTopicId = "vla", secondaryTopicIds = ["agent"]) { return { primaryTopicId, secondaryTopicIds, keywords: [], excludeKeywords: [], subtopicIds: {}, codeOnly: false }; }
function save(service: ContentService, user: AuthContext, preferences = prefs()) {
  return service.putPreferences(user, { baseRevision: service.getPreferences(user).revision, preferences });
}
function status(expected: number, code?: string) { return (error: unknown) => error instanceof ContentError && error.status === expected && (!code || error.code === code); }
function count(store: Store, table: string) { return Number((store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n); }

test("verified import is atomic, immutable, idempotent, and chooses chronological readiness", () => {
  const h = harness();
  try {
    const rejected = new ContentService(h.store, { now: () => new Date(NOW), verifyExport: () => { throw new Error("synthetic rejected proof"); } });
    assert.throws(() => rejected.importExport(fixture()), status(400, "invalid_export"));
    assert.equal(count(h.store, "content_ready"), 0); assert.equal(count(h.store, "content_topics"), 0);
    const payload = fixture(); assert.equal(h.service.importExport(payload).idempotent, false);
    assert.equal(h.service.radar(h.member).batchId, payload.catalogBatchId);
    assert.equal(h.service.radar(h.member).rawBatchId, payload.rawBatchId);
    assert.equal(h.service.importExport(payload).idempotent, true);
    const mutation = { ...payload, generatedAt: "2026-09-26T07:01:00.000Z" };
    assert.throws(() => h.service.importExport(mutation), status(409, "immutable_import"));
    assert.equal(count(h.store, "content_ready"), 1);
    const older = fixture(profiles(), { date: "2026-09-25" }); h.service.importExport(older);
    assert.equal(h.service.radar(h.member).items[0].publishedAt, "2026-09-26T01:00:00.000Z");
    assert.throws(() => h.service.importExport(fixture(profiles(), { date: "2026-09-27" })), status(400, "future_export"));
    assert.equal(count(h.store, "content_ready"), 2);
    const changed = profiles(); changed[0].topic.name = "Changed"; changed[0].revisionId = personalHash(changed[0].topic);
    assert.throws(() => h.service.importExport(fixture(changed)), status(409, "catalog_changed"));
    assert.equal(count(h.store, "content_ready"), 2); assert.equal(h.service.catalog().profiles.find(p => p.topic.id === "vla")!.topic.name, "VLA");
  } finally { h.store.close(); }
});

test("subscriptions preserve full settings, ownership, optimistic revisions and strict request fields", () => {
  const h = harness();
  try {
    h.service.importExport(fixture());
    assert.equal(h.service.getPreferences(h.member).revision, "initial");
    const first = save(h.service, h.member);
    assert.throws(() => h.service.putPreferences(h.member, { baseRevision: "initial", preferences: prefs() }), status(409));
    assert.equal(h.service.getPreferences(h.other).revision, "initial");
    assert.throws(() => h.service.putPreferences(h.member, { baseRevision: first.revision, preferences: prefs(), memberId: "other" }));
    const subscription = h.service.getSubscription(h.member).subscription!;
    const { schemaVersion: _s, memberId: _m, effectiveAt: _e, revisionId: _r, ...settings } = subscription;
    const second = h.service.putSubscription(h.member, { baseRevision: first.revision, subscription: { ...settings, frequency: "paused", maxItems: 4, preferOpenSource: true } });
    assert.equal(second.subscription.memberId, "member");
    h.advance();
    const third = h.service.putPreferences(h.member, { baseRevision: second.revision, preferences: { ...prefs(), keywords: ["method"] } });
    assert.notEqual(third.revision, second.revision);
    assert.equal(h.service.getSubscription(h.member).subscription!.frequency, "paused");
    assert.equal(h.service.getSubscription(h.member).subscription!.maxItems, 4);
    assert.equal(h.service.getSubscription(h.member).subscription!.preferOpenSource, true);
    assert.equal(count(h.store, "content_subscriptions"), 3);
  } finally { h.store.close(); }
});

test("read ACL prunes overlapping assessments; server refreshes roles and denies viewer writes", () => {
  const h = harness();
  try {
    h.service.importExport(fixture());
    const limited = actor(h.store, "limited", "member", { reads: ["vla"] });
    const radar = h.service.radar(limited);
    assert.deepEqual(radar.topics.map(t => t.id), ["vla"]);
    assert.deepEqual(radar.items.map(i => i.eventId).sort(), ["event-overlap", "event-vla"]);
    assert(radar.items.every(i => i.primaryTopicId === "vla" && i.secondaryTopicIds.length === 0 && i.assessments.every(a => a.topicId === "vla")));
    assert(!JSON.stringify(radar).includes("private-internal-diagnostic"));
    assert.throws(() => save(h.service, limited, prefs()), status(409, "topics_changed"));
    save(h.service, limited, prefs("vla", []));
    h.store.db.prepare("UPDATE users SET role='viewer',revision=revision+1 WHERE id='limited'").run();
    assert.throws(() => save(h.service, limited, prefs("vla", [])), status(403, "read_only"));
    assert.equal(h.service.preview(limited).edition.items.length, 2);
    assert.throws(() => h.service.createEdition(limited, { requestId: "viewer-denied" }), status(403));
    assert.throws(() => h.service.feedback(limited, { targetEventId: "event-vla", kind: "saved" }), status(403));
    h.store.db.prepare("UPDATE users SET status='disabled' WHERE id='limited'").run();
    assert.throws(() => h.service.radar(limited), status(401));
    h.store.db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id='member'").run(Date.parse(NOW));
    assert.throws(() => save(h.service, h.member), status(401, "session_expired"));
  } finally { h.store.close(); }
});

test("topic owner can edit only assigned topics; changed catalog hides stale candidates until reprocessing", () => {
  const h = harness();
  try {
    const payload = fixture(); h.service.importExport(payload);
    const owner = actor(h.store, "topic-owner", "topic_owner", { owns: ["vla"] });
    const vla = payload.profiles.find(p => p.topic.id === "vla")!, agent = payload.profiles.find(p => p.topic.id === "agent")!;
    assert.throws(() => h.service.putTopic(owner, "agent", { baseRevision: agent.revisionId, profile: { ...agent.topic, name: "No" } }), status(403));
    assert.throws(() => h.service.putTopic(h.member, "vla", { baseRevision: vla.revisionId, profile: vla.topic }), status(403));
    const next = h.service.putTopic(owner, "vla", { baseRevision: vla.revisionId, profile: { ...vla.topic, name: "VLA updated" } });
    assert.equal(next.reprocessingRequired, true);
    assert.throws(() => h.service.putTopic(owner, "vla", { baseRevision: vla.revisionId, profile: vla.topic }), status(409));
    assert.throws(() => h.service.radar(h.member), status(503, "content_unavailable"));
    const newProfiles = payload.profiles.map(p => p.topic.id === "vla" ? next.profile : p);
    h.service.importExport(fixture(newProfiles));
    assert.equal(h.service.radar(h.member).topics.find(t => t.id === "vla")!.name, "VLA updated");
    h.service.deleteTopic(owner, "vla", { baseRevision: next.profile.revisionId });
    assert.throws(() => h.service.deleteTopic(h.admin, "agent", { baseRevision: agent.revisionId }), status(400, "empty_catalog"));
    assert.throws(() => h.service.radar(h.member), status(503));
  } finally { h.store.close(); }
});

test("preview never enters history; official editions are own-only, transactional, replayable, idempotent and deduplicated", () => {
  const h = harness(); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Content service must never call models or notifications"); };
  try {
    h.service.importExport(fixture()); save(h.service, h.member); save(h.service, h.other);
    const preview = h.service.preview(h.member); assert.equal(preview.edition.items.length, 3);
    assert.equal(count(h.store, "content_editions"), 0); assert.equal(preview.finalized, false);
    assert(!("diagnostics" in preview.edition));
    h.store.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON content_edition_requests BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    assert.throws(() => h.service.createEdition(h.member, { requestId: "failed-request" }), /synthetic failure/);
    assert.equal(count(h.store, "content_editions"), 0);
    h.store.db.exec("DROP TRIGGER synthetic_failure");
    const result = h.service.createEdition(h.member, { requestId: "first-request" });
    assert.equal(result.finalized, true); assert.equal(count(h.store, "content_editions"), 1);
    assert.equal(h.service.createEdition(h.member, { requestId: "first-request" }).edition.editionId, result.edition.editionId);
    assert.equal(h.service.edition(h.member, result.edition.editionId).edition.contentHash, result.edition.contentHash);
    assert.throws(() => h.service.edition(h.other, result.edition.editionId), status(404));
    assert.throws(() => h.service.edition(h.admin, result.edition.editionId), status(404));
    assert.equal(h.service.listEditions(h.other).editions.length, 0);
    h.advance();
    const after = h.service.preview(h.member); assert.equal(after.edition.items.length, 0); assert.equal(after.edition.status, "no-content");
    assert.equal(h.service.preview(h.other).edition.items.length, 3);
    const empty = h.service.createEdition(h.member, { requestId: "empty-request" }); assert.equal(empty.finalized, false);
    assert.equal(count(h.store, "content_editions"), 2);
  } finally { globalThis.fetch = originalFetch; h.store.close(); }
});

test("feedback takes effect at current cutoff and retracts only the same member's visible event feedback", () => {
  const h = harness();
  try {
    h.service.importExport(fixture()); save(h.service, h.member); save(h.service, h.other);
    const before = h.service.preview(h.member).edition.items.find(i => i.item.eventId === "event-vla")!.score.total;
    h.advance();
    const saved = h.service.feedback(h.member, { kind: "saved", targetEventId: "event-vla" });
    assert(h.service.preview(h.member).edition.items.find(i => i.item.eventId === "event-vla")!.score.total > before);
    const ignored = h.service.feedback(h.member, { kind: "not-relevant", targetEventId: "event-vla" });
    assert(!h.service.preview(h.member).edition.items.some(i => i.item.eventId === "event-vla"));
    assert.throws(() => h.service.feedback(h.other, { kind: "retract", targetEventId: "event-vla", retractsFeedbackId: ignored.feedbackId }), status(404));
    h.service.feedback(h.member, { kind: "retract", targetEventId: "event-vla", retractsFeedbackId: ignored.feedbackId });
    assert(h.service.preview(h.member).edition.items.some(i => i.item.eventId === "event-vla"));
    assert.throws(() => h.service.feedback(h.member, { kind: "retract", targetEventId: "event-agent", retractsFeedbackId: saved.feedbackId }), status(404));
    assert.throws(() => h.service.feedback(h.member, { kind: "saved", targetEventId: "private-unknown-event" }), status(404));
    const limited = actor(h.store, "limited", "member", { reads: ["vla"] });
    assert.throws(() => h.service.feedback(limited, { kind: "read", targetEventId: "event-agent" }), status(404));
  } finally { h.store.close(); }
});

test("current revocations affect radar, preview and stored editions; history remains immutable", () => {
  const h = harness();
  try {
    h.service.importExport(fixture()); save(h.service, h.member); save(h.service, h.other);
    const edition = h.service.createEdition(h.member, { requestId: "before-revoke" });
    const revisionId = edition.edition.items[0].item.revisionId;
    assert.throws(() => h.service.revoke(h.other, { revisionId, reason: "synthetic" }), status(403));
    h.service.revoke(h.admin, { revisionId, reason: "Synthetic source correction" });
    assert(!h.service.radar(h.member).items.some(i => i.revisionId === revisionId));
    assert(!h.service.preview(h.other).edition.items.some(i => i.item.revisionId === revisionId));
    assert.throws(() => h.service.edition(h.member, edition.edition.editionId), status(410));
    assert.equal(h.service.listEditions(h.member).editions.length, 0);
    assert.equal(count(h.store, "content_editions"), 1);
    const raw = h.store.db.prepare("SELECT edition_json FROM content_editions WHERE edition_id=?").get(edition.edition.editionId) as { edition_json: string };
    assert(JSON.parse(raw.edition_json).items.some((i: any) => i.item.revisionId === revisionId));
    h.advance(); assert.equal(h.service.preview(h.member).edition.items.length, 0);
    h.service.importExport(fixture(profiles(), { marker: "new-import", revocations: [H("qualified-agent")] }));
    assert(!h.service.radar(h.other).items.some(i => i.eventId === "event-agent"));
  } finally { h.store.close(); }
});

test("subscriptions and immutable editions persist across database restart without public/private mixing", () => {
  const directory = mkdtempSync(join(tmpdir(), "feishubrief-content-test-")), path = join(directory, "member.sqlite");
  let store: Store | undefined;
  try {
    const h = harness(path); store = h.store; h.service.importExport(fixture()); const subscription = save(h.service, h.member);
    const edition = h.service.createEdition(h.member, { requestId: "persistent-edition" });
    store.close(); store = new Store(path);
    const reopened = new ContentService(store, { now: () => new Date(NOW), verifyExport: value => value as VerifiedExport });
    assert.equal(reopened.getPreferences(h.member).revision, subscription.revision);
    assert.equal(reopened.edition(h.member, edition.edition.editionId).edition.editionId, edition.edition.editionId);
    assert.equal(reopened.listEditions(h.other).editions.length, 0);
  } finally {
    store?.close();
    assert(resolve(directory).startsWith(resolve(join(tmpdir(), "feishubrief-content-test-"))), "Cleanup must stay in the generated test directory");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verified revocations apply while catalog reprocessing is pending without making stale exports ready", () => {
  const h = harness();
  try {
    const original = fixture(); h.service.importExport(original); save(h.service, h.member);
    const edition = h.service.createEdition(h.member, { requestId: "revoke-pending-catalog" });
    const vla = original.profiles.find(p => p.topic.id === "vla")!;
    h.service.putTopic(h.admin, "vla", { baseRevision: vla.revisionId, profile: { ...vla.topic, scope: "Synthetic expanded VLA scope" } });
    const revocation = fixture(original.profiles, { revocations: [edition.edition.items[0].item.revisionId], marker: "revoked" });
    assert.throws(() => h.service.importExport(revocation), status(409, "catalog_changed"));
    assert.equal(count(h.store, "content_revocations"), 0);
    assert.equal(h.service.importRevocations(revocation).applied, 1);
    assert.equal(h.service.importRevocations(revocation).applied, 0);
    assert.equal(count(h.store, "content_ready"), 1); assert.equal(count(h.store, "content_snapshots"), 1);
    assert.throws(() => h.service.edition(h.member, edition.edition.editionId), status(410));
    assert.throws(() => h.service.radar(h.member), status(503));
    assert.equal(h.service.catalog().profiles.find(p => p.topic.id === "vla")!.topic.scope, "Synthetic expanded VLA scope");
  } finally { h.store.close(); }
});

test("draft preview works before saving, respects topic ACL and never writes subscriptions, history or feedback", () => {
  const h = harness(), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Draft previews cannot contact models or delivery services"); };
  try {
    h.service.importExport(fixture());
    const draft = h.service.getSubscription(h.member).defaults!;
    const first = h.service.preview(h.member, { subscription: { ...draft, primaryTopicId: "vla", secondaryTopicIds: [], maxItems: 1 } });
    assert.equal(first.draft, true); assert.equal(first.finalized, false); assert.equal(first.edition.items.length, 1);
    assert.equal(first.edition.memberId, h.member.user.userId); assert.equal(first.edition.externalSendAllowed, false);
    for (const table of ["content_subscriptions", "content_preferences", "content_editions", "content_feedback"]) assert.equal(count(h.store, table), 0);
    const limited = actor(h.store, "limited-preview", "member", { reads: ["vla"] });
    assert.throws(() => h.service.preview(limited, { subscription: { ...draft, primaryTopicId: "agent" } }), status(409, "topics_changed"));
    assert.throws(() => h.service.preview(h.member, { subscription: draft, memberId: "other" }));
    const saved = save(h.service, h.member);
    assert.throws(() => h.service.preview(h.member, { subscription: draft, subscriptionRevisionId: saved.revision }));
    assert.equal(h.service.preview(h.member, { subscriptionRevisionId: saved.revision }).draft, false);
    assert.equal(h.service.getPreferences(h.member).revision, saved.revision);
    assert.equal(count(h.store, "content_editions"), 0);
  } finally { globalThis.fetch = originalFetch; h.store.close(); }
});

test("feedback state retracts each active event and library retains only own readable saved history", () => {
  const h = harness();
  try {
    const initial = fixture(); h.service.importExport(initial); save(h.service, h.member);
    h.service.createEdition(h.member, { requestId: "library-original" });
    const one = h.service.feedback(h.member, { kind: "saved", targetEventId: "event-vla" });
    const two = h.service.feedback(h.member, { kind: "saved", targetEventId: "event-vla" });
    const read = h.service.feedback(h.member, { kind: "read", targetEventId: "event-vla" });
    h.service.feedback(h.member, { kind: "not-relevant", targetEventId: "event-agent" });
    let feedback = h.service.getFeedback(h.member);
    assert.equal(feedback.items.find(i => i.eventId === "event-vla")!.saved, true);
    assert.equal(feedback.items.find(i => i.eventId === "event-vla")!.read, true);
    assert.equal(feedback.items.find(i => i.eventId === "event-agent")!.notRelevant, true);
    assert.equal(h.service.getFeedback(h.other).items.length, 0);
    const current = h.service.library(h.member);
    assert.equal(current.currentAvailable, true); assert.equal(current.items.length, 3);
    assert.equal(new Set(current.items.map(i => i.item.eventId)).size, current.items.length);
    assert(current.items.every(i => !("sourceItemId" in i.item) && !("contentHash" in i.item) && !("diagnostics" in i.item)));
    const vla = initial.profiles.find(p => p.topic.id === "vla")!;
    h.service.putTopic(h.admin, "vla", { baseRevision: vla.revisionId, profile: { ...vla.topic, scope: "Synthetic new catalog awaiting reprocessing" } });
    const historical = h.service.library(h.member);
    assert.equal(historical.currentAvailable, false);
    assert.deepEqual(historical.items.map(i => i.item.eventId), ["event-vla"]);
    assert.equal(historical.items[0].origin, "saved-history");
    assert.equal(h.service.library(h.other).items.length, 0);
    h.service.feedback(h.member, { kind: "retract", targetEventId: "event-vla", retractsFeedbackId: one.feedbackId });
    assert.equal(h.service.getFeedback(h.member).items.find(i => i.eventId === "event-vla")!.saved, true);
    h.service.feedback(h.member, { kind: "retract", targetEventId: "event-vla", retractsFeedbackId: two.feedbackId });
    assert.equal(h.service.library(h.member).items.length, 0);
    feedback = h.service.getFeedback(h.member);
    assert.equal(feedback.items.find(i => i.eventId === "event-vla")!.saved, false);
    assert.deepEqual(feedback.items.find(i => i.eventId === "event-vla")!.feedback.map(i => i.feedbackId), [read.feedbackId]);
  } finally { h.store.close(); }
});

test("library and feedback enforce current per-item revocation and ACL even in mixed historical editions", () => {
  const h = harness();
  try {
    const initial = fixture(); h.service.importExport(initial); save(h.service, h.member);
    h.service.createEdition(h.member, { requestId: "library-access" });
    h.service.feedback(h.member, { kind: "saved", targetEventId: "event-vla" });
    h.service.feedback(h.member, { kind: "saved", targetEventId: "event-agent" });
    const vla = initial.profiles.find(p => p.topic.id === "vla")!;
    h.service.putTopic(h.admin, "vla", { baseRevision: vla.revisionId, profile: { ...vla.topic, name: "Synthetic renamed VLA" } });
    h.service.revoke(h.admin, { revisionId: H("qualified-vla"), reason: "Synthetic correction" });
    assert.deepEqual(h.service.library(h.member).items.map(i => i.item.eventId), ["event-agent"]);
    assert.deepEqual(h.service.getFeedback(h.member).items.map(i => i.eventId), ["event-agent"]);
    h.service.feedback(h.member, { kind: "read", targetEventId: "event-agent" });
    assert.equal(h.service.getFeedback(h.member).items[0].read, true);
    assert.throws(() => h.service.feedback(h.member, { kind: "read", targetEventId: "event-vla" }), status(404));
    h.store.db.prepare("UPDATE users SET read_topic_ids='[\"vla\"]' WHERE id='member'").run();
    assert.equal(h.service.library(h.member).items.length, 0); assert.equal(h.service.getFeedback(h.member).items.length, 0);
  } finally { h.store.close(); }
});

test("operations exposes only owner aggregates and capabilities accurately mark personal sending and scheduling unavailable", () => {
  const h = harness();
  try {
    h.service.importExport(fixture()); save(h.service, h.member);
    const edition = h.service.createEdition(h.member, { requestId: "operations-private" });
    const caps = h.service.capabilities(h.member);
    assert.equal(caps.personalDelivery.enabled, false); assert.deepEqual(caps.personalDelivery.channels, []); assert.equal(caps.scheduler.enabled, false);
    assert.throws(() => h.service.operations(h.member), status(403));
    const owner = actor(h.store, "topic-ops", "topic_owner", { owns: ["vla"] });
    assert.throws(() => h.service.operations(owner), status(403));
    const operations = h.service.operations(h.admin);
    assert.equal(operations.content.readyImports, 1); assert.equal(operations.assembly.officialEditions, 1);
    assert.equal(operations.assembly.membersWithEditions, 1); assert.equal(operations.assembly.status, "on-demand");
    assert.equal(operations.delivery.enabled, false); assert.deepEqual(operations.delivery.records, []);
    const serialized = JSON.stringify(operations);
    assert(!serialized.includes(edition.edition.editionId)); assert(!serialized.includes(edition.edition.items[0].item.title));
    assert(!serialized.includes("subscription")); assert(!serialized.includes("memberId")); assert(!serialized.includes("email"));
    assert.equal(operations.content.latestImports[0].status, "ready");
    assert.equal(operations.content.currentCatalogReady, true); assert.equal(operations.content.latestImports[0].catalogCurrent, true);
    const profile = h.service.catalog().profiles[0];
    h.service.putTopic(h.admin, profile.topic.id, { baseRevision: profile.revisionId, profile: { ...profile.topic, name: "Synthetic changed topic" } });
    assert.equal(h.service.operations(h.admin).content.currentCatalogReady, false);
    assert.equal(h.service.operations(h.admin).content.latestImports[0].catalogCurrent, false);
  } finally { h.store.close(); }
});
