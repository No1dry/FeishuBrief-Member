import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createApplication } from "../src/server";
import { Store } from "../src/db";
import type { AppConfig } from "../src/config";
import type { MailMessage } from "../src/mail";
import { exportFixture, fixtureClone, rehashFixture, FIXTURE_NOW } from "./export-fixture";
import type { BindingProvider, DeliveryRequest } from "../src/notification-providers";

const ORIGIN = "https://console.example.test";
const MACHINE = "synthetic-machine-token-at-least-32-bytes";
const FEISHU = { appId: 'cli_synthetic_http', appSecret: 'synthetic_secret', encryptKey: 'synthetic_encrypt_key', verificationToken: 'synthetic_verification_token' };
const preferences = { primaryTopicId: "vla", secondaryTopicIds: [], keywords: [], excludeKeywords: [], subtopicIds: {}, codeOnly: false };
type Result = { status: number; body: any; headers: Headers };
class Browser {
  readonly cookies = new Map<string, string>();
  csrf = "";
  constructor(readonly base: string) {}
  async request(route: string, options: { method?: string; body?: unknown; origin?: string | false; csrf?: string | false; headers?: Record<string, string> } = {}): Promise<Result> {
    const method = options.method ?? "GET", headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (this.cookies.size) headers.set("Cookie", [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; "));
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (method !== "GET") {
      if (options.origin !== false) headers.set("Origin", options.origin ?? ORIGIN);
      if (options.csrf !== false && (options.csrf || this.csrf)) headers.set("X-CSRF-Token", options.csrf || this.csrf);
    }
    const response = await fetch(`${this.base}/api/member/${route}`, { method, headers, redirect: "error",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0], index = pair.indexOf("=");
      const name = pair.slice(0, index), value = pair.slice(index + 1);
      if (!value) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const body = response.status === 204 ? null : await response.json();
    return { status: response.status, body, headers: response.headers };
  }
}
async function harness(t: TestContext, consoleDir?: string, notificationProvider?: BindingProvider) {
  const store = new Store(":memory:"), sent: MailMessage[] = [], time = { value: Date.parse(FIXTURE_NOW) };
  const config: AppConfig = { origin: ORIGIN, databasePath: ":memory:", secret: "synthetic-http-secret-at-least-32-bytes", machineToken: MACHINE,
    secureCookies: true, development: false, host: "127.0.0.1", port: 5190,
    mail: { mode: "smtp", host: "unused.example.test", port: 465, secure: true, from: "synthetic@example.test" },
    ...(notificationProvider ? { notifications: { workerEnabled: true, schedulerEnabled: true, pollIntervalMs: 15000, providers: { feishu: FEISHU } } } : {}) };
  const app = createApplication(config, { store, clock: () => time.value, consoleDir, notificationProvider, mail: { async send(message) { sent.push(message); } } });
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  const address = app.server.address() as AddressInfo, base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise<void>((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); store.close(); });
  return { app, store, sent, time, base, browser: () => new Browser(base), advance: (ms = 1000) => { time.value += ms; },
    async login(browser: Browser, email: string, invitationToken?: string) {
      const start = await browser.request("auth/request-code", { method: "POST", body: { email, ...(invitationToken ? { invitationToken } : {}) } });
      assert.equal(start.status, 202);
      const message = sent.filter(m => m.to === email && m.subject.includes("验证码")).at(-1)!;
      const code = message.text.match(/\b\d{8}\b/)![0];
      const verified = await browser.request("auth/verify-code", { method: "POST", body: { challengeId: start.body.challengeId, code } });
      assert.equal(verified.status, 200); browser.csrf = verified.body.csrfToken;
      return verified;
    },
    async owner() { const user = app.auth.bootstrapOwner("owner@example.test", "Synthetic Owner"), browser = new Browser(base); await this.login(browser, user.email); return browser; },
    async invite(owner: Browser, email: string, role = "member") {
      const result = await owner.request("admin/invitations", { method: "POST", body: { email, role } });
      assert.equal(result.status, 201);
      const invitation = sent.filter(m => m.to === email && m.subject.includes("邀请")).at(-1)!;
      const line = invitation.text.split("\n").find(value => value.startsWith("https://"))!;
      const token = new URL(line).hash.slice("#invite=".length);
      assert.ok(token.length > 20); assert.ok(!JSON.stringify(result.body).includes(token));
      return { token, user: result.body.user };
    },
    async import(value = exportFixture()) {
      return new Browser(base).request("machine/imports", { method: "POST", body: value, headers: { Authorization: `Bearer ${MACHINE}` } });
    },
  };
}
function assertPrivate(response: Result) { assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("referrer-policy"), "no-referrer"); }

function syntheticNotificationProvider(sent: DeliveryRequest[]): BindingProvider {
  return { configured: channel => channel === 'feishu',
    async createWechatQr() { throw new Error('Synthetic unconfigured channel'); },
    async findWechatFriend() { return null; },
    async fetchQrImage() { throw new Error('Synthetic unconfigured channel'); },
    async send(request) {
      assert.equal(request.beforeSend?.(), true); sent.push(request);
      return { status: 'accepted', providerMessageId: `synthetic-message-${sent.length}` };
    },
  };
}

async function bindFeishu(h: Awaited<ReturnType<typeof harness>>, browser: Browser, target: string) {
  const start = await browser.request('notifications/bindings/feishu/start', { method: 'POST', body: {} });
  assert.equal(start.status, 201); assert.equal(start.body.status, 'waiting');
  const payload = { schema: '2.0', header: { app_id: FEISHU.appId, token: FEISHU.verificationToken, event_type: 'im.message.receive_v1', event_id: `event-${target}` },
    event: { sender: { sender_type: 'user', sender_id: { open_id: target } }, message: { chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: start.body.code }) } } };
  const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(FEISHU.encryptKey).digest(), iv);
  const raw = Buffer.from(JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64') }));
  const timestamp = String(Math.floor(h.time.value / 1000)), nonce = 'synthetic-http-nonce';
  const headers = { 'content-type': 'application/json', 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce,
    'x-lark-signature': createHash('sha256').update(timestamp + nonce + FEISHU.encryptKey).update(raw).digest('hex') };
  const invalid = await fetch(`${h.base}/api/member/webhooks/feishu`, { method: 'POST', headers, body: Buffer.concat([raw, Buffer.from(' ')]) });
  assert.equal(invalid.status, 401);
  const callback = await fetch(`${h.base}/api/member/webhooks/feishu`, { method: 'POST', headers, body: raw });
  assert.equal(callback.status, 200); assert.deepEqual(await callback.json(), {});
  const challenge = await browser.request(`notifications/challenges/${start.body.challengeId}`);
  assert.equal(challenge.body.status, 'awaiting-confirmation'); assert.ok(!JSON.stringify(challenge.body).includes(target));
  const confirmed = await browser.request(`notifications/challenges/${start.body.challengeId}/confirm`, { method: 'POST', body: {} });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.binding.status, 'active');
  assert.ok(!JSON.stringify(confirmed.body).includes(target));
  return confirmed.body.binding;
}

