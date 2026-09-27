import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError, AuthService, type AuthContext } from '../src/auth.js';
import { Store } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import type { MailMessage } from '../src/mail.js';

const HOUR = 3_600_000;
const SECRET = 'synthetic-unit-test-secret-32-bytes-minimum';
function harness(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'feishubrief-auth-'));
  const path = join(directory, 'auth.sqlite');
  let now = Date.parse('2026-09-26T00:00:00Z');
  const store = new Store(path);
  const sent: MailMessage[] = [];
  let fail = false;
  const mail = { async send(message: MailMessage) { if (fail) throw new Error('synthetic provider failure'); sent.push(message); } };
  const auth = new AuthService(store, { secret: SECRET, origin: 'https://brief.example.test', mail, clock: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, auth, sent, path, advance: (ms: number) => { now += ms; }, failMail: () => { fail = true; },
    async login(email: string, invitationToken?: string) {
      const challenge = await auth.startLogin({ email, invitationToken }, '192.0.2.1');
      const code = sent.at(-1)!.text.match(/\b\d{8}\b/)![0];
      const verified = auth.verifyLogin({ challengeId: challenge.challengeId, code }, challenge.browserToken, '192.0.2.1');
      return { ...verified, context: auth.authenticate(verified.sessionToken)! };
    },
    async owner() {
      const user = auth.bootstrapOwner('owner@example.test', 'Owner');
      const login = await this.login(user.email);
      return login.context;
    },
    invitationToken() { return new URL(sent.at(-1)!.text.split('\n').find(line => line.startsWith('https://'))!).hash.slice('#invite='.length); },
  };
}
function errorCode(code: string) { return (error: unknown) => error instanceof AuthError && error.code === code; }

test('invitation is email-bound, one-time, browser-bound and never returned in API or audit', async t => {
  const h = harness(t), owner = await h.owner();
  const invitation = await h.auth.createInvitation(owner, { email: '  NEW@example.test ', displayName: 'New', role: 'member' });
  const token = h.invitationToken();
  assert.equal(invitation.user.status, 'invited');
  assert.equal(invitation.user.email, 'new@example.test');
  assert.ok(!JSON.stringify(invitation).includes(token));
  const beforeUnknown = h.sent.length;
  const unknown = await h.auth.startLogin({ email: 'other@example.test', invitationToken: token }, '192.0.2.2');
  assert.equal(h.sent.length, beforeUnknown);
  assert.throws(() => h.auth.verifyLogin({ challengeId: unknown.challengeId, code: '12345678' }, unknown.browserToken, '192.0.2.2'), errorCode('invalid_code'));
  const challenge = await h.auth.startLogin({ email: 'new@example.test', invitationToken: token }, '192.0.2.2');
  const code = h.sent.at(-1)!.text.match(/\b\d{8}\b/)![0];
  assert.throws(() => h.auth.verifyLogin({ challengeId: challenge.challengeId, code }, 'wrong-browser', '192.0.2.2'), errorCode('invalid_code'));
  const result = h.auth.verifyLogin({ challengeId: challenge.challengeId, code }, challenge.browserToken, '192.0.2.2');
  assert.equal(result.session.userId, invitation.user.userId);
  assert.equal(h.auth.authenticate(result.sessionToken)!.user.status, 'active');
  assert.throws(() => h.auth.verifyLogin({ challengeId: challenge.challengeId, code }, challenge.browserToken, '192.0.2.2'), errorCode('invalid_code'));
  assert.equal(h.auth.listInvitations(owner)[0]!.status, 'accepted');
  assert.ok(!JSON.stringify(h.auth.getAudit(owner)).includes(token));
  assert.ok(!JSON.stringify(h.auth.getAudit(owner)).includes(code));
  assert.ok(!JSON.stringify(h.store.db.prepare('SELECT * FROM sessions').all()).includes(result.sessionToken));
  assert.ok(!JSON.stringify(h.store.db.prepare('SELECT * FROM auth_challenges').all()).includes(code));
});

test('invitation-only login has indistinguishable unknown response shape and no public signup', async t => {
  const h = harness(t), owner = await h.owner();
  await h.auth.createInvitation(owner, { email: 'invited@example.test' });
  const prior = h.sent.length;
  const unknown = await h.auth.startLogin({ email: 'unknown@example.test' }, '192.0.2.3');
  const invitedWithoutToken = await h.auth.startLogin({ email: 'invited@example.test' }, '192.0.2.3');
  assert.deepEqual(Object.keys(unknown), Object.keys(invitedWithoutToken));
  assert.equal(h.sent.length, prior);
  assert.equal(h.auth.listMembers(owner).length, 2);
  assert.equal(h.auth.authenticate('anything'), null);
});

