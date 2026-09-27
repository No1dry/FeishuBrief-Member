import { createHash } from 'node:crypto';

export type ExternalChannel = 'feishu' | 'wechat';
export interface DeliveryRequest { channel: ExternalChannel; target: string; title: string; text: string; idempotencyKey: string; beforeSend?: () => boolean }
export interface ProviderResult {
  status: 'accepted' | 'retryable_failed' | 'permanent_failed' | 'unknown' | 'provider_confirmed';
  providerMessageId?: string; retryAfterMs?: number; errorCode?: string;
}
export interface NotificationProvider {
  send(request: DeliveryRequest): Promise<ProviderResult>;
  query?(channel: ExternalChannel, providerMessageId: string): Promise<ProviderResult>;
  canQuery?(channel: ExternalChannel): boolean;
}
export interface NotificationProviderConfig {
  feishu?: { appId: string; appSecret: string; encryptKey: string; verificationToken: string };
  pushplus?: { token: string; secretKey: string };
}
export interface VerifiedFriend { target: string; displayName: string }
export interface BindingProvider extends NotificationProvider {
  configured(channel: ExternalChannel): boolean;
  createWechatQr(content: string, expiresIn: number): Promise<string>;
  findWechatFriend(target: string): Promise<VerifiedFriend | null>;
  fetchQrImage(url: string): Promise<{ body: Buffer; contentType: string }>;
}
export class NotificationProviderError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'NotificationProviderError'; }
}
type Json = Record<string, any>;
function qrUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.port || url.username || url.password || url.hash || url.pathname !== '/cgi-bin/showqrcode' || !url.searchParams.get('ticket')) throw new NotificationProviderError('invalid_qr_image');
  return url;
}