test("HTTP invitation-only login binds browser challenges, returns flat sessions and enforces secure cookies, Origin and CSRF", async t => {
  const h = await harness(t), owner = h.browser(); h.app.auth.bootstrapOwner("owner@example.test");
  const config = await owner.request("auth/config");
  assert.deepEqual(config.body, { registrationMode: "invite-only", emailLogin: true }); assertPrivate(config);
  assert.equal((await owner.request("session")).status, 401);
  const missingOrigin = await owner.request("auth/request-code", { method: "POST", origin: false, body: { email: "owner@example.test" } });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await owner.request("auth/request-code", { method: "POST", origin: "https://foreign.example.test", body: { email: "owner@example.test" } })).status, 403);
  const start = await owner.request("auth/request-code", { method: "POST", body: { email: "owner@example.test" } });
  assert.equal(start.status, 202); assert.deepEqual(Object.keys(start.body), ["challengeId"]); assertPrivate(start);
  const challengeCookie = start.headers.getSetCookie()[0];
  assert.ok(challengeCookie.startsWith("__Host-feishubrief_challenge="));
  assert.ok(/; Path=\//.test(challengeCookie) && /; HttpOnly/.test(challengeCookie) && /; SameSite=Lax/.test(challengeCookie) && /; Secure/.test(challengeCookie));
  const code = h.sent.at(-1)!.text.match(/\b\d{8}\b/)![0];
  const otherBrowser = h.browser();
  assert.equal((await otherBrowser.request("auth/verify-code", { method: "POST", body: { challengeId: start.body.challengeId, code } })).status, 401);
  const verified = await owner.request("auth/verify-code", { method: "POST", body: { challengeId: start.body.challengeId, code } });
  assert.equal(verified.status, 200); owner.csrf = verified.body.csrfToken;
  assert.deepEqual(Object.keys(verified.body).sort(), ["userId", "displayName", "csrfToken", "preferencesEnabled", "role", "ownedTopicIds", "readTopicIds"].sort());
  assert.equal(verified.body.role, "lab_owner"); assert.equal(verified.body.preferencesEnabled, true);
  const sessionCookie = verified.headers.getSetCookie().find(cookie => cookie.startsWith("__Host-feishubrief_session="))!;
  assert.ok(/; HttpOnly/.test(sessionCookie) && /; Secure/.test(sessionCookie) && /; Path=\//.test(sessionCookie) && !/Domain=/.test(sessionCookie));
  assert.equal((await owner.request("auth/verify-code", { method: "POST", body: { challengeId: start.body.challengeId, code } })).status, 401);
  assert.equal((await owner.request("session")).body.userId, verified.body.userId);
  assert.equal((await owner.request("admin/invitations", { method: "POST", csrf: false, body: { email: "forbidden@example.test" } })).status, 403);
  assert.equal((await owner.request("admin/invitations", { method: "POST", origin: "https://foreign.example.test", body: { email: "forbidden@example.test" } })).status, 403);
  assert.equal((await owner.request("auth/register", { method: "POST", body: { email: "public@example.test" } })).status, 404);
  const beforeUnknown = h.sent.length;
  const unknown = await otherBrowser.request("auth/request-code", { method: "POST", body: { email: "unknown@example.test" } });
  assert.equal(unknown.status, 202); assert.deepEqual(Object.keys(unknown.body), ["challengeId"]); assert.equal(h.sent.length, beforeUnknown);
  const invitation = await h.invite(owner, "member@example.test");
  const member = h.browser(), memberLogin = await h.login(member, "member@example.test", invitation.token);
  assert.equal(memberLogin.body.userId, invitation.user.userId);
  assert.equal((await member.request("admin/members")).status, 403);
  assert.equal((await member.request("admin/invitations", { method: "POST", body: { email: "escalated@example.test", role: "lab_owner" } })).status, 403);
  const audit = await owner.request("admin/audit");
  assert.ok(!JSON.stringify(audit.body).includes(invitation.token)); assert.ok(!JSON.stringify(audit.body).includes(code));
  const logout = await owner.request("logout", { method: "POST", body: {} });
  assert.equal(logout.status, 204); assert.ok(logout.headers.getSetCookie().some(cookie => /Max-Age=0/.test(cookie)));
  assert.equal((await owner.request("session")).status, 401);
});