test('OTP expiry, five attempts, cooldown and durable email/IP quotas', async t => {
  const h = harness(t);
  const owner = h.auth.bootstrapOwner('owner@example.test');
  const challenge = await h.auth.startLogin({ email: owner.email }, '192.0.2.4');
  const code = h.sent.at(-1)!.text.match(/\b\d{8}\b/)![0];
  await assert.rejects(h.auth.startLogin({ email: owner.email }, '192.0.2.5'), errorCode('rate_limited'));
  const wrong = code === '00000000' ? '00000001' : '00000000';
  for (let i = 0; i < 5; i++) assert.throws(() => h.auth.verifyLogin({ challengeId: challenge.challengeId, code: wrong }, challenge.browserToken, '192.0.2.4'), errorCode('invalid_code'));
  assert.throws(() => h.auth.verifyLogin({ challengeId: challenge.challengeId, code }, challenge.browserToken, '192.0.2.4'), errorCode('invalid_code'));
  h.advance(60_000);
  const expired = await h.auth.startLogin({ email: owner.email }, '192.0.2.4');
  const expiredCode = h.sent.at(-1)!.text.match(/\b\d{8}\b/)![0];
  h.advance(10 * 60_000);
  assert.throws(() => h.auth.verifyLogin({ challengeId: expired.challengeId, code: expiredCode }, expired.browserToken, '192.0.2.4'), errorCode('invalid_code'));
  for (let i = 0; i < 6; i++) { h.advance(60_000); await h.auth.startLogin({ email: owner.email }, '192.0.2.4'); }
  h.advance(60_000);
  await assert.rejects(h.auth.startLogin({ email: owner.email }, '192.0.2.99'), errorCode('rate_limited'));
  // A separately opened handle observes the same quota, so restarting the service cannot reset it.
  const secondStore = new Store(h.path);
  try { assert.ok(Number(secondStore.db.prepare("SELECT count FROM auth_limits WHERE bucket LIKE 'send:email:%'").get()!.count) >= 8); } finally { secondStore.close(); }
  for (let i = 0; i < 30; i++) await h.auth.startLogin({ email: `unknown-${i}@example.test` }, '192.0.2.88');
  await assert.rejects(h.auth.startLogin({ email: 'fresh@example.test' }, '192.0.2.88'), errorCode('rate_limited'));
});

test('sessions use absolute and idle deadlines; logout and access changes revoke immediately', async t => {
  const h = harness(t), owner = await h.owner();
  const invitation = await h.auth.createInvitation(owner, { email: 'member@example.test' });
  let login = await h.login('member@example.test', h.invitationToken());
  h.auth.logout(login.context);
  assert.equal(h.auth.authenticate(login.sessionToken), null);
  h.advance(60_000);
  login = await h.login('member@example.test');
  let member = h.auth.listMembers(owner).find(user => user.userId === invitation.user.userId)!;
  member = h.auth.updateUser(owner, member.userId, { baseRevision: member.revision, role: 'viewer' });
  assert.equal(h.auth.authenticate(login.sessionToken), null);
  h.advance(60_000);
  login = await h.login('member@example.test');
  assert.equal(login.session.preferencesEnabled, false);
  member = h.auth.updateUser(owner, member.userId, { baseRevision: member.revision, status: 'disabled' });
  assert.equal(h.auth.authenticate(login.sessionToken), null);
  await assert.rejects(h.auth.startLogin({ email: 'member@example.test' }, '192.0.2.7'), errorCode('rate_limited'));
  h.advance(12 * HOUR);
  assert.equal(h.auth.authenticate((await h.auth.startLogin({ email: 'never@example.test' }, '192.0.2.7')).browserToken), null);
  assert.throws(() => h.auth.listMembers(owner), errorCode('session_expired'));
  const ownerLogin = await h.login('owner@example.test');
  for (let i = 0; i < 14; i++) { h.advance(11 * HOUR); assert.ok(h.auth.authenticate(ownerLogin.sessionToken)); }
  h.advance(14 * HOUR);
  assert.equal(h.auth.authenticate(ownerLogin.sessionToken), null);
});

test('CAS, role authorization, invitation activation and last-owner checks are transactional', async t => {
  const h = harness(t), owner = await h.owner();
  assert.throws(() => h.auth.updateUser(owner, owner.user.userId, { baseRevision: owner.user.revision, status: 'disabled' }), errorCode('last_owner'));
  const invited = await h.auth.createInvitation(owner, { email: 'topic@example.test', role: 'topic_owner', ownedTopicIds: ['agent'] });
  assert.throws(() => h.auth.updateUser(owner, invited.user.userId, { baseRevision: invited.user.revision, status: 'active' }), errorCode('email_verification_required'));
  const memberLogin = await h.login('topic@example.test', h.invitationToken());
  assert.throws(() => h.auth.listMembers(memberLogin.context), errorCode('forbidden'));
  const forged = { ...memberLogin.context, user: { ...memberLogin.context.user, role: 'lab_owner' } } as AuthContext;
  assert.throws(() => h.auth.listMembers(forged), errorCode('forbidden'));
  await assert.rejects(h.auth.createInvitation(forged, { email: 'illicit@example.test' }), errorCode('forbidden'));
  const revision = memberLogin.context.user.revision;
  const changed = h.auth.updateUser(owner, invited.user.userId, { baseRevision: revision, displayName: 'Updated' });
  assert.equal(changed.revision, revision + 1);
  assert.throws(() => h.auth.updateUser(owner, invited.user.userId, { baseRevision: revision, role: 'lab_owner' }), errorCode('revision_conflict'));
  assert.equal(h.auth.listMembers(owner).find(user => user.userId === invited.user.userId)!.role, 'topic_owner');
});