/** Dedicated personal adapters. Never accept topic/chat_id or follow credential-bearing redirects. */
export class PlatformNotificationProvider implements BindingProvider {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private feishuToken?: { value: string; expiresAt: number };
  private pushplusKey?: { value: string; expiresAt: number };
  private feishuRefresh?: Promise<string>;
  private pushplusRefresh?: Promise<string>;
  constructor(readonly config: NotificationProviderConfig, options: { fetch?: typeof fetch; clock?: () => number } = {}) {
    this.fetcher = options.fetch || fetch; this.clock = options.clock || Date.now;
  }
  configured(channel: ExternalChannel): boolean { return channel === 'feishu' ? !!this.config.feishu : !!this.config.pushplus; }
  canQuery(channel: ExternalChannel): boolean { return channel === 'wechat' && this.configured(channel); }
  private async request(url: string, init: RequestInit = {}): Promise<{ response: Response; body: Json }> {
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (Number(response.headers.get('content-length') || 0) > 1_000_000 || !response.body) throw new NotificationProviderError('provider_response_invalid');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 1_000_000) throw new NotificationProviderError('provider_response_invalid'); chunks.push(chunk); }
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Json;
    try { body = JSON.parse(raw); } catch { throw new NotificationProviderError('provider_response_invalid'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NotificationProviderError('provider_response_invalid');
    return { response, body };
  }
  private post(body: unknown, headers: Record<string, string> = {}): RequestInit {
    return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
  }
  private async tenantToken(): Promise<string> {
    if (this.feishuToken && this.feishuToken.expiresAt > this.clock()) return this.feishuToken.value;
    if (this.feishuRefresh) return this.feishuRefresh;
    this.feishuRefresh = (async () => {
      const config = this.config.feishu;
      if (!config) throw new NotificationProviderError('channel_unconfigured');
      const { response, body } = await this.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', this.post({ app_id: config.appId, app_secret: config.appSecret }));
      if (!response.ok || body.code !== 0 || typeof body.tenant_access_token !== 'string' || !Number.isFinite(body.expire) || body.expire <= 0) throw new NotificationProviderError('feishu_auth_failed');
      this.feishuToken = { value: body.tenant_access_token, expiresAt: this.clock() + Math.max(1, body.expire - 60) * 1000 };
      return this.feishuToken.value;
    })();
    try { return await this.feishuRefresh; } finally { this.feishuRefresh = undefined; }
  }
  private async accessKey(): Promise<string> {
    if (this.pushplusKey && this.pushplusKey.expiresAt > this.clock()) return this.pushplusKey.value;
    if (this.pushplusRefresh) return this.pushplusRefresh;
    this.pushplusRefresh = (async () => {
      const config = this.config.pushplus;
      if (!config) throw new NotificationProviderError('channel_unconfigured');
      const { response, body } = await this.request('https://www.pushplus.plus/api/common/openApi/getAccessKey', this.post({ token: config.token, secretKey: config.secretKey }));
      if (!response.ok || body.code !== 200 || typeof body.data?.accessKey !== 'string' || !Number.isFinite(body.data.expiresIn) || body.data.expiresIn <= 0) throw new NotificationProviderError('pushplus_auth_failed');
      this.pushplusKey = { value: body.data.accessKey, expiresAt: this.clock() + Math.max(1, body.data.expiresIn - 60) * 1000 };
      return this.pushplusKey.value;
    })();
    try { return await this.pushplusRefresh; } finally { this.pushplusRefresh = undefined; }
  }
  private async openApi(path: string, body?: unknown): Promise<Json> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = await this.accessKey();
      const result = await this.request(`https://www.pushplus.plus/api/open/${path}`, body === undefined ? { headers: { 'access-key': key } } : this.post(body, { 'access-key': key }));
      if (attempt === 0 && (result.response.status === 401 || result.body.code === 401)) { this.pushplusKey = undefined; continue; }
      if (!result.response.ok || result.body.code !== 200) throw new NotificationProviderError('pushplus_open_api_failed');
      return result.body;
    }
    throw new NotificationProviderError('pushplus_auth_failed');
  }
  async createWechatQr(content: string, expiresIn: number): Promise<string> {
    const body = await this.openApi(`friend/getQrCode?content=${encodeURIComponent(content)}&second=${Math.min(600, Math.max(60, expiresIn))}&scanCount=1`);
    if (typeof body.data?.qrCodeImgUrl !== 'string') throw new NotificationProviderError('invalid_qr_image');
    return qrUrl(body.data.qrCodeImgUrl).toString();
  }
  async fetchQrImage(value: string): Promise<{ body: Buffer; contentType: string }> {
    const response = await this.fetcher(qrUrl(value), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const contentType = (response.headers.get('content-type') || '').split(';')[0];
    if (!response.ok || !['image/png', 'image/jpeg', 'image/gif'].includes(contentType) || Number(response.headers.get('content-length') || 0) > 1_000_000 || !response.body) throw new NotificationProviderError('invalid_qr_image');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 1_000_000) throw new NotificationProviderError('invalid_qr_image'); chunks.push(chunk); }
    return { body: Buffer.concat(chunks), contentType };
  }
  async findWechatFriend(target: string): Promise<VerifiedFriend | null> {
    if (!/^[a-zA-Z0-9]{32}$/.test(target)) return null;
    // Group pilot is 5–20 users. Bounded pagination also rejects unexpectedly huge accounts.
    for (let current = 1; current <= 20; current++) {
      const body = await this.openApi('friend/list', { current, pageSize: 50 });
      if (!Array.isArray(body.data?.list) || !Number.isInteger(body.data.pages) || body.data.pages > 20) throw new NotificationProviderError('friend_list_invalid');
      const friend = body.data.list.find((row: Json) => row.token === target && row.isFollow === 1);
      if (friend) return { target, displayName: typeof friend.nickName === 'string' ? friend.nickName.slice(0, 80) : '已验证的微信账号' };
      if (current >= body.data.pages) return null;
    }
    return null;
  }
  async send(input: DeliveryRequest): Promise<ProviderResult> {
    if (input.channel !== 'feishu' && input.channel !== 'wechat') return { status: 'permanent_failed', errorCode: 'invalid_channel' };
    if (!this.configured(input.channel)) return { status: 'permanent_failed', errorCode: 'channel_unconfigured' };
    if (input.title.length > 200 || input.text.length > 12_000 || !input.text || !input.idempotencyKey) return { status: 'permanent_failed', errorCode: 'invalid_message' };
    if ((input.channel === 'feishu' && !/^ou_[a-zA-Z0-9_-]{4,128}$/.test(input.target)) || (input.channel === 'wechat' && !/^[a-zA-Z0-9]{32}$/.test(input.target))) return { status: 'permanent_failed', errorCode: 'invalid_target' };
    let token: string | undefined;
    if (input.channel === 'feishu') {
      try { token = await this.tenantToken(); } catch { return { status: 'retryable_failed', errorCode: 'feishu_auth_unavailable', retryAfterMs: 60_000 }; }
    }
    try {
      if (input.beforeSend && !input.beforeSend()) return { status: 'permanent_failed', errorCode: 'cancelled_before_send' };
      const result = input.channel === 'feishu'
        ? await this.request('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', this.post({ receive_id: input.target, msg_type: 'text', content: JSON.stringify({ text: `${input.title}\n${input.text}` }), uuid: createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 50) }, { Authorization: `Bearer ${token}` }))
        : await this.request('https://www.pushplus.plus/send', this.post({ token: this.config.pushplus!.token, to: input.target, channel: 'wechat', title: input.title, content: input.text, template: 'txt' }));
      const { response, body } = result;
      if (response.status === 429 || body.code === 429 || body.code === 99991400) {
        const after = Number(response.headers.get('retry-after'));
        return { status: 'retryable_failed', errorCode: 'provider_rate_limited', retryAfterMs: Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 3_600_000) : 60_000 };
      }
      if (response.status >= 500) return { status: 'unknown', errorCode: 'provider_server_error' };
      if (input.channel === 'feishu' && (response.status === 401 || body.code === 99991663 || body.code === 99991668)) {
        this.feishuToken = undefined;
        return { status: 'retryable_failed', errorCode: 'feishu_auth_rejected', retryAfterMs: 60_000 };
      }
      if (!response.ok) return { status: 'permanent_failed', errorCode: `provider_http_${response.status}` };
      if (input.channel === 'feishu') {
        if (body.code === 0 && typeof body.data?.message_id === 'string') return { status: 'accepted', providerMessageId: body.data.message_id };
        if (typeof body.code === 'number' && body.code !== 0) return { status: 'permanent_failed', errorCode: `feishu_${body.code}` };
      } else {
        if (body.code === 200 && typeof body.data === 'string' && body.data) return { status: 'accepted', providerMessageId: body.data };
        if (body.code === 500) return { status: 'unknown', errorCode: 'pushplus_server_error' };
        if (typeof body.code === 'number' && body.code !== 200) return { status: 'permanent_failed', errorCode: `pushplus_${body.code}` };
      }
      return { status: 'unknown', errorCode: 'provider_response_invalid' };
    } catch { return { status: 'unknown', errorCode: 'provider_transport_uncertain' }; }
  }
  async query(channel: ExternalChannel, providerMessageId: string): Promise<ProviderResult> {
    if (channel !== 'wechat' || !/^[a-zA-Z0-9_-]{1,128}$/.test(providerMessageId)) return { status: 'unknown', errorCode: 'query_unavailable' };
    try {
      const body = await this.openApi(`message/sendMessageResult?shortCode=${encodeURIComponent(providerMessageId)}`);
      if (body.data?.status === 2) return { status: 'provider_confirmed', providerMessageId };
      if (body.data?.status === 3) return { status: 'permanent_failed', providerMessageId, errorCode: 'pushplus_delivery_failed' };
      if (body.data?.status === 0 || body.data?.status === 1) return { status: 'accepted', providerMessageId };
      return { status: 'unknown', providerMessageId, errorCode: 'provider_response_invalid' };
    } catch { return { status: 'unknown', providerMessageId, errorCode: 'query_unavailable' }; }
  }
}