test("HTTP real proof ingestion, subscriptions, private editions and feedback enforce ownership and atomic history", async t => {
  const h = await harness(t), owner = await h.owner(), machine = h.browser();
  assert.equal((await machine.request("machine/catalog")).status, 401);
  assert.equal((await machine.request("machine/imports", { method: "POST", body: exportFixture(), headers: { Authorization: "Bearer wrong" } })).status, 401);
  const malformed = fixtureClone(exportFixture()); malformed.snapshot.items[0].title = "Forged candidate title";
  const invalid = await h.import(rehashFixture(malformed)); assert.equal(invalid.status, 400); assert.equal(invalid.body.error, "invalid_export");
  assert.equal(Number(h.store.db.prepare("SELECT count(*) AS n FROM content_ready").get()!.n), 0);
  const payload = exportFixture(); const imported = await h.import(payload);
  assert.equal(imported.status, 200); assert.equal(imported.body.ready, true); assert.equal((await h.import(payload)).body.idempotent, true);
  const catalog = await machine.request("machine/catalog", { headers: { Authorization: `Bearer ${MACHINE}` } }); assert.equal(catalog.status, 200);
  const invitation = await h.invite(owner, "member@example.test"), member = h.browser(); await h.login(member, "member@example.test", invitation.token);
  const radar = await member.request("radar"); assert.equal(radar.status, 200); assertPrivate(radar);
  assert.equal(radar.body.batchId, payload.catalogBatchId); assert.equal(radar.body.rawBatchId, payload.batches[0].raw.rawBatchId);
  assert.equal(radar.body.items.length, 2); assert.deepEqual(radar.body.diagnostics, []);
  const initial = await member.request("preferences"); assert.equal(initial.body.revision, "initial");
  const saved = await member.request("preferences", { method: "PUT", body: { baseRevision: "initial", preferences } }); assert.equal(saved.status, 200);
  assert.equal((await member.request("preferences", { method: "PUT", body: { baseRevision: "initial", preferences } })).status, 409);
  assert.equal((await member.request("preferences", { method: "PUT", body: { baseRevision: saved.body.revision, preferences, memberId: invitation.user.userId } })).status, 400);
  const subscription = await member.request("subscription"); assert.equal(subscription.body.subscription.memberId, invitation.user.userId);
  const preview = await member.request("preview", { method: "POST", body: {} }); assert.equal(preview.status, 200); assert.equal(preview.body.finalized, false);
  assert.equal(preview.body.edition.items.length, 2); assert.ok(!("diagnostics" in preview.body.edition));
  assert.equal(Number(h.store.db.prepare("SELECT count(*) AS n FROM content_editions").get()!.n), 0);
  const edition = await member.request("editions", { method: "POST", body: { requestId: "synthetic-official-1" } });
  assert.equal(edition.status, 201); assert.equal(edition.body.finalized, true); assert.equal(edition.body.edition.externalSendAllowed, false);
  const id = edition.body.edition.editionId;
  const repeated = await member.request("editions", { method: "POST", body: { requestId: "synthetic-official-1" } });
  assert.equal(repeated.body.edition.editionId, id); assert.equal(repeated.body.idempotent, true);
  assert.equal((await member.request(`editions/${id}`)).status, 200);
  assert.equal((await owner.request(`editions/${id}`)).status, 404);
  assert.equal((await owner.request("editions")).body.editions.length, 0);
  assert.equal((await member.request(`editions/${id}?memberId=${invitation.user.userId}`)).status, 400);
  h.advance(); const after = await member.request("preview", { method: "POST", body: {} }); assert.equal(after.body.edition.items.length, 0);
  const feedback = await member.request("feedback", { method: "POST", body: { targetEventId: "event-alpha", kind: "saved" } }); assert.equal(feedback.status, 201);
  assert.equal((await owner.request("feedback", { method: "POST", body: { targetEventId: "event-alpha", kind: "retract", retractsFeedbackId: feedback.body.feedbackId } })).status, 404);
  const revoked = await machine.request("machine/revocations", { method: "POST", body: exportFixture({ revokeFirst: true }), headers: { Authorization: `Bearer ${MACHINE}` } });
  assert.equal(revoked.status, 200); assert.equal(revoked.body.applied, 1);
  assert.equal((await member.request(`editions/${id}`)).status, 410);
  assert.equal((await member.request("radar")).body.items.length, 1);
});

