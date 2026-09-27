import { randomUUID } from 'node:crypto';
import type { AuthContext, MemberRole } from '../src/auth';
import { ContentService, SubscriptionSettingsSchema, type TopicProfile, type VerifiedExport } from '../src/content';
import { Store } from '../src/db';
import { createCandidateSnapshot, personalHash, type PersonalCandidate } from '../src/engine/personal-contract';
import { NotificationQueue, type ResolvedBinding } from '../src/notification-queue';
import { NotificationScheduler } from '../src/notification-scheduler';
import type { ExternalChannel, NotificationProvider } from '../src/notification-providers';

export const START = Date.parse('2026-09-28T01:01:00.000Z'); // Monday, 09:01 Shanghai
export function contentFixture(date = '2026-09-28'): VerifiedExport {
  const profiles: TopicProfile[] = ['vla', 'agent'].map(id => {
    const topic = { id, name: id.toUpperCase(), enabled: true, priority: 'P0' as const, weight: 1,
      keywords: [id], aliases: [], excludeKeywords: [], scope: `Synthetic ${id}`, relevanceThreshold: 70, radarLimit: 10 };
    return { protocol: 'topic-profile-v1', revisionId: personalHash(topic), topic };
  });
  const items: PersonalCandidate[] = profiles.map(profile => ({
    revisionId: personalHash(`qualified-${date}-${profile.topic.id}`), eventId: `event-${date}-${profile.topic.id}`,
    updateId: personalHash(`update-${date}-${profile.topic.id}`), title: `Synthetic ${profile.topic.id} work`, summary: 'Synthetic evidence only',
    url: `https://example.com/${date}/${profile.topic.id}`, sourceId: 'synthetic', sourceItemId: `source-${profile.topic.id}`,
    contentHash: personalHash(`body-${date}-${profile.topic.id}`), observedOn: date, verifiedUpdate: null,
    publishedAt: `${date}T00:00:00.000Z`, contentType: 'paper', codeStatus: 'confirmed', dataStatus: 'unknown', quality: 95,
    primaryTopicId: profile.topic.id, secondaryTopicIds: [], evidence: [{ text: 'Synthetic evidence', quote: 'Synthetic source quotation' }],
    assessments: [{ topicId: profile.topic.id, topicRevision: profile.revisionId, relevance: 95, reason: 'Direct synthetic contribution', evidenceQuotes: ['Synthetic source quotation'], subtopicIds: [] }],
  }));
  const snapshot = createCandidateSnapshot({ schemaVersion: 1, reportDate: date, reportTimeZone: 'Asia/Shanghai', cutoffAt: `${date}T00:30:00.000Z`,
    batchIds: [personalHash(`batch-${date}`)], policyRevisions: ['synthetic'], topics: profiles.map(p => ({ id: p.topic.id, name: p.topic.name,
      revisionId: p.revisionId, scope: p.topic.scope!, subtopics: [], threshold: 70 })), items, revokedRevisionIds: [], diagnostics: [] });
  const body = { generatedAt: snapshot.cutoffAt, snapshot, profiles, revokedRevisionIds: [], catalogBatchId: snapshot.batchIds[0], rawBatchId: personalHash(`raw-${date}`) };
  return { ...body, exportId: personalHash(body) };
}
export function member(store: Store, id: string, now: number, role: MemberRole = 'member', topic = 'vla'): AuthContext {
  const user = { userId: id, email: `${id}@example.test`, displayName: id, status: 'active' as const, role, revision: 1, ownedTopicIds: [], readTopicIds: role === 'lab_owner' ? ['*'] : [topic] };
  store.db.prepare('INSERT INTO users(id,email,display_name,status,role,revision,owned_topic_ids,read_topic_ids,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, user.email, id, user.status, role, 1, '[]', JSON.stringify(user.readTopicIds), now, now);
  store.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run(`session-${id}`, id, personalHash(`session-${id}`), now, now, now + 7 * 86400000);
  return { user, sessionId: `session-${id}`, csrfToken: 'synthetic-csrf', expiresAt: now + 7 * 86400000 };
}
export function setSubscription(content: ContentService, actor: AuthContext, changes: Record<string, unknown> = {}) {
  const current = content.getSubscription(actor), settings = current.subscription
    ? Object.fromEntries(Object.keys(SubscriptionSettingsSchema.shape).map(key => [key, (current.subscription as any)[key]]))
    : { primaryTopicId: actor.user.readTopicIds.includes('agent') ? 'agent' : 'vla', secondaryTopicIds: [], subtopicIds: {}, keywords: [], excludeKeywords: [], codeOnly: false,
      contentTypes: ['paper'], maxItems: 10, primaryShare: 1, preferOpenSource: false, frequency: 'daily', channel: 'feishu', firstEditionLookbackDays: 1 };
  return content.putSubscription(actor, { baseRevision: current.revision, subscription: { ...settings, ...changes } });
}
export function harness(options: { provider?: NotificationProvider; schedulerEnabled?: boolean; enabledChannels?: ExternalChannel[]; databasePath?: string } = {}) {
  const store = new Store(options.databasePath ?? ':memory:'), time = { now: START };
  const content = new ContentService(store, { now: () => new Date(time.now), verifyExport: value => value as VerifiedExport });
  const alice = member(store, 'alice', time.now), bob = member(store, 'bob', time.now, 'member', 'agent'), admin = member(store, 'admin', time.now, 'lab_owner');
  content.importExport(contentFixture());
  for (const actor of [alice, bob]) setSubscription(content, actor);
  const bindings = new Map<string, ResolvedBinding>([alice, bob].map(actor => [actor.user.userId, { bindingId: randomUUID(), revision: 1, target: `synthetic-${actor.user.userId}` }]));
  const resolver = { resolve: (id: string, _channel: ExternalChannel) => bindings.get(id) ?? null };
  const provider: NotificationProvider = options.provider ?? { send: async () => ({ status: 'accepted', providerMessageId: 'synthetic-message' }) };
  const queueOptions = { content, bindings: resolver, provider, origin: 'https://member.example.test', clock: () => time.now,
    enabledChannels: options.enabledChannels ?? ['feishu', 'wechat'] as ExternalChannel[], minIntervalMs: 1000 };
  const queue = new NotificationQueue(store, queueOptions);
  const scheduler = new NotificationScheduler(store, { content, queue, clock: () => time.now, enabled: options.schedulerEnabled ?? true });
  const edition = (actor = alice) => content.createEdition(actor, { requestId: `edition_${actor.user.userId}` }).edition;
  return { store, time, content, alice, bob, admin, bindings, provider, queueOptions, queue, scheduler, edition,
    enqueue: (actor = alice, requestId = `manual_${actor.user.userId}`) => queue.enqueue(actor, { editionId: edition(actor).editionId, channel: 'feishu', requestId, confirmSend: true }),
    schedule: (actor = alice, changes: Record<string, unknown> = {}) => scheduler.put(actor, { baseRevision: scheduler.get(actor).revision, enabled: true, localTime: '09:00', timeZone: 'Asia/Shanghai', ...changes }) };
}
