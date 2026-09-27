// Deterministic Phase 3 assembler. No I/O, model, delivery, environment or current-clock dependency.
import {
  createPersonalEdition, validateCandidateSnapshot, validateFeedbackSnapshot, validateHistorySnapshot, validateSubscriptionRevision,
  type CandidateSnapshot, type FeedbackSnapshot, type HistorySnapshot, type PersonalCandidate,
  type PersonalEdition, type PersonalEditionItem, type SubscriptionRevision,
} from "./personal-contract";

export type PersonalAssemblyInput = {
  candidates: CandidateSnapshot; subscription: SubscriptionRevision; feedback: FeedbackSnapshot; history: HistorySnapshot;
};
const DAY = 86_400_000;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const dayNumber = (key: string) => Date.parse(key) / DAY;
const dayKey = (number: number) => new Date(number * DAY).toISOString().slice(0, 10);
const round = (value: number) => Math.round(value * 1000) / 1000;

function dateInZone(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  return ["year", "month", "day"].map(type => parts.find(p => p.type === type)!.value).join("-");
}
function matches(text: string, word: string) {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  const value = normalize(word);
  return /^[\x00-\x7f]+$/.test(value)
    ? new RegExp(`(?:^|[^a-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s)?(?:$|[^a-z0-9])`, "i").test(normalize(text))
    : normalize(text).includes(value);
}
export function semanticUpdateKey(item: PersonalCandidate): string {
  return item.verifiedUpdate ? `${item.verifiedUpdate.kind}:${item.eventId}:${item.verifiedUpdate.updateKey}` : "initial";
}

type Eligible = {
  item: PersonalCandidate; matchedTopicIds: string[]; hitKeywords: string[];
  freshness: number; preference: number; saved: boolean; ageDays: number; update: boolean; effectiveTime: number;
};

