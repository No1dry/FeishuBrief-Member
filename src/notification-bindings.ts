import { createDecipheriv, createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AuthError, writeAudit, type AuthContext } from './auth.js';
import type { Store } from './db.js';
import type { BindingProvider, ExternalChannel, NotificationProviderConfig } from './notification-providers.js';

export class NotificationBindingError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'NotificationBindingError'; }
}
export interface BindingView { bindingId: string; channel: ExternalChannel; status: 'active' | 'unbound'; displayName: string; verifiedAt: string }
export interface ChallengeView {
  challengeId: string; channel: ExternalChannel;
  status: 'waiting' | 'awaiting-confirmation' | 'awaiting-code' | 'complete' | 'expired' | 'failed';
  expiresAt: string; code?: string; qrCodeUrl?: string; displayName?: string;
}
type Row = Record<string, unknown>;
const HOUR = 3_600_000;
const channelSchema = z.enum(['feishu', 'wechat']);
const confirmSchema = z.object({ code: z.string().regex(/^\d{8}$/).optional() }).strict();
function equal(a: string, b: string) { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function parse<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw new NotificationBindingError(400, 'invalid_request'); return result.data; }
function bindingView(row: Row): BindingView { return { bindingId: String(row.id), channel: row.channel as ExternalChannel, status: row.status as 'active' | 'unbound', displayName: String(row.display_name), verifiedAt: new Date(Number(row.verified_at)).toISOString() }; }

