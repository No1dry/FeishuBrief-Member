import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './db.js';
import type { Mailer } from './mail.js';

export type MemberRole = 'lab_owner' | 'topic_owner' | 'member' | 'viewer';
export type MemberStatus = 'invited' | 'active' | 'disabled';
export interface MemberUser {
  userId: string; email: string; displayName: string; status: MemberStatus; role: MemberRole;
  revision: number; ownedTopicIds: string[]; readTopicIds: string[];
}
export interface SessionEnvelope {
  userId: string; displayName: string; csrfToken: string; preferencesEnabled: boolean;
  role: MemberRole; ownedTopicIds: string[]; readTopicIds: string[];
}
export interface AuthContext { user: MemberUser; sessionId: string; csrfToken: string; expiresAt: number }
export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); this.name = 'AuthError'; }
}
type Row = Record<string, unknown>;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const roleSchema = z.enum(['lab_owner', 'topic_owner', 'member', 'viewer']);
const topicIds = z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(100).transform(value => [...new Set(value)].sort());
const readTopicIds = z.array(z.string().regex(/^(\*|[a-z0-9][a-z0-9_-]{0,63})$/)).max(100).transform(value => [...new Set(value)].sort());
const inviteSchema = z.object({ email: emailSchema, displayName: z.string().trim().min(1).max(80).optional(), role: roleSchema.default('member'), ownedTopicIds: topicIds.default([]), readTopicIds: readTopicIds.default(['*']) }).strict();
const updateSchema = z.object({ baseRevision: z.number().int().positive(), displayName: z.string().trim().min(1).max(80).optional(), role: roleSchema.optional(), ownedTopicIds: topicIds.optional(), readTopicIds: readTopicIds.optional(), status: z.enum(['active', 'disabled']).optional() }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AuthError(400, 'invalid_request');
  return result.data;
}
function userFrom(row: Row): MemberUser {
  return { userId: String(row.id), email: String(row.email), displayName: String(row.display_name), status: row.status as MemberStatus,
    role: row.role as MemberRole, revision: Number(row.revision), ownedTopicIds: JSON.parse(String(row.owned_topic_ids)), readTopicIds: JSON.parse(String(row.read_topic_ids)) };
}
export function writeAudit(store: Store, actorId: string | null, action: string, targetId: string | null, metadata: Record<string, unknown>, now = Date.now()): void {
  store.db.prepare('INSERT INTO audit_events(id,actor_id,action,target_id,metadata_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), actorId, action, targetId, JSON.stringify(metadata), now);
}

export class AuthService {
  private readonly clock: () => number;
  constructor(readonly store: Store, private readonly options: { secret: string; origin: string; mail: Mailer; clock?: () => number; onGrantsChanged?: (userId: string) => void }) {
    if (Buffer.byteLength(options.secret) < 32) throw new Error('Auth secret must contain at least 32 bytes');
    this.clock = options.clock || Date.now;
  }
  private hash(purpose: string, value: string): string { return createHmac('sha256', this.options.secret).update(`${purpose}\0${value}`).digest('hex'); }
  private matches(actual: string, expected: string): boolean {
    const left = Buffer.from(actual); const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  private user(id: string): MemberUser | null {
    const row = this.store.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? userFrom(row) : null;
  }
  /** Refresh the actor from SQL for every privileged operation, including internal callers. */
  private owner(actor: AuthContext): MemberUser {
    const user = this.user(actor.user.userId);
    const session = this.store.db.prepare('SELECT * FROM sessions WHERE id=? AND user_id=?').get(actor.sessionId, actor.user.userId);
    const now = this.clock();
    if (!session || session.revoked_at || Number(session.expires_at) <= now || Number(session.last_seen_at) + 12 * HOUR <= now || !user || user.status !== 'active') throw new AuthError(401, 'session_expired');
    if (user.role !== 'lab_owner') throw new AuthError(403, 'forbidden');
    return user;
  }
  bootstrapOwner(emailValue: string, displayName = 'Lab owner'): MemberUser {
    const email = parse(emailSchema, emailValue);
    const name = parse(z.string().trim().min(1).max(80), displayName);
    return this.store.transaction(() => {
      if (this.store.db.prepare("SELECT id FROM users WHERE role='lab_owner' AND status='active'").get()) throw new AuthError(409, 'owner_already_exists');
      if (this.store.db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw new AuthError(409, 'email_already_exists');
      const id = randomUUID(), now = this.clock();
      this.store.db.prepare("INSERT INTO users(id,email,display_name,status,role,activated_at,created_at,updated_at) VALUES (?,?,?,'active','lab_owner',?,?,?)").run(id, email, name, now, now, now);
      writeAudit(this.store, null, 'owner.bootstrap', id, {}, now);
      return this.user(id)!;
    });
  }
  /** A fixed-window durable limit; callers commit rejection counters instead of rolling back. */
  private limit(bucket: string, maximum: number, window: number, cooldown = 0): boolean {
    const now = this.clock();
    const row = this.store.db.prepare('SELECT * FROM auth_limits WHERE bucket=?').get(bucket);
    if (!row || Number(row.window_start) + window <= now) {
      this.store.db.prepare('INSERT INTO auth_limits(bucket,window_start,count,last_at) VALUES (?,?,1,?) ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,count=1,last_at=excluded.last_at').run(bucket, now, now);
      return true;
    }
    if (Number(row.count) >= maximum || Number(row.last_at) + cooldown > now) return false;
    this.store.db.prepare('UPDATE auth_limits SET count=count+1,last_at=? WHERE bucket=?').run(now, bucket);
    return true;
  }
  async startLogin(input: { email: string; invitationToken?: string }, ip: string): Promise<{ challengeId: string; browserToken: string }> {
    const data = parse(z.object({ email: emailSchema, invitationToken: z.string().min(20).max(256).optional() }).strict(), input);
    const emailHash = this.hash('email', data.email), ipHash = this.hash('ip', ip);
    const challengeId = randomUUID(), browserToken = randomBytes(32).toString('base64url');
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    const now = this.clock();
    const outcome = this.store.transaction(() => {
      const allowedIp = this.limit(`send:ip:${ipHash}`, 30, HOUR);
      const allowedEmail = this.limit(`send:email:${emailHash}`, 8, HOUR, 60_000);
      if (!allowedIp || !allowedEmail) return { limited: true, send: false };
      const row = this.store.db.prepare('SELECT * FROM users WHERE email=?').get(data.email);
      let invitation: Row | undefined;
      if (row?.status === 'invited' && data.invitationToken) invitation = this.store.db.prepare('SELECT * FROM invitations WHERE user_id=? AND token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?')
        .get(String(row.id), this.hash('invitation', data.invitationToken), now);
      const eligible = row && (row.status === 'active' || (row.status === 'invited' && invitation));
      // New challenges invalidate older codes for this email; all eligible and unknown addresses have identical outward shape.
      this.store.db.prepare('UPDATE auth_challenges SET used_at=? WHERE email_hash=? AND used_at IS NULL').run(now, emailHash);
      this.store.db.prepare('INSERT INTO auth_challenges(id,user_id,invitation_id,email_hash,code_hash,browser_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(challengeId, eligible ? String(row.id) : null, invitation ? String(invitation.id) : null, emailHash, this.hash(`otp:${challengeId}`, code), this.hash('browser', browserToken), now + 10 * 60_000, now);
      return { limited: false, send: !!eligible };
    });
    if (outcome.limited) throw new AuthError(429, 'rate_limited');
    if (outcome.send) {
      try {
        await this.options.mail.send({ to: data.email, subject: 'FeishuBrief 登录验证码', text: `你的 FeishuBrief 登录验证码为：${code}\n有效期 10 分钟，只能在发起登录的浏览器使用。请勿转发。\n如果不是你本人操作，请忽略此邮件。` });
      } catch {
        // The response remains indistinguishable from an unknown address and contains no provider details.
        this.store.db.prepare('UPDATE auth_challenges SET used_at=? WHERE id=?').run(this.clock(), challengeId);
        writeAudit(this.store, null, 'auth.mail_failed', null, {}, this.clock());
      }
    }
    return { challengeId, browserToken };
  }
  verifyLogin(input: { challengeId: string; code: string }, browserToken: string, ip: string): { sessionToken: string; session: SessionEnvelope } {
    const data = parse(z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{8}$/) }).strict(), input);
    if (!browserToken || browserToken.length > 256) throw new AuthError(401, 'invalid_code');
    const now = this.clock();
    const result = this.store.transaction(() => {
      if (!this.limit(`verify:ip:${this.hash('ip', ip)}`, 60, HOUR)) return { error: new AuthError(429, 'rate_limited') };
      const challenge = this.store.db.prepare('SELECT * FROM auth_challenges WHERE id=?').get(data.challengeId);
      if (!challenge || challenge.used_at || Number(challenge.expires_at) <= now || Number(challenge.attempts) >= 5) return { error: new AuthError(401, 'invalid_code') };
      this.store.db.prepare('UPDATE auth_challenges SET attempts=attempts+1 WHERE id=?').run(data.challengeId);
      if (!this.matches(this.hash('browser', browserToken), String(challenge.browser_hash)) || !this.matches(this.hash(`otp:${data.challengeId}`, data.code), String(challenge.code_hash)) || !challenge.user_id) return { error: new AuthError(401, 'invalid_code') };
      const user = this.user(String(challenge.user_id));
      if (!user || user.status === 'disabled') return { error: new AuthError(401, 'invalid_code') };
      if (user.status === 'invited') {
        const invitation = this.store.db.prepare('SELECT * FROM invitations WHERE id=? AND user_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?').get(String(challenge.invitation_id || ''), user.userId, now);
        if (!invitation) return { error: new AuthError(401, 'invalid_code') };
        this.store.db.prepare('UPDATE invitations SET accepted_at=? WHERE id=?').run(now, String(invitation.id));
        this.store.db.prepare("UPDATE users SET status='active',activated_at=?,updated_at=?,revision=revision+1 WHERE id=?").run(now, now, user.userId);
        writeAudit(this.store, user.userId, 'invitation.accepted', String(invitation.id), {}, now);
      }
      this.store.db.prepare('UPDATE auth_challenges SET used_at=? WHERE id=?').run(now, data.challengeId);
      const sessionToken = randomBytes(32).toString('base64url'), sessionId = randomUUID();
      this.store.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?)').run(sessionId, user.userId, this.hash('session', sessionToken), now, now, now + 7 * DAY);
      writeAudit(this.store, user.userId, 'auth.login', sessionId, {}, now);
      const context: AuthContext = { user: this.user(user.userId)!, sessionId, csrfToken: this.hash('csrf', sessionToken), expiresAt: now + 7 * DAY };
      return { sessionToken, session: this.sessionEnvelope(context) };
    });
    if ('error' in result) throw result.error;
    return result;
  }
  authenticate(sessionToken: string | undefined | null): AuthContext | null {
    if (!sessionToken || sessionToken.length > 256) return null;
    const now = this.clock();
    const row = this.store.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(this.hash('session', sessionToken));
    if (!row || row.revoked_at || Number(row.expires_at) <= now || Number(row.last_seen_at) + 12 * HOUR <= now) return null;
    const user = this.user(String(row.user_id));
    if (!user || user.status !== 'active') return null;
    this.store.db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(now, String(row.id));
    return { user, sessionId: String(row.id), csrfToken: this.hash('csrf', sessionToken), expiresAt: Number(row.expires_at) };
  }
  sessionEnvelope(context: AuthContext): SessionEnvelope {
    return { userId: context.user.userId, displayName: context.user.displayName, csrfToken: context.csrfToken, preferencesEnabled: context.user.role !== 'viewer', role: context.user.role, ownedTopicIds: context.user.ownedTopicIds, readTopicIds: context.user.readTopicIds };
  }
  logout(context: AuthContext): void {
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=? AND user_id=?').run(this.clock(), context.sessionId, context.user.userId);
      writeAudit(this.store, context.user.userId, 'auth.logout', context.sessionId, {}, this.clock());
    });
  }
  async createInvitation(actor: AuthContext, input: unknown): Promise<{ user: MemberUser; invitation: { invitationId: string; email: string; expiresAt: number; status: 'pending' } }> {
    const data = parse(inviteSchema, input), now = this.clock(), invitationId = randomUUID(), token = randomBytes(32).toString('base64url');
    const user = this.store.transaction(() => {
      const owner = this.owner(actor);
      if (!this.limit(`invite:actor:${owner.userId}`, 30, HOUR)) return null;
      const existing = this.store.db.prepare('SELECT * FROM users WHERE email=?').get(data.email);
      if (existing && existing.status !== 'invited') throw new AuthError(409, 'member_already_exists');
      const userId = existing ? String(existing.id) : randomUUID();
      if (existing) {
        // Reissuing does not silently change grants: use the explicit member CAS update for that.
        this.store.db.prepare('UPDATE invitations SET revoked_at=? WHERE user_id=? AND accepted_at IS NULL AND revoked_at IS NULL').run(now, userId);
      } else {
        this.store.db.prepare("INSERT INTO users(id,email,display_name,status,role,owned_topic_ids,read_topic_ids,created_at,updated_at) VALUES (?,?,?,'invited',?,?,?,?,?)")
          .run(userId, data.email, data.displayName || data.email.split('@')[0]!, data.role, JSON.stringify(data.ownedTopicIds), JSON.stringify(data.readTopicIds), now, now);
      }
      this.store.db.prepare('INSERT INTO invitations(id,user_id,token_hash,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?)').run(invitationId, userId, this.hash('invitation', token), now + 3 * DAY, owner.userId, now);
      writeAudit(this.store, owner.userId, 'invitation.created', userId, { invitationId, role: this.user(userId)!.role }, now);
      return this.user(userId)!;
    });
    if (!user) throw new AuthError(429, 'rate_limited');
    try {
      await this.options.mail.send({ to: data.email, subject: '邀请加入 FeishuBrief', text: `你已获邀加入 FeishuBrief。请使用本邮箱打开下面链接并获取登录验证码：\n${this.options.origin}/app#invite=${token}\n邀请 72 小时内有效，只能由此邮箱接受。` });
    } catch {
      this.store.db.prepare('UPDATE invitations SET revoked_at=? WHERE id=?').run(this.clock(), invitationId);
      writeAudit(this.store, actor.user.userId, 'invitation.mail_failed', user.userId, { invitationId }, this.clock());
      throw new AuthError(503, 'mail_unavailable');
    }
    return { user, invitation: { invitationId, email: data.email, expiresAt: now + 3 * DAY, status: 'pending' } };
  }
  updateUser(actor: AuthContext, userId: string, input: unknown): MemberUser {
    const data = parse(updateSchema, input), now = this.clock();
    return this.store.transaction(() => {
      const owner = this.owner(actor);
      const row = this.store.db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      if (!row) throw new AuthError(404, 'member_not_found');
      const current = userFrom(row);
      if (current.revision !== data.baseRevision) throw new AuthError(409, 'revision_conflict');
      const status = data.status || current.status, role = data.role || current.role;
      if (status === 'active' && row.activated_at === null) throw new AuthError(409, 'email_verification_required');
      if (current.status === 'active' && current.role === 'lab_owner' && (status !== 'active' || role !== 'lab_owner')) {
        const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM users WHERE status='active' AND role='lab_owner'").get()!;
        if (Number(count.n) <= 1) throw new AuthError(409, 'last_owner');
      }
      this.store.db.prepare('UPDATE users SET display_name=?,status=?,role=?,owned_topic_ids=?,read_topic_ids=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
        .run(data.displayName || current.displayName, status, role, JSON.stringify(data.ownedTopicIds ?? current.ownedTopicIds), JSON.stringify(data.readTopicIds ?? current.readTopicIds), now, userId, data.baseRevision);
      const grantsChanged = role !== current.role || status !== current.status || data.ownedTopicIds !== undefined || data.readTopicIds !== undefined;
      if (grantsChanged) {
        this.store.db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now, userId);
        this.store.db.prepare('UPDATE auth_challenges SET used_at=? WHERE user_id=? AND used_at IS NULL').run(now, userId);
        // The notification service cancels pending work in this same transaction.
        this.options.onGrantsChanged?.(userId);
      }
      if (status === 'disabled') this.store.db.prepare('UPDATE invitations SET revoked_at=? WHERE user_id=? AND accepted_at IS NULL AND revoked_at IS NULL').run(now, userId);
      writeAudit(this.store, owner.userId, 'member.updated', userId, { fromRevision: current.revision, toRevision: current.revision + 1, role, status, ownedTopicIds: data.ownedTopicIds ?? current.ownedTopicIds, readTopicIds: data.readTopicIds ?? current.readTopicIds }, now);
      return this.user(userId)!;
    });
  }
  listMembers(actor: AuthContext): MemberUser[] { this.owner(actor); return this.store.db.prepare('SELECT * FROM users ORDER BY created_at,id').all().map(userFrom); }
  listInvitations(actor: AuthContext): Array<{ invitationId: string; userId: string; email: string; expiresAt: number; status: 'pending' | 'accepted' | 'revoked' | 'expired' }> {
    this.owner(actor); const now = this.clock();
    return this.store.db.prepare('SELECT invitations.*,users.email FROM invitations JOIN users ON users.id=invitations.user_id ORDER BY invitations.created_at DESC LIMIT 200').all().map(row => ({ invitationId: String(row.id), userId: String(row.user_id), email: String(row.email), expiresAt: Number(row.expires_at), status: row.accepted_at !== null ? 'accepted' : row.revoked_at !== null ? 'revoked' : Number(row.expires_at) <= now ? 'expired' : 'pending' }));
  }
  getAudit(actor: AuthContext): Array<{ id: string; actorId: string | null; action: string; targetId: string | null; metadata: Record<string, unknown>; createdAt: number }> {
    this.owner(actor);
    return this.store.db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC,id DESC LIMIT 200').all().map(row => ({ id: String(row.id), actorId: row.actor_id ? String(row.actor_id) : null, action: String(row.action), targetId: row.target_id ? String(row.target_id) : null, metadata: JSON.parse(String(row.metadata_json)), createdAt: Number(row.created_at) }));
  }
}