export function assemblePersonalEdition(input: PersonalAssemblyInput): PersonalEdition {
  const candidates = validateCandidateSnapshot(input.candidates);
  const subscription = validateSubscriptionRevision(input.subscription);
  const feedback = validateFeedbackSnapshot(input.feedback);
  const history = validateHistorySnapshot(input.history);
  const cutoff = Date.parse(candidates.cutoffAt);
  const reportDay = dayNumber(candidates.reportDate);
  if (feedback.memberId !== subscription.memberId || history.memberId !== subscription.memberId)
    throw new Error("Personal inputs belong to different members");
  if (Date.parse(feedback.cutoffAt) !== cutoff || Date.parse(history.cutoffAt) !== cutoff)
    throw new Error("Personal inputs must share one cutoff");
  if (Date.parse(subscription.effectiveAt) > cutoff) throw new Error("Subscription is not effective at cutoff");
  if (dateInZone(candidates.cutoffAt, candidates.reportTimeZone) !== candidates.reportDate)
    throw new Error("Report date must match cutoff in the explicit report timezone");
  if (history.receipts.some(r => r.reportDate > candidates.reportDate)) throw new Error("Official history is after report date");

  const subscribed = [subscription.primaryTopicId, ...subscription.secondaryTopicIds];
  if (subscribed.some(id => !candidates.topics.some(t => t.id === id)) || Object.entries(subscription.subtopicIds).some(([id, values]) =>
    !subscribed.includes(id) || values.some(value => !candidates.topics.find(t => t.id === id)?.subtopics.some(s => s.id === value))))
    throw new Error("Subscription topic or subtopic is unavailable in the frozen catalog");

  const firstEdition = history.receipts.length === 0;
  // Retain unseen qualified backlog and missed workdays for seven calendar days; official history prevents repeats.
  const windowDays = firstEdition ? subscription.firstEditionLookbackDays : 7;
  const windowStartDate = dayKey(reportDay - windowDays + 1);
  const primaryTarget = Math.ceil(subscription.maxItems * subscription.primaryShare);
  const secondaryCounts = new Map(subscription.secondaryTopicIds.map(id => [id, 0]));
  for (const receipt of history.receipts) if (dayNumber(receipt.reportDate) >= reportDay - 6)
    for (const item of receipt.items) if (secondaryCounts.has(item.topicId)) secondaryCounts.set(item.topicId, secondaryCounts.get(item.topicId)! + 1);
  const offset = subscription.secondaryTopicIds.length ? ((reportDay % subscription.secondaryTopicIds.length) + subscription.secondaryTopicIds.length) % subscription.secondaryTopicIds.length : 0;
  const rotated = [...subscription.secondaryTopicIds.slice(offset), ...subscription.secondaryTopicIds.slice(0, offset)];
  const secondaryOrder = [...rotated].sort((a, b) => secondaryCounts.get(a)! - secondaryCounts.get(b)! || rotated.indexOf(a) - rotated.indexOf(b));
  const diagnostics: PersonalEdition["diagnostics"] = [];
  const retracted = new Set(feedback.events.filter(e => e.kind === "retract").map(e => e.retractsFeedbackId!));
  const activeFeedback = feedback.events.filter(e => e.kind !== "retract" && !retracted.has(e.feedbackId));
  const ignored = new Set(activeFeedback.filter(e => e.kind === "not-relevant").map(e => e.targetEventId));
  const saved = new Set(activeFeedback.filter(e => e.kind === "saved").map(e => e.targetEventId));
  const previous = new Map<string, { updateKeys: Set<string>; lastIncludedAt: number }>();
  for (const receipt of history.receipts) for (const item of receipt.items) {
    const entry = previous.get(item.eventId) ?? { updateKeys: new Set<string>(), lastIncludedAt: -Infinity };
    entry.updateKeys.add(item.updateKey);
    entry.lastIncludedAt = Math.max(entry.lastIncludedAt, Date.parse(receipt.includedAt));
    previous.set(item.eventId, entry);
  }

  const eligible: Eligible[] = [];
  for (const item of [...candidates.items].sort((a, b) => compare(a.revisionId, b.revisionId))) {
    const reject = (stage: PersonalEdition["diagnostics"][number]["stage"], reason: string) => diagnostics.push({ revisionId: item.revisionId, eventId: item.eventId, stage, reason });
    if (candidates.revokedRevisionIds.includes(item.revisionId)) { reject("revoked", "qualified-revision-revoked"); continue; }
    const published = item.publishedAt === null ? null : Date.parse(item.publishedAt);
    if (item.observedOn > candidates.reportDate || (published !== null && (!Number.isFinite(published) || published > cutoff))) {
      reject("outside-window", "future-or-invalid-source-date"); continue;
    }
    const effectiveDate = item.verifiedUpdate ? dateInZone(item.verifiedUpdate.occurredAt, candidates.reportTimeZone)
      : published !== null ? dateInZone(item.publishedAt!, candidates.reportTimeZone) : item.observedOn;
    const ageDays = reportDay - dayNumber(effectiveDate);
    if (ageDays < 0 || effectiveDate < windowStartDate) { reject("outside-window", "outside-calendar-window"); continue; }
    const matchedTopicIds = subscribed.filter(id => item.assessments.some(a => a.topicId === id &&
      (!subscription.subtopicIds[id]?.length || a.subtopicIds.some(subtopic => subscription.subtopicIds[id].includes(subtopic)))));
    if (!matchedTopicIds.length || !subscription.contentTypes.includes(item.contentType)) { reject("subscription", "topic-subtopic-or-content-type-mismatch"); continue; }
    const text = `${item.title}\n${item.summary}\n${item.evidence.map(e => `${e.text}\n${e.quote}`).join("\n")}`;
    if (subscription.excludeKeywords.some(word => matches(text, word)) || (subscription.codeOnly && item.codeStatus !== "confirmed")) {
      reject("hard-filter", "excluded-keyword-or-confirmed-code-required"); continue;
    }
    if (ignored.has(item.eventId)) { reject("feedback", "active-not-relevant-feedback"); continue; }
    const prior = previous.get(item.eventId);
    if (prior && (!item.verifiedUpdate || prior.updateKeys.has(semanticUpdateKey(item)) || Date.parse(item.verifiedUpdate.occurredAt) <= prior.lastIncludedAt)) {
      reject("history", "event-already-in-official-edition-without-new-verified-update"); continue;
    }
    if (item.verifiedUpdate?.kind === "code_release" && item.codeStatus !== "confirmed") {
      reject("hard-filter", "code-release-requires-confirmed-code"); continue;
    }
    const hitKeywords = [...new Set(subscription.keywords)].filter(word => matches(text, word)).sort(compare);
    const preference = Math.min(10, hitKeywords.length * 2 + (subscription.preferOpenSource && item.codeStatus === "confirmed" ? 3 : 0) + (saved.has(item.eventId) ? 2 : 0));
    eligible.push({ item, matchedTopicIds, hitKeywords, freshness: round(Math.max(0, 100 * (7 - ageDays) / 7)),
      preference, saved: saved.has(item.eventId), ageDays, update: !!prior, effectiveTime: item.verifiedUpdate ? Date.parse(item.verifiedUpdate.occurredAt) : published ?? dayNumber(item.observedOn) * DAY });
  }
  const relevance = (entry: Eligible, topicId?: string) => topicId
    ? entry.item.assessments.find(a => a.topicId === topicId)!.relevance
    : Math.max(...entry.item.assessments.filter(a => entry.matchedTopicIds.includes(a.topicId)).map(a => a.relevance));
  const score = (entry: Eligible, topicId?: string) => round(0.5 * relevance(entry, topicId) + 0.3 * entry.item.quality + 0.2 * entry.freshness + entry.preference);
  const rank = (topicId?: string) => (a: Eligible, b: Eligible) => score(b, topicId) - score(a, topicId) || b.effectiveTime - a.effectiveTime || compare(a.item.eventId, b.item.eventId) || compare(a.item.revisionId, b.item.revisionId);

  // Choose one complete evidence revision per event before assigning any quota; never merge facts or scores.
  const unique = new Map<string, Eligible>();
  for (const entry of eligible.sort((a, b) => b.effectiveTime - a.effectiveTime || rank()(a, b))) {
    if (unique.has(entry.item.eventId)) diagnostics.push({ revisionId: entry.item.revisionId, eventId: entry.item.eventId, stage: "duplicate", reason: "event-represented-by-latest-qualified-evidence" });
    else unique.set(entry.item.eventId, entry);
  }
  const pool = [...unique.values()];
  const selected = new Set<string>();
  const items: PersonalEditionItem[] = [];
  const add = (entry: Eligible, assignedTopicId: string, slot: PersonalEditionItem["slot"]) => {
    selected.add(entry.item.eventId);
    const recap = firstEdition && windowDays === 7 && entry.ageDays > 0;
    const reasons = [slot === "primary" ? "primary-topic" : slot === "secondary" ? "secondary-topic" : "subscription-fill", "quality-gate", "topic-evidence"];
    if (entry.hitKeywords.length) reasons.push("keyword-match");
    if (subscription.preferOpenSource && entry.item.codeStatus === "confirmed") reasons.push("open-source-preference");
    if (entry.saved) reasons.push("saved-feedback");
    if (recap) reasons.push("first-edition-recap");
    if (entry.update) reasons.push("verified-substantial-update");
    items.push({ item: entry.item, assignedTopicId, slot, score: { relevance: relevance(entry, assignedTopicId), quality: entry.item.quality,
      freshness: entry.freshness, preference: entry.preference, total: score(entry, assignedTopicId) },
      hitKeywords: entry.hitKeywords, matchedTopicIds: entry.matchedTopicIds, updateKey: semanticUpdateKey(entry.item), recap, update: entry.update, reasons });
  };
  const weekday = new Date(reportDay * DAY).getUTCDay();
  const scheduleStatus = subscription.frequency === "paused" ? "paused" : subscription.frequency === "weekdays" && (weekday === 0 || weekday === 6) ? "not-scheduled" : null;
  if (!scheduleStatus) {
    for (const entry of pool.filter(e => e.matchedTopicIds.includes(subscription.primaryTopicId)).sort(rank(subscription.primaryTopicId)).slice(0, primaryTarget))
      add(entry, subscription.primaryTopicId, "primary");
    // Reserve the requested secondary slots first; unavailable primary slots are filled only afterwards.
    let secondarySlots = subscription.maxItems - primaryTarget;
    while (secondarySlots > 0) {
      let progress = false;
      for (const topicId of secondaryOrder) {
        const entry = pool.filter(e => !selected.has(e.item.eventId) && e.matchedTopicIds.includes(topicId)).sort(rank(topicId))[0];
        if (!entry) continue;
        add(entry, topicId, "secondary"); secondarySlots--; progress = true;
        if (!secondarySlots) break;
      }
      if (!progress) break;
    }
    for (const entry of pool.filter(e => !selected.has(e.item.eventId)).sort(rank()).slice(0, subscription.maxItems - items.length)) {
      const assignedTopicId = [...entry.matchedTopicIds].sort((a, b) => relevance(entry, b) - relevance(entry, a) || subscribed.indexOf(a) - subscribed.indexOf(b))[0];
      add(entry, assignedTopicId, "fill");
    }
  }
  for (const entry of pool) diagnostics.push({ revisionId: entry.item.revisionId, eventId: entry.item.eventId,
    stage: selected.has(entry.item.eventId) ? "selected" : "quota", reason: selected.has(entry.item.eventId) ? "selected-with-frozen-subscription-and-history" : scheduleStatus ?? "no-remaining-personal-slot" });
  return createPersonalEdition({
    schemaVersion: 1, algorithmVersion: "personal-assembler-v1", memberId: subscription.memberId,
    reportDate: candidates.reportDate, reportTimeZone: candidates.reportTimeZone, cutoffAt: candidates.cutoffAt,
    inputs: { candidateSnapshotId: candidates.snapshotId, subscriptionRevisionId: subscription.revisionId,
      feedbackSnapshotId: feedback.snapshotId, historySnapshotId: history.snapshotId, batchIds: candidates.batchIds,
      policyRevisions: candidates.policyRevisions, topicRevisions: Object.fromEntries(candidates.topics.map(t => [t.id, t.revisionId])) },
    topics: candidates.topics, status: scheduleStatus ?? (items.length ? "ready" : "no-content"), firstEdition,
    windowDays, windowStartDate, channel: subscription.channel, externalSendAllowed: false, items,
    quota: { maxItems: subscription.maxItems, primaryTarget, primarySelected: items.filter(i => i.slot === "primary").length,
      secondarySelected: items.filter(i => i.slot === "secondary").length, fillSelected: items.filter(i => i.slot === "fill").length,
      secondaryOrder, unfilled: subscription.maxItems - items.length },
    diagnostics: diagnostics.sort((a, b) => compare(a.revisionId, b.revisionId) || compare(a.stage, b.stage)),
  });
}