test("HTTP viewer restrictions and member disabling revoke sessions immediately", async t => {
  const h = await harness(t), owner = await h.owner(); assert.equal((await h.import()).status, 200);
  const invitation = await h.invite(owner, "viewer@example.test", "viewer"), viewer = h.browser();
  const session = await h.login(viewer, "viewer@example.test", invitation.token);
  assert.equal(session.body.role, "viewer"); assert.equal(session.body.preferencesEnabled, false);
  assert.equal((await viewer.request("radar")).status, 200);
  assert.equal((await viewer.request("preferences", { method: "PUT", body: { baseRevision: "initial", preferences } })).status, 403);
  assert.equal((await viewer.request("editions", { method: "POST", body: { requestId: "viewer-must-not-write" } })).status, 403);
  assert.equal((await viewer.request("feedback", { method: "POST", body: { targetEventId: "event-alpha", kind: "read" } })).status, 403);
  assert.equal((await viewer.request("admin/topics")).status, 403);
  const listed = await owner.request("admin/members");
  const current = listed.body.members.find((member: any) => member.userId === invitation.user.userId);
  const disable = await owner.request(`admin/members/${current.userId}`, { method: "PUT", body: { baseRevision: current.revision, status: "disabled" } });
  assert.equal(disable.status, 200);
  assert.equal((await viewer.request("session")).status, 401);
  assert.equal((await viewer.request("radar")).status, 401);
  assert.equal((await viewer.request("preferences", { method: "PUT", body: { baseRevision: "initial", preferences } })).status, 401);
  assert.equal((await owner.request(`admin/members/${current.userId}`, { method: "PUT", body: { baseRevision: current.revision, status: "active" } })).status, 409);
});

