import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { AuthService, type AuthContext } from '../src/auth.js';
import { Store } from '../src/db.js';
import { NotificationBindings } from '../src/notification-bindings.js';
import type { BindingProvider, DeliveryRequest, NotificationProviderConfig } from '../src/notification-providers.js';

const SECRET = 'synthetic-notification-secret-at-least-32-bytes';
const FEISHU: NonNullable<NotificationProviderConfig['feishu']> = { appId: 'cli_synthetic', appSecret: 'synthetic-secret', encryptKey: 'synthetic-encrypt-key', verificationToken: 'synthetic-verification-token' };
function harness(t: { after(fn: () => void): void }) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = Date.parse('2026-09-27T00:00:00Z'), qrProof = '', friend = true, configured = true;
  const sent: DeliveryRequest[] = [], mail: { text: string }[] = [], cancellations: string[] = [];
  const provider: BindingProvider = {
    configured: () => configured,
    async createWechatQr(proof) { qrProof = proof; return 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=synthetic'; },
    async fetchQrImage() { return { body: Buffer.from('synthetic'), contentType: 'image/png' }; },
    async findWechatFriend(target) { return friend ? { target, displayName: 'Synthetic Friend' } : null; },
    async send(request) { if (request.beforeSend && !request.beforeSend()) return { status: 'permanent_failed', errorCode: 'cancelled_before_send' }; sent.push(request); return { status: 'accepted', providerMessageId: 'synthetic-code' }; },
  };
  const auth = new AuthService(store, { secret: SECRET, origin: 'https://brief.example.test', clock: () => now, mail: { async send(message) { mail.push(message); } } });
  const bindings = new NotificationBindings(store, { secret: SECRET, origin: 'https://brief.example.test', clock: () => now, provider, feishu: FEISHU, onUnbind(user, channel) { cancellations.push(`${user}:${channel}`); } });
  return { store, auth, bindings, provider, sent, cancellations, advance(ms: number) { now += ms; }, noFriend() { friend = false; }, disableChannel() { configured = false; },
    async owner() { const owner = auth.bootstrapOwner('owner@example.test'); const challenge = await auth.startLogin({ email: owner.email }, '192.0.2.1'); const code = mail.at(-1)!.text.match(/\b\d{8}\b/)![0]; const result = auth.verifyLogin({ challengeId: challenge.challengeId, code }, challenge.browserToken, '192.0.2.1'); return auth.authenticate(result.sessionToken)!; },
    async member(owner: AuthContext) {
      const invite = await auth.createInvitation(owner, { email: 'member@example.test' });
      const invitationToken = new URL(mail.at(-1)!.text.split('\n').find(line => line.startsWith('https://'))!).hash.slice('#invite='.length);
      const challenge = await auth.startLogin({ email: invite.user.email, invitationToken }, '192.0.2.2'); const code = mail.at(-1)!.text.match(/\b\d{8}\b/)![0];
      const result = auth.verifyLogin({ challengeId: challenge.challengeId, code }, challenge.browserToken, '192.0.2.2'); return auth.authenticate(result.sessionToken)!;
    },
    callback() { return { event: 'add_friend', qrCode: qrProof, friendInfo: { token: 'a'.repeat(32) } }; },
    event(code: string, options: { target?: string; chatType?: string; eventId?: string; token?: string } = {}) {
      const payload = { schema: '2.0', header: { app_id: FEISHU.appId, token: options.token || FEISHU.verificationToken, event_type: 'im.message.receive_v1', event_id: options.eventId || 'synthetic-event' }, event: { sender: { sender_type: 'user', sender_id: { open_id: options.target || 'ou_synthetic_owner' } }, message: { chat_type: options.chatType || 'p2p', message_type: 'text', content: JSON.stringify({ text: code }) } } };
      const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(FEISHU.encryptKey).digest(), iv);
      const raw = Buffer.from(JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64') }));
      const timestamp = String(Math.floor(now / 1000)), nonce = 'synthetic-nonce';
      const headers = { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': createHash('sha256').update(timestamp + nonce + FEISHU.encryptKey).update(raw).digest('hex') };
      return { raw, headers };
    },
  };
}

test('Feishu verified direct sender requires browser confirmation, is single-use and never exposed', async t => {
  const h = harness(t), owner = await h.owner();
  const challenge = await h.bindings.start(owner, 'feishu');
  assert.match(challenge.code!, /^FB-[A-F0-9]{24}$/);
  assert.ok(!JSON.stringify(h.store.db.prepare('SELECT * FROM notification_binding_challenges').all()).includes(challenge.code!));
  const event = h.event(challenge.code!);
  h.bindings.handleFeishu(event.raw, event.headers);
  assert.equal(h.bindings.resolve(owner.user.userId, 'feishu'), null);
  assert.equal(h.bindings.challenge(owner, challenge.challengeId).status, 'awaiting-confirmation');
  const binding = h.bindings.confirm(owner, challenge.challengeId, {});
  assert.equal(binding.status, 'active');
  assert.equal(h.bindings.resolve(owner.user.userId, 'feishu')!.target, 'ou_synthetic_owner');
  assert.ok(!JSON.stringify(binding).includes('ou_'));
  assert.ok(!JSON.stringify(h.bindings.list(owner)).includes('ou_'));
  assert.ok(!JSON.stringify(h.auth.getAudit(owner)).includes(challenge.code!));
  assert.throws(() => h.bindings.confirm(owner, challenge.challengeId, {}));
  h.bindings.handleFeishu(event.raw, event.headers);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM notification_bindings').get()!.n, 1);
  h.bindings.unbind(owner, binding.bindingId);
  assert.equal(h.bindings.resolve(owner.user.userId, 'feishu'), null);
  assert.equal(h.cancellations.length, 1);
  assert.equal(h.bindings.list(owner)[0].status, 'unbound');
});

test('Feishu rejects forged/rawbody-altered/stale/token-mismatched callbacks and ignores group messages', async t => {
  const h = harness(t), owner = await h.owner(), challenge = await h.bindings.start(owner, 'feishu');
  const group = h.event(challenge.code!, { chatType: 'group' });
  h.bindings.handleFeishu(group.raw, group.headers);
  assert.equal(h.bindings.challenge(owner, challenge.challengeId).status, 'waiting');
  const event = h.event(challenge.code!);
  assert.throws(() => h.bindings.handleFeishu(event.raw, { ...event.headers, 'x-lark-signature': '0'.repeat(64) }));
  assert.throws(() => h.bindings.handleFeishu(Buffer.concat([event.raw, Buffer.from(' ')]), event.headers));
  const wrongToken = h.event(challenge.code!, { token: 'wrong-token' });
  assert.throws(() => h.bindings.handleFeishu(wrongToken.raw, wrongToken.headers));
  h.advance(301_000);
  assert.throws(() => h.bindings.handleFeishu(event.raw, event.headers));
  assert.equal(h.bindings.challenge(owner, challenge.challengeId).status, 'waiting');
});

test('platform destination uniqueness and owner/session scope prevent cross-user binding changes', async t => {
  const h = harness(t), owner = await h.owner(), member = await h.member(owner);
  const first = await h.bindings.start(owner, 'feishu'), e1 = h.event(first.code!);
  h.bindings.handleFeishu(e1.raw, e1.headers); const binding = h.bindings.confirm(owner, first.challengeId, {});
  assert.throws(() => h.bindings.challenge(member, first.challengeId));
  assert.throws(() => h.bindings.confirm(member, first.challengeId, {}));
  assert.throws(() => h.bindings.unbind(member, binding.bindingId));
  const second = await h.bindings.start(member, 'feishu'), e2 = h.event(second.code!, { eventId: 'different-event' });
  h.bindings.handleFeishu(e2.raw, e2.headers);
  assert.throws(() => h.bindings.confirm(member, second.challengeId, {}), /binding_conflict/);
  assert.equal(h.bindings.resolve(member.user.userId, 'feishu'), null);
});

test('PushPlus callback alone cannot bind: server friend lookup plus private OTP possession required', async t => {
  const h = harness(t), owner = await h.owner(), challenge = await h.bindings.start(owner, 'wechat');
  assert.match(challenge.qrCodeUrl!, /^\/api\/member\/notifications\/challenges\//);
  await h.bindings.handlePushplus({ ...h.callback(), qrCode: 'x'.repeat(43) });
  assert.equal(h.sent.length, 0);
  await h.bindings.handlePushplus(h.callback());
  await h.bindings.handlePushplus(h.callback());
  assert.equal(h.sent.length, 1);
  assert.equal(h.bindings.resolve(owner.user.userId, 'wechat'), null);
  assert.equal(h.bindings.challenge(owner, challenge.challengeId).status, 'awaiting-code');
  const code = h.sent[0].text.match(/\b\d{8}\b/)![0];
  assert.ok(!JSON.stringify(h.store.db.prepare('SELECT * FROM notification_binding_challenges').all()).includes(code));
  assert.throws(() => h.bindings.confirm(owner, challenge.challengeId, { code: code === '00000000' ? '11111111' : '00000000' }), /invalid_code/);
  const binding = h.bindings.confirm(owner, challenge.challengeId, { code });
  assert.equal(binding.displayName, 'Synthetic Friend');
  assert.ok(!JSON.stringify(binding).includes('a'.repeat(32)));
  assert.equal(h.bindings.resolve(owner.user.userId, 'wechat')!.target, 'a'.repeat(32));
});

test('PushPlus unknown friend, five failed codes and expired sessions do not activate a target', async t => {
  const h = harness(t), owner = await h.owner(), challenge = await h.bindings.start(owner, 'wechat');
  await h.bindings.handlePushplus(h.callback());
  const actual = h.sent[0].text.match(/\b\d{8}\b/)![0], wrong = actual === '00000000' ? '11111111' : '00000000';
  for (let i = 0; i < 5; i++) assert.throws(() => h.bindings.confirm(owner, challenge.challengeId, { code: wrong }), /invalid_code/);
  assert.throws(() => h.bindings.confirm(owner, challenge.challengeId, { code: actual }), /verification_locked/);
  h.advance(60_001); h.noFriend();
  const next = await h.bindings.start(owner, 'wechat'); await h.bindings.handlePushplus(h.callback());
  assert.equal(h.sent.length, 1);
  assert.equal(h.bindings.challenge(owner, next.challengeId).status, 'failed');
  h.auth.logout(owner);
  assert.throws(() => h.bindings.confirm(owner, challenge.challengeId, { code: actual }), /session_expired/);
});

test('grants revocation, expiration, rate limiting and async provider cancellation protect binding', async t => {
  const h = harness(t), owner = await h.owner(), challenge = await h.bindings.start(owner, 'feishu');
  await assert.rejects(h.bindings.start(owner, 'feishu'), /rate_limited/);
  h.store.transaction(() => h.bindings.invalidateChallenges(owner.user.userId));
  const event = h.event(challenge.code!); h.bindings.handleFeishu(event.raw, event.headers);
  assert.equal(h.bindings.challenge(owner, challenge.challengeId).status, 'expired');
  h.advance(60_001);
  const pending = await h.bindings.start(owner, 'wechat');
  h.provider.findWechatFriend = async target => { h.store.transaction(() => h.bindings.invalidateChallenges(owner.user.userId)); return { target, displayName: 'Synthetic' }; };
  await h.bindings.handlePushplus(h.callback());
  assert.equal(h.sent.length, 0);
  assert.equal(h.bindings.challenge(owner, pending.challengeId).status, 'expired');
  h.advance(60_001);
  const expires = await h.bindings.start(owner, 'feishu'); h.advance(600_001);
  assert.equal(h.bindings.challenge(owner, expires.challengeId).status, 'expired');
  h.disableChannel();
  await assert.rejects(h.bindings.start(owner, 'wechat'), /channel_unconfigured/);
});

test('recipient uniqueness survives rotation of the member authentication secret', async t => {
  const h = harness(t), owner = await h.owner(), member = await h.member(owner);
  const first = await h.bindings.start(owner, 'feishu'), event = h.event(first.code!);
  h.bindings.handleFeishu(event.raw, event.headers); h.bindings.confirm(owner, first.challengeId, {});
  const rotated = new NotificationBindings(h.store, { secret: `${SECRET}-rotated`, origin: 'https://brief.example.test', provider: h.provider,
    feishu: FEISHU, clock: () => Date.parse('2026-09-27T00:00:00Z') });
  const second = await rotated.start(member, 'feishu'), next = h.event(second.code!, { eventId: 'rotated-secret-event' });
  rotated.handleFeishu(next.raw, next.headers);
  assert.throws(() => rotated.confirm(member, second.challengeId, {}), /binding_conflict/);
});
