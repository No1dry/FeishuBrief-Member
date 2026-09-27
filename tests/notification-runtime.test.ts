import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationRuntime } from '../src/notification-runtime';
import { notificationConfig } from '../src/config';

test('notification runtime serializes ticks, drains on shutdown and suppresses private exception details', async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new NotificationRuntime({ enabled: true, pollIntervalMs: 1000, schedule: () => { calls++; }, deliver: () => gate });
  const one = runtime.runOnce(), two = runtime.runOnce();
  assert.equal(one, two); await Promise.resolve();
  assert.equal(calls, 1);
  let stopped = false; const stop = runtime.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release(); await stop; assert.equal(runtime.status().lastOutcome, 'ok');
  await runtime.runOnce(); assert.equal(calls, 1);
  const failed = new NotificationRuntime({ enabled: true, pollIntervalMs: 1000, schedule: () => { throw new Error('synthetic-private-token'); }, deliver: async () => { calls++; } });
  await failed.runOnce(); assert.equal(failed.status().lastOutcome, 'failed');
  assert.ok(!JSON.stringify(failed.status()).includes('synthetic-private-token'));
  const disabled = new NotificationRuntime({ enabled: false, pollIntervalMs: 1000, schedule: () => { calls++; }, deliver: async () => { calls++; } });
  disabled.start(); await disabled.runOnce(); assert.equal(calls, 1); await disabled.stop();
});

test('personal notification configuration is explicit, independent of group credentials and fails on partial configuration', () => {
  assert.deepEqual(notificationConfig({ FEISHU_APP_ID: 'existing-group', PUSHPLUS_TOKEN: 'existing-group' }), {
    workerEnabled: false, schedulerEnabled: false, pollIntervalMs: 15000, providers: {},
  });
  assert.throws(() => notificationConfig({ MEMBER_NOTIFICATION_WORKER_ENABLED: 'yes' }));
  assert.throws(() => notificationConfig({ MEMBER_SCHEDULER_ENABLED: 'true' }));
  assert.throws(() => notificationConfig({ MEMBER_NOTIFICATION_POLL_MS: '0' }));
  assert.throws(() => notificationConfig({ MEMBER_FEISHU_APP_ID: 'partial' }));
  assert.throws(() => notificationConfig({ MEMBER_PUSHPLUS_TOKEN: 'partial' }));
  const config = notificationConfig({ MEMBER_NOTIFICATION_WORKER_ENABLED: 'true', MEMBER_SCHEDULER_ENABLED: 'true',
    MEMBER_FEISHU_APP_ID: 'app', MEMBER_FEISHU_APP_SECRET: 'secret', MEMBER_FEISHU_ENCRYPT_KEY: 'encrypt', MEMBER_FEISHU_VERIFICATION_TOKEN: 'verification',
    MEMBER_PUSHPLUS_TOKEN: 'sender', MEMBER_PUSHPLUS_SECRET_KEY: 'secret-key' });
  assert.equal(config.schedulerEnabled, true); assert.equal(config.providers.feishu!.appId, 'app');
  assert.equal(config.providers.pushplus!.secretKey, 'secret-key');
});