test("HTTP Phase 5 capabilities, unsaved draft previews, feedback, library and operations preserve authorization", async t => {
  const h = await harness(t), owner = await h.owner(); assert.equal((await h.import()).status, 200);
  assert.equal((await h.browser().request("capabilities")).status, 401);
  const invitation = await h.invite(owner, "phase5@example.test"), member = h.browser(); await h.login(member, "phase5@example.test", invitation.token);
  const caps = await member.request("capabilities"); assert.equal(caps.status, 200); assertPrivate(caps);
  assert.deepEqual(caps.body.personalDelivery, { enabled: false, phase: 6, channels: [] }); assert.equal(caps.body.scheduler.enabled, false);
  const initial = await member.request("subscription");
  const preview = await member.request("preview", { method: "POST", body: { subscription: { ...initial.body.defaults, maxItems: 1 } } });
  assert.equal(preview.status, 200); assert.equal(preview.body.draft, true); assert.equal(preview.body.finalized, false);
  assert.equal(preview.body.edition.items.length, 1); assert.equal(preview.body.edition.externalSendAllowed, false);
  assert.equal((await member.request("subscription")).body.subscription, null); assert.equal((await member.request("editions")).body.editions.length, 0);
  const saved = await member.request("feedback", { method: "POST", body: { kind: "saved", targetEventId: "event-alpha" } }); assert.equal(saved.status, 201);
  const state = await member.request("feedback"); assert.equal(state.status, 200); assert.equal(state.body.items[0].saved, true);
  const library = await member.request("library"); assert.equal(library.status, 200); assertPrivate(library);
  assert.equal(library.body.currentAvailable, true); assert.equal(library.body.items.length, 2);
  assert.equal(library.body.items.find((entry: any) => entry.item.eventId === "event-alpha").feedback.saved, true);
  assert.equal((await owner.request("feedback")).body.items.length, 0);
  assert.equal((await member.request("admin/operations")).status, 403);
  const operations = await owner.request("admin/operations"); assert.equal(operations.status, 200); assertPrivate(operations);
  assert.equal(operations.body.content.readyImports, 1); assert.equal(operations.body.assembly.editions, 0);
  assert.equal(operations.body.delivery.enabled, false); assert.deepEqual(operations.body.delivery.records, []);
  assert.equal(operations.body.delivery.worker.started, false); assert.equal(operations.body.delivery.worker.lastOutcome, 'idle');
  const retract = await member.request("feedback", { method: "POST", body: { kind: "retract", targetEventId: "event-alpha", retractsFeedbackId: saved.body.feedbackId } });
  assert.equal(retract.status, 201); assert.equal((await member.request("feedback")).body.items.length, 0);
});