/** Browser-bound proofs are stored only as HMACs; platform destinations never leave the server. */
export class NotificationBindings {
  private readonly clock: () => number;
  constructor(readonly store: Store, private readonly options: {
    secret: string; origin: string; provider: BindingProvider; feishu?: NotificationProviderConfig['feishu']; clock?: () => number;
    onUnbind?: (userId: string, channel: ExternalChannel) => void;
  }) { if (Buffer.byteLength(options.secret) < 32) throw new Error('Binding secret too short'); this.clock = options.clock || Date.now; }
  private hash(purpose: string, value: string): string { return createHmac('sha256', this.options.secret).update(`${purpose}\0${value}`).digest('hex'); }
  private active(actor: AuthContext, writable = true): void {
    const user = this.store.db.prepare('SELECT status,role FROM users WHERE id=?').get(actor.user.userId);
    const session = this.store.db.prepare('SELECT * FROM sessions WHERE id=? AND user_id=?').get(actor.sessionId, actor.user.userId), now = this.clock();
    if (!user || user.status !== 'active' || !session || session.revoked_at || Number(session.expires_at) <= now || Number(session.last_seen_at) + 12 * HOUR <= now) throw new AuthError(401, 'session_expired');
    if (writable && user.role === 'viewer') throw new AuthError(403, 'forbidden');
  }
  private currentChallenge(row: Row): boolean {
    const now = this.clock();
    const user = this.store.db.prepare('SELECT status,role FROM users WHERE id=?').get(String(row.user_id));
    const session = this.store.db.prepare('SELECT * FROM sessions WHERE id=? AND user_id=?').get(String(row.session_id), String(row.user_id));
    return !!user && user.status === 'active' && user.role !== 'viewer' && !!session && !session.revoked_at && Number(session.expires_at) > now && Number(session.last_seen_at) + 12 * HOUR > now && Number(row.expires_at) > now;
  }
  private limit(bucket: string, max: number, cooldown = 0): boolean {
    const now = this.clock(), row = this.store.db.prepare('SELECT * FROM notification_binding_limits WHERE bucket=?').get(bucket);
    if (!row || Number(row.window_start) + HOUR <= now) { this.store.db.prepare('INSERT INTO notification_binding_limits(bucket,window_start,count,last_at) VALUES (?,?,1,?) ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,count=1,last_at=excluded.last_at').run(bucket, now, now); return true; }
    if (Number(row.count) >= max || Number(row.last_at) + cooldown > now) return false;
    this.store.db.prepare('UPDATE notification_binding_limits SET count=count+1,last_at=? WHERE bucket=?').run(now, bucket); return true;
  }
  channels() { return (['feishu', 'wechat'] as const).map(channel => ({ channel, configured: this.options.provider.configured(channel) })); }
  list(actor: AuthContext): BindingView[] {
    this.active(actor, false);
    const rows = this.store.db.prepare('SELECT * FROM notification_bindings WHERE user_id=? ORDER BY verified_at DESC,rowid DESC').all(actor.user.userId);
    const seen = new Set<unknown>();
    return rows.filter(row => { if (seen.has(row.channel)) return false; seen.add(row.channel); return true; }).map(bindingView);
  }
  resolve(userId: string, channel: ExternalChannel): { bindingId: string; revision: number; target: string } | null {
    const row = this.store.db.prepare("SELECT b.* FROM notification_bindings b JOIN users u ON u.id=b.user_id WHERE b.user_id=? AND b.channel=? AND b.status='active' AND u.status='active' AND u.role!='viewer'").get(userId, channel);
    return row ? { bindingId: String(row.id), revision: Number(row.revision), target: String(row.target) } : null;
  }
  /** No transaction here: caller may revoke grants and pending work in the same SQL transaction. */
  invalidateChallenges(userId: string): void {
    this.store.db.prepare("UPDATE notification_binding_challenges SET status='expired',otp_hash=NULL,target=NULL,qr_url=NULL WHERE user_id=? AND status NOT IN ('complete','expired','failed')").run(userId);
  }
  private projection(row: Row): ChallengeView {
    const expired = Number(row.expires_at) <= this.clock() && row.status !== 'complete';
    const status = expired ? 'expired' : row.status === 'verifying' ? 'waiting' : row.status as ChallengeView['status'];
    return { challengeId: String(row.id), channel: row.channel as ExternalChannel, status, expiresAt: new Date(Number(row.expires_at)).toISOString(),
      ...(row.qr_url && status === 'waiting' ? { qrCodeUrl: `/api/member/notifications/challenges/${row.id}/qr` } : {}),
      ...(row.display_name && !['expired', 'failed'].includes(status) ? { displayName: String(row.display_name) } : {}) };
  }
  private owned(actor: AuthContext, id: string): Row {
    this.active(actor);
    const row = this.store.db.prepare('SELECT * FROM notification_binding_challenges WHERE id=? AND user_id=? AND session_id=?').get(id, actor.user.userId, actor.sessionId);
    if (!row) throw new NotificationBindingError(404, 'challenge_not_found');
    return row;
  }
  challenge(actor: AuthContext, id: string): ChallengeView { return this.projection(this.owned(actor, id)); }
  async start(actor: AuthContext, channelValue: unknown): Promise<ChallengeView> {
    this.active(actor); const channel = parse(channelSchema, channelValue);
    if (!this.options.provider.configured(channel)) throw new NotificationBindingError(409, 'channel_unconfigured');
    if (this.resolve(actor.user.userId, channel)) throw new NotificationBindingError(409, 'already_bound');
    const proof = channel === 'feishu' ? `FB-${randomBytes(12).toString('hex').toUpperCase()}` : randomBytes(32).toString('base64url');
    const id = randomUUID(), now = this.clock();
    const allowed = this.store.transaction(() => {
      this.active(actor);
      if (!this.limit(`start:${actor.user.userId}`, 6, 60_000)) return false;
      this.store.db.prepare("UPDATE notification_binding_challenges SET status='expired',otp_hash=NULL,target=NULL,qr_url=NULL WHERE user_id=? AND channel=? AND status NOT IN ('complete','expired','failed')").run(actor.user.userId, channel);
      this.store.db.prepare("INSERT INTO notification_binding_challenges(id,user_id,session_id,channel,status,proof_hash,created_at,expires_at) VALUES (?,?,?,?,'waiting',?,?,?)").run(id, actor.user.userId, actor.sessionId, channel, this.hash('proof', proof), now, now + 600_000);
      writeAudit(this.store, actor.user.userId, 'notification.binding_start', id, { channel }, now); return true;
    });
    if (!allowed) throw new NotificationBindingError(429, 'rate_limited');
    if (channel === 'wechat') {
      try {
        const url = await this.options.provider.createWechatQr(proof, 600);
        const row = this.owned(actor, id);
        if (row.status !== 'waiting' || !this.currentChallenge(row)) throw new NotificationBindingError(409, 'challenge_expired');
        this.store.db.prepare('UPDATE notification_binding_challenges SET qr_url=? WHERE id=?').run(url, id);
      } catch {
        this.store.db.prepare("UPDATE notification_binding_challenges SET status='failed',qr_url=NULL WHERE id=? AND status='waiting'").run(id);
        throw new NotificationBindingError(503, 'binding_provider_unavailable');
      }
    }
    return { ...this.challenge(actor, id), ...(channel === 'feishu' ? { code: proof } : {}) };
  }
  async qr(actor: AuthContext, id: string): Promise<{ body: Buffer; contentType: string }> {
    const row = this.owned(actor, id);
    if (!this.currentChallenge(row) || row.status !== 'waiting' || !row.qr_url) throw new NotificationBindingError(410, 'challenge_expired');
    const result = await this.options.provider.fetchQrImage(String(row.qr_url));
    const current = this.owned(actor, id);
    if (!this.currentChallenge(current) || current.status !== 'waiting') throw new NotificationBindingError(410, 'challenge_expired');
    return result;
  }
  confirm(actor: AuthContext, id: string, input: unknown): BindingView {
    const data = parse(confirmSchema, input);
    const result = this.store.transaction(() => {
      const row = this.owned(actor, id);
      if (!this.currentChallenge(row) || !['awaiting-confirmation', 'awaiting-code'].includes(String(row.status)) || !row.target) return { error: new NotificationBindingError(409, 'challenge_not_ready') };
      if (row.channel === 'wechat') {
        if (Number(row.attempts) >= 5) return { error: new NotificationBindingError(429, 'verification_locked') };
        this.store.db.prepare('UPDATE notification_binding_challenges SET attempts=attempts+1 WHERE id=?').run(id);
        if (!data.code || !equal(this.hash(`otp:${id}`, data.code), String(row.otp_hash))) return { error: new NotificationBindingError(400, 'invalid_code') };
      }
      const targetHash = this.hash(`target:${row.channel}`, String(row.target));
      if (this.store.db.prepare("SELECT id FROM notification_bindings WHERE status='active' AND ((channel=? AND target=?) OR (user_id=? AND channel=?))").get(String(row.channel), String(row.target), actor.user.userId, String(row.channel))) return { error: new NotificationBindingError(409, 'binding_conflict') };
      const bindingId = randomUUID(), now = this.clock();
      const previous = this.store.db.prepare('SELECT MAX(revision) AS revision FROM notification_bindings WHERE user_id=? AND channel=?').get(actor.user.userId, String(row.channel));
      this.store.db.prepare("INSERT INTO notification_bindings(id,user_id,channel,target,target_hash,revision,status,display_name,verified_at) VALUES (?,?,?,?,?,?,'active',?,?)").run(bindingId, actor.user.userId, String(row.channel), String(row.target), targetHash, Number(previous?.revision || 0) + 1, String(row.display_name || '已验证的账号'), now);
      this.store.db.prepare("UPDATE notification_binding_challenges SET status='complete',target=NULL,otp_hash=NULL,qr_url=NULL WHERE id=?").run(id);
      writeAudit(this.store, actor.user.userId, 'notification.bound', bindingId, { channel: row.channel }, now);
      return { binding: bindingView(this.store.db.prepare('SELECT * FROM notification_bindings WHERE id=?').get(bindingId)!) };
    });
    if (result.error) throw result.error;
    return result.binding!;
  }
  unbind(actor: AuthContext, id: string): void {
    this.store.transaction(() => {
      this.active(actor);
      const row = this.store.db.prepare('SELECT * FROM notification_bindings WHERE id=? AND user_id=?').get(id, actor.user.userId);
      if (!row) throw new NotificationBindingError(404, 'binding_not_found');
      if (row.status !== 'active') return;
      const now = this.clock();
      this.store.db.prepare("UPDATE notification_bindings SET status='unbound',unbound_at=?,revision=revision+1,target='' WHERE id=?").run(now, id);
      this.invalidateChallenges(actor.user.userId);
      this.options.onUnbind?.(actor.user.userId, row.channel as ExternalChannel);
      writeAudit(this.store, actor.user.userId, 'notification.unbound', id, { channel: row.channel }, now);
    });
  }
  /** Verify signature over untouched bytes, then decrypt. Only v2 direct human messages bind. */
  handleFeishu(raw: Buffer, headers: Record<string, string | undefined>): { challenge?: string } {
    const config = this.options.feishu;
    if (!config || !this.options.provider.configured('feishu')) throw new NotificationBindingError(404, 'channel_unconfigured');
    const timestamp = headers['x-lark-request-timestamp'] || '', nonce = headers['x-lark-request-nonce'] || '', signature = headers['x-lark-signature'] || '';
    if (!/^\d{10}$/.test(timestamp) || Math.abs(this.clock() - Number(timestamp) * 1000) > 300_000 || nonce.length < 1 || nonce.length > 256 || !/^[a-f0-9]{64}$/i.test(signature)) throw new NotificationBindingError(401, 'invalid_webhook');
    const expected = createHash('sha256').update(timestamp + nonce + config.encryptKey).update(raw).digest('hex');
    if (!equal(expected, signature.toLowerCase())) throw new NotificationBindingError(401, 'invalid_webhook');
    let payload: any;
    try {
      const outer = JSON.parse(raw.toString('utf8'));
      if (typeof outer.encrypt !== 'string') throw new Error();
      const cipher = Buffer.from(outer.encrypt, 'base64');
      if (cipher.length < 32 || cipher.length % 16) throw new Error();
      const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(config.encryptKey).digest(), cipher.subarray(0, 16));
      payload = JSON.parse(Buffer.concat([decipher.update(cipher.subarray(16)), decipher.final()]).toString('utf8'));
    } catch { throw new NotificationBindingError(401, 'invalid_webhook'); }
    const token = payload?.header?.token || payload?.token;
    if (typeof token !== 'string' || !equal(token, config.verificationToken)) throw new NotificationBindingError(401, 'invalid_webhook');
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string' && payload.challenge.length < 1000) return { challenge: payload.challenge };
    if (payload.schema !== '2.0' || payload.header?.app_id !== config.appId || payload.header?.event_type !== 'im.message.receive_v1') return {};
    const eventId = payload.header?.event_id, sender = payload.event?.sender, message = payload.event?.message;
    if (typeof eventId !== 'string' || !eventId || eventId.length > 256 || sender?.sender_type !== 'user' || message?.chat_type !== 'p2p' || message?.message_type !== 'text' || !/^ou_[a-zA-Z0-9_-]{4,128}$/.test(sender?.sender_id?.open_id || '')) return {};
    let code: string;
    try { code = JSON.parse(message.content).text.trim(); } catch { return {}; }
    if (!/^FB-[A-F0-9]{24}$/.test(code)) return {};
    this.store.transaction(() => {
      const hash = this.hash('event', eventId);
      if (this.store.db.prepare('SELECT event_hash FROM notification_webhook_events WHERE event_hash=?').get(hash)) return;
      this.store.db.prepare('INSERT INTO notification_webhook_events(event_hash,received_at) VALUES (?,?)').run(hash, this.clock());
      const row = this.store.db.prepare("SELECT * FROM notification_binding_challenges WHERE proof_hash=? AND channel='feishu' AND status='waiting'").get(this.hash('proof', code));
      if (!row || !this.currentChallenge(row)) return;
      this.store.db.prepare("UPDATE notification_binding_challenges SET status='awaiting-confirmation',target=?,display_name=? WHERE id=?").run(sender.sender_id.open_id, '已验证的飞书账号', String(row.id));
    });
    return {};
  }
  /** PushPlus callbacks have no documented signature: a callback only starts a second possession proof. */
  async handlePushplus(value: unknown): Promise<void> {
    if (!this.options.provider.configured('wechat')) return;
    const parsed = z.object({ event: z.literal('add_friend'), qrCode: z.string().min(40).max(100), friendInfo: z.object({ token: z.string().regex(/^[a-zA-Z0-9]{32}$/) }).passthrough() }).passthrough().safeParse(value);
    if (!parsed.success) return;
    const data = parsed.data;
    const row = this.store.transaction(() => {
      const candidate = this.store.db.prepare("SELECT * FROM notification_binding_challenges WHERE proof_hash=? AND channel='wechat' AND status='waiting'").get(this.hash('proof', data.qrCode));
      if (!candidate || !this.currentChallenge(candidate)) return null;
      if (!this.limit(`friend:${this.hash('friend', data.friendInfo.token)}`, 3, 60_000)) return null;
      this.store.db.prepare("UPDATE notification_binding_challenges SET status='verifying' WHERE id=?").run(String(candidate.id));
      return candidate;
    });
    if (!row) return;
    const id = String(row.id);
    try {
      const friend = await this.options.provider.findWechatFriend(data.friendInfo.token);
      const current = this.store.db.prepare('SELECT * FROM notification_binding_challenges WHERE id=?').get(id)!;
      if (!friend || friend.target !== data.friendInfo.token || !this.currentChallenge(current) || current.status !== 'verifying') {
        this.store.db.prepare("UPDATE notification_binding_challenges SET status='failed' WHERE id=? AND status='verifying'").run(id); return;
      }
      const otp = String(randomInt(0, 100_000_000)).padStart(8, '0');
      this.store.db.prepare('UPDATE notification_binding_challenges SET target=?,display_name=?,otp_hash=? WHERE id=?').run(friend.target, friend.displayName || '已验证的微信账号', this.hash(`otp:${id}`, otp), id);
      const sent = await this.options.provider.send({ channel: 'wechat', target: friend.target, title: 'FeishuBrief 绑定验证码', text: `你正在绑定 FeishuBrief 个人通知。验证码：${otp}，请在 Console 页面提示的有效期内填写。不要转发验证码。若非本人操作，请忽略。`, idempotencyKey: `binding:${id}`, beforeSend: () => {
        const latest = this.store.db.prepare('SELECT * FROM notification_binding_challenges WHERE id=?').get(id);
        return !!latest && latest.status === 'verifying' && this.currentChallenge(latest);
      } });
      // Unknown must never trigger another OTP send; allow proof if the first one did arrive.
      const status = ['accepted', 'provider_confirmed', 'unknown'].includes(sent.status) ? 'awaiting-code' : 'failed';
      this.store.db.prepare("UPDATE notification_binding_challenges SET status=? WHERE id=? AND status='verifying'").run(status, id);
    } catch { this.store.db.prepare("UPDATE notification_binding_challenges SET status='failed',otp_hash=NULL,target=NULL WHERE id=? AND status='verifying'").run(id); }
  }
}