test('reissued invitation revokes old token, mail failures invalidate challenges and invite secrets', async t => {
  const h = harness(t), owner = await h.owner();
  await h.auth.createInvitation(owner, { email: 'member@example.test' });
  const oldToken = h.invitationToken();
  await h.auth.createInvitation(owner, { email: 'member@example.test' });
  const currentToken = h.invitationToken();
  const count = h.sent.length;
  await h.auth.startLogin({ email: 'member@example.test', invitationToken: oldToken }, '192.0.2.1');
  assert.equal(h.sent.length, count);
  h.advance(60_000);
  const login = await h.login('member@example.test', currentToken);
  assert.ok(login.sessionToken);
  h.failMail(); h.advance(60_000);
  const failed = await h.auth.startLogin({ email: 'member@example.test' }, '192.0.2.1');
  assert.ok(h.store.db.prepare('SELECT used_at FROM auth_challenges WHERE id=?').get(failed.challengeId)!.used_at);
  await assert.rejects(h.auth.createInvitation(owner, { email: 'fail@example.test' }), errorCode('mail_unavailable'));
  assert.equal(h.auth.listInvitations(owner).find(invitation => invitation.email === 'fail@example.test')!.status, 'revoked');
});

test('expired invitations cannot activate accounts even with a still-live OTP', async t => {
  const h = harness(t), owner = await h.owner();
  await h.auth.createInvitation(owner, { email: 'expires@example.test' });
  const token = h.invitationToken();
  h.advance(72 * HOUR - 60_000);
  const challenge = await h.auth.startLogin({ email: 'expires@example.test', invitationToken: token }, '192.0.2.1');
  const code = h.sent.at(-1)!.text.match(/\b\d{8}\b/)![0];
  h.advance(60_000);
  assert.throws(() => h.auth.verifyLogin({ challengeId: challenge.challengeId, code }, challenge.browserToken, '192.0.2.1'), errorCode('invalid_code'));
  assert.equal(h.store.db.prepare('SELECT status FROM users WHERE email=?').get('expires@example.test')!.status, 'invited');
});

test('config requires production HTTPS, strong secrets, TLS SMTP and isolated local mail', () => {
  const base = { MEMBER_ORIGIN: 'https://brief.example.test', MEMBER_SECRET: SECRET, MEMBER_MACHINE_TOKEN: SECRET, MEMBER_SMTP_HOST: 'smtp.example.test', MEMBER_SMTP_FROM: 'brief@example.test', NODE_ENV: 'production' };
  assert.equal(loadConfig(base).secureCookies, true);
  assert.throws(() => loadConfig({ ...base, MEMBER_ORIGIN: 'http://brief.example.test' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...base, MEMBER_SECRET: 'short' }), /MEMBER_SECRET/);
  assert.throws(() => loadConfig({ ...base, MEMBER_MACHINE_TOKEN: '' }), /MEMBER_MACHINE_TOKEN/);
  assert.throws(() => loadConfig({ ...base, MEMBER_MAIL_MODE: 'local' }), /Local mail/);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'development', MEMBER_ORIGIN: 'http://127.0.0.1:5190', MEMBER_ALLOW_INSECURE_LOCAL: 'true', MEMBER_HOST: '0.0.0.0', MEMBER_MAIL_MODE: 'local' }), /loopback/);
  assert.equal(loadConfig({ NODE_ENV: 'development', MEMBER_ORIGIN: 'http://127.0.0.1:5190', MEMBER_SECRET: SECRET, MEMBER_ALLOW_INSECURE_LOCAL: 'true', MEMBER_MAIL_MODE: 'local' }).secureCookies, false);
});

test('transactions roll back atomically and reject asynchronous callbacks', t => {
  const h = harness(t);
  assert.throws(() => h.store.transaction(() => {
    h.store.db.prepare('INSERT INTO audit_events(id,action,metadata_json,created_at) VALUES (?,?,?,?)').run('rollback', 'test', '{}', 1);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(h.store.db.prepare('SELECT * FROM audit_events WHERE id=?').get('rollback'), undefined);
  assert.throws(() => h.store.transaction(async () => undefined), /synchronous/);
});