test('HTTP Phase 6 two-member signed binding, isolated delivery, idempotency and atomic pause/unbind/disable cancellation', async t => {
  const sent: DeliveryRequest[] = [], h = await harness(t, undefined, syntheticNotificationProvider(sent));
  const owner = await h.owner(); assert.equal((await h.import()).status, 200);
  const invited = await h.invite(owner, 'notifications@example.test'), member = h.browser(); await h.login(member, invited.user.email, invited.token);
  assert.equal((await h.browser().request('notifications')).status, 401);
  assert.equal((await member.request('admin/deliveries')).status, 403);
  const caps = await member.request('capabilities'); assert.equal(caps.body.notificationBindings, true); assert.equal(caps.body.personalDelivery.enabled, true);
  assert.deepEqual(caps.body.personalDelivery.channels, ['feishu']); assert.equal(caps.body.scheduler.enabled, true);
  assert.equal((await owner.request('notifications/bindings/feishu/start', { method: 'POST', csrf: false, body: {} })).status, 403);
  const ownerBinding = await bindFeishu(h, owner, 'ou_synthetic_http_owner');
  await bindFeishu(h, member, 'ou_synthetic_http_member');
  const editions: Record<string, any> = {};
  for (const [name, browser, excluded] of [['owner', owner, 'beta'], ['member', member, 'alpha']] as const) {
    const defaults = (await browser.request('subscription')).body.defaults;
    assert.equal((await browser.request('subscription', { method: 'PUT', body: { baseRevision: 'initial', subscription: { ...defaults, channel: 'feishu', excludeKeywords: [excluded] } } })).status, 200);
    const created = await browser.request('editions', { method: 'POST', body: { requestId: `http-phase6-${name}` } });
    assert.equal(created.status, 201); assert.equal(created.body.edition.items.length, 1);
    assert.equal(created.body.edition.externalSendAllowed, false); editions[name] = created.body.edition;
  }
  assert.notEqual(editions.owner.items[0].item.eventId, editions.member.items[0].item.eventId);
  assert.equal(sent.length, 0); // binding, saving and station editions have not sent notifications
  assert.equal((await member.request('notifications/deliveries', { method: 'POST', body: { editionId: editions.owner.editionId, channel: 'feishu', requestId: 'cross-user-send', confirmSend: true } })).status, 404);
  const intents: Record<string, string> = {};
  for (const [name, browser] of [['owner', owner], ['member', member]] as const) {
    const body = { editionId: editions[name].editionId, channel: 'feishu', requestId: `send-phase6-${name}`, confirmSend: true };
    const created = await browser.request('notifications/deliveries', { method: 'POST', body }); assert.equal(created.status, 201);
    intents[name] = created.body.delivery.intentId;
    const repeated = await browser.request('notifications/deliveries', { method: 'POST', body });
    assert.equal(repeated.body.idempotent, true); assert.equal(repeated.body.delivery.intentId, intents[name]);
    assert.equal((await browser.request('notifications/deliveries', { method: 'POST', body: { ...body, requestId: `another-${name}` } })).status, 409);
  }
  await h.app.queue.runOnce(); h.advance(11000); await h.app.queue.runOnce(); await h.app.queue.runOnce();
  assert.equal(sent.length, 2);
  for (const [name, target] of [['owner', 'ou_synthetic_http_owner'], ['member', 'ou_synthetic_http_member']] as const) {
    const message = sent.find(value => value.target === target)!; assert.ok(message.text.includes(editions[name].editionId));
    assert.ok(!message.text.includes(editions[name === 'owner' ? 'member' : 'owner'].editionId));
  }
  const state = await member.request('notifications'); assertPrivate(state);
  assert.equal(state.body.deliveries.length, 1); assert.equal(state.body.deliveries[0].status, 'accepted');
  assert.ok(!JSON.stringify(state.body).includes('ou_synthetic'));
  const schedule = await member.request('notifications/schedule');
  const scheduleBody = { baseRevision: schedule.body.revision, enabled: true, localTime: '09:00', timeZone: 'Asia/Shanghai' };
  assert.equal((await member.request('notifications/schedule', { method: 'PUT', body: scheduleBody })).status, 200);
  assert.equal((await member.request('notifications/schedule', { method: 'PUT', body: scheduleBody })).status, 409);
  async function resend(name: string, suffix: string) {
    const result = await owner.request(`admin/deliveries/${intents[name]}/resend`, { method: 'POST', body: { requestId: `http-resend-${suffix}`, reason: 'Synthetic verified resend', confirmDuplicate: true } });
    assert.equal(result.status, 200); return result.body.delivery.intentId;
  }
  const unboundIntent = await resend('owner', 'unbind');
  assert.equal((await owner.request(`notifications/bindings/${ownerBinding.bindingId}`, { method: 'DELETE', csrf: false, body: {} })).status, 403);
  assert.equal((await owner.request(`notifications/bindings/${ownerBinding.bindingId}`, { method: 'DELETE', body: {} })).status, 200);
  assert.equal(h.store.db.prepare('SELECT status FROM notification_intents WHERE id=?').get(unboundIntent)!.status, 'cancelled');
  const pausedIntent = await resend('member', 'pause');
  const subscription = (await member.request('subscription')).body;
  // Saved subscriptions contain revision metadata; the endpoint only accepts settings.
  const keys = ['primaryTopicId','secondaryTopicIds','subtopicIds','keywords','excludeKeywords','codeOnly','contentTypes','maxItems','primaryShare','preferOpenSource','frequency','channel','firstEditionLookbackDays'];
  const paused = await member.request('subscription', { method: 'PUT', body: { baseRevision: subscription.revision, subscription: { ...Object.fromEntries(keys.map(key => [key, subscription.subscription[key]])), frequency: 'paused' } } });
  assert.equal(paused.status, 200); assert.equal(h.store.db.prepare('SELECT status FROM notification_intents WHERE id=?').get(pausedIntent)!.status, 'cancelled');
  assert.equal((await member.request('subscription', { method: 'PUT', body: { baseRevision: paused.body.revision, subscription: Object.fromEntries(keys.map(key => [key, subscription.subscription[key]])) } })).status, 200);
  const disabledIntent = await resend('member', 'disable');
  const current = (await owner.request('admin/members')).body.members.find((value: any) => value.userId === invited.user.userId);
  assert.equal((await owner.request(`admin/members/${current.userId}`, { method: 'PUT', body: { baseRevision: current.revision, status: 'disabled' } })).status, 200);
  assert.equal(h.store.db.prepare('SELECT status FROM notification_intents WHERE id=?').get(disabledIntent)!.status, 'cancelled');
  assert.equal((await member.request('notifications')).status, 401);
  h.advance(11000); await h.app.queue.runOnce(); assert.equal(sent.length, 2);
});

