import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformNotificationProvider, type DeliveryRequest, type NotificationProviderConfig } from '../src/notification-providers.js';

const config: NotificationProviderConfig = {
  feishu: { appId: 'cli_synthetic', appSecret: 'synthetic-app-secret', encryptKey: 'synthetic-encrypt', verificationToken: 'synthetic-verification' },
  pushplus: { token: 'synthetic-sender-token', secretKey: 'synthetic-open-api-secret' },
};
const request: DeliveryRequest = { channel: 'feishu', target: 'ou_synthetic_user', title: '测试', text: '私有版本可在 Console 登录查看。', idempotencyKey: 'synthetic-intent-1' };
function json(body: unknown, status = 200, headers: Record<string, string> = {}) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }); }

test('Feishu sends to exactly one open_id with stable provider uuid; never group chat', async () => {
  const calls: { url: string; body: any; init: RequestInit }[] = [];
  const provider = new PlatformNotificationProvider(config, { fetch: (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), init: init! });
    return calls.length === 1 ? json({ code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 }) : json({ code: 0, data: { message_id: 'om_synthetic_message' } });
  }) as typeof fetch });
  assert.deepEqual(await provider.send(request), { status: 'accepted', providerMessageId: 'om_synthetic_message' });
  await provider.send(request);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].url.endsWith('?receive_id_type=open_id'));
  assert.equal(calls[1].body.receive_id, request.target);
  assert.equal(calls[1].body.uuid, calls[2].body.uuid);
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal((await provider.send({ ...request, target: 'oc_groupchat' })).status, 'permanent_failed');
  assert.equal(calls.length, 3);
});

test('provider token refresh is followed by final cancellation guard before POST', async () => {
  let called = 0, enabled = true;
  const provider = new PlatformNotificationProvider(config, { fetch: (async () => { called++; enabled = false; return json({ code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 }); }) as typeof fetch });
  assert.deepEqual(await provider.send({ ...request, beforeSend: () => enabled }), { status: 'permanent_failed', errorCode: 'cancelled_before_send' });
  assert.equal(called, 1);
});

test('ambiguous POST timeouts, 5xx and invalid success responses never become automatic retries', async () => {
  for (const outcome of ['timeout', 'server-error', 'malformed', 'missing-id']) {
    const provider = new PlatformNotificationProvider(config, { fetch: (async url => {
      if (String(url).includes('/auth/')) return json({ code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 });
      if (outcome === 'timeout') throw new Error('synthetic timeout with sensitive provider detail');
      if (outcome === 'server-error') return json({ code: 500 }, 500);
      if (outcome === 'malformed') return new Response('not json');
      return json({ code: 0 });
    }) as typeof fetch });
    const result = await provider.send(request);
    assert.equal(result.status, 'unknown');
    assert.ok(!JSON.stringify(result).includes('sensitive'));
  }
});

test('explicit throttle retries but PushPlus account ban is a permanent stop', async () => {
  const throttled = new PlatformNotificationProvider(config, { fetch: (async () => json({ code: 429 }, 429, { 'retry-after': '90' })) as typeof fetch });
  assert.deepEqual(await throttled.send({ ...request, channel: 'wechat', target: 'a'.repeat(32) }), { status: 'retryable_failed', errorCode: 'provider_rate_limited', retryAfterMs: 90_000 });
  const banned = new PlatformNotificationProvider(config, { fetch: (async () => json({ code: 900, msg: 'sensitive message' })) as typeof fetch });
  assert.deepEqual(await banned.send({ ...request, channel: 'wechat', target: 'a'.repeat(32) }), { status: 'permanent_failed', errorCode: 'pushplus_900' });
});

test('PushPlus uses one friend, no topic, cached expiring access key and separate confirmed state', async () => {
  let now = 0, keys = 0;
  const calls: { url: string; body: any; init: RequestInit }[] = [];
  const provider = new PlatformNotificationProvider(config, { clock: () => now, fetch: (async (url, init) => {
    const href = String(url); calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : undefined, init: init! });
    if (href.endsWith('getAccessKey')) { keys++; return json({ code: 200, data: { accessKey: `synthetic-key-${keys}`, expiresIn: 7200 } }); }
    if (href.endsWith('/send')) return json({ code: 200, data: 'synthetic-short-code' });
    if (href.includes('getQrCode')) return json({ code: 200, data: { qrCodeImgUrl: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=synthetic' } });
    if (href.endsWith('/friend/list')) return json({ code: 200, data: { pages: 1, list: [{ token: 'a'.repeat(32), nickName: 'Synthetic Friend', isFollow: 1 }] } });
    return json({ code: 200, data: { status: 2 } });
  }) as typeof fetch });
  assert.equal((await provider.send({ ...request, channel: 'wechat', target: 'a'.repeat(32) })).status, 'accepted');
  const send = calls[0].body;
  assert.equal(send.to, 'a'.repeat(32)); assert.equal(send.channel, 'wechat'); assert.ok(!('topic' in send));
  assert.equal(await provider.createWechatQr('synthetic-proof', 600), 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=synthetic');
  assert.deepEqual(await provider.findWechatFriend('a'.repeat(32)), { target: 'a'.repeat(32), displayName: 'Synthetic Friend' });
  assert.deepEqual(await provider.query('wechat', 'synthetic-short-code'), { status: 'provider_confirmed', providerMessageId: 'synthetic-short-code' });
  assert.equal(provider.canQuery('wechat'), true); assert.equal(provider.canQuery('feishu'), false);
  assert.equal(keys, 1);
  now += 7200_000;
  await provider.query('wechat', 'synthetic-short-code');
  assert.equal(keys, 2);
  assert.equal((await provider.send({ ...request, channel: 'wechat', target: 'a'.repeat(32) + ',' + 'b'.repeat(32) })).status, 'permanent_failed');
});

test('QR proxy only fetches fixed HTTPS WeChat endpoint and raster images without redirects', async () => {
  let calls = 0;
  const provider = new PlatformNotificationProvider(config, { fetch: (async (_url, init) => { calls++; assert.equal(init?.redirect, 'error'); return new Response(Buffer.from('synthetic-image'), { headers: { 'Content-Type': 'image/png' } }); }) as typeof fetch });
  for (const url of ['http://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=x', 'https://localhost/cgi-bin/showqrcode?ticket=x', 'https://mp.weixin.qq.com.evil.test/cgi-bin/showqrcode?ticket=x', 'https://user:pass@mp.weixin.qq.com/cgi-bin/showqrcode?ticket=x', 'https://mp.weixin.qq.com/other?ticket=x']) await assert.rejects(provider.fetchQrImage(url));
  assert.equal(calls, 0);
  assert.equal((await provider.fetchQrImage('https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=synthetic')).contentType, 'image/png');
  assert.equal(calls, 1);
  const html = new PlatformNotificationProvider(config, { fetch: (async () => new Response('<script>', { headers: { 'Content-Type': 'text/html' } })) as typeof fetch });
  await assert.rejects(html.fetchQrImage('https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=synthetic'));
});

test('explicit authentication rejection clears credentials; no transparent message POST retry', async () => {
  let feishuKeys = 0, sends = 0;
  const provider = new PlatformNotificationProvider(config, { fetch: (async url => {
    if (String(url).includes('/auth/')) { feishuKeys++; return json({ code: 0, tenant_access_token: `synthetic-${feishuKeys}`, expire: 7200 }); }
    sends++;
    return sends === 1 ? json({ code: 99991668 }, 401) : json({ code: 0, data: { message_id: 'om_synthetic' } });
  }) as typeof fetch });
  assert.equal((await provider.send(request)).status, 'retryable_failed');
  assert.equal(sends, 1);
  assert.equal((await provider.send(request)).status, 'accepted');
  assert.equal(feishuKeys, 2);

  let accessKeys = 0, queries = 0;
  const pushplus = new PlatformNotificationProvider(config, { fetch: (async url => {
    if (String(url).includes('getAccessKey')) { accessKeys++; return json({ code: 200, data: { accessKey: `synthetic-${accessKeys}`, expiresIn: 7200 } }); }
    queries++;
    return queries === 1 ? json({ code: 401 }, 401) : json({ code: 200, data: { status: 1 } });
  }) as typeof fetch });
  assert.equal((await pushplus.query('wechat', 'synthetic')).status, 'accepted');
  assert.equal(accessKeys, 2);
});