test("production document headers isolate member and administrator connections and mark full-page surface boundaries", async t => {
  const directory = mkdtempSync(join(tmpdir(), "feishubrief-http-html-"));
  t.after(() => {
    assert(resolve(directory).startsWith(resolve(join(tmpdir(), "feishubrief-http-html-"))));
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, "index.html"), '<!doctype html><html><head><title>Synthetic Console</title></head><body><div id="root"></div></body></html>');
  const h = await harness(t, directory);
  const landing = await fetch(h.base, { redirect: "manual" }); assert.equal(landing.status, 302); assert.equal(landing.headers.get("location"), "/app");
  const member = await fetch(`${h.base}/app/editions/synthetic`, { redirect: "error" }); assert.equal(member.status, 200);
  const memberPolicy = member.headers.get("content-security-policy")!;
  assert.ok(memberPolicy.includes("connect-src 'self';")); assert.ok(!memberPolicy.includes("api.github.com"));
  assert.ok(memberPolicy.includes("script-src 'self';")); assert.ok(!memberPolicy.includes("unsafe-eval"));
  assert.ok(memberPolicy.includes("style-src 'self' 'unsafe-inline'")); assert.ok(memberPolicy.includes("font-src 'self'"));
  assert.ok(memberPolicy.includes("frame-ancestors 'none'")); assert.ok(memberPolicy.includes("upgrade-insecure-requests"));
  assert.equal(member.headers.get("cache-control"), "no-store"); assert.equal(member.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(member.headers.get("cross-origin-opener-policy"), "same-origin"); assert.equal(member.headers.get("x-frame-options"), "DENY");
  assert.equal(member.headers.get("strict-transport-security"), "max-age=31536000");
  const memberHtml = await member.text(); assert.ok(memberHtml.includes('<base href="/">')); assert.ok(memberHtml.includes('name="feishubrief-surface" content="member"'));
  const admin = await fetch(`${h.base}/admin`); const adminPolicy = admin.headers.get("content-security-policy")!;
  assert.ok(adminPolicy.includes("connect-src 'self' https://api.github.com;")); assert.ok((await admin.text()).includes('name="feishubrief-surface" content="admin"'));
  const api = await h.browser().request("auth/config"); assert.ok(api.headers.get("content-security-policy")!.includes("default-src 'none'"));
  const proxy = readFileSync(new URL("../deploy/nginx/feishubrief.conf", import.meta.url), "utf8");
  assert.ok(!/add_header\s+Content-Security-Policy/i.test(proxy)); assert.ok(!/proxy_hide_header\s+Content-Security-Policy/i.test(proxy));
});
