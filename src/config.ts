import { resolve } from 'node:path';
import type { NotificationProviderConfig } from './notification-providers';

export interface NotificationConfig {
  workerEnabled: boolean;
  schedulerEnabled: boolean;
  pollIntervalMs: number;
  providers: NotificationProviderConfig;
}

export interface AppConfig {
  origin: string;
  databasePath: string;
  secret: string;
  machineToken: string;
  secureCookies: boolean;
  development: boolean;
  host: string;
  port: number;
  notifications?: NotificationConfig;
  mail: {
    mode: 'smtp' | 'local';
    host?: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
    localPath?: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const origin = new URL(env.MEMBER_ORIGIN || 'http://127.0.0.1:5190');
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('MEMBER_ORIGIN must contain only the scheme and host');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  const development = env.NODE_ENV !== 'production' && env.MEMBER_ALLOW_INSECURE_LOCAL === 'true' && loopback;
  if (origin.protocol !== 'https:' && !(development && origin.protocol === 'http:')) throw new Error('HTTPS required; local HTTP needs MEMBER_ALLOW_INSECURE_LOCAL=true');
  const secret = env.MEMBER_SECRET || '';
  if (Buffer.byteLength(secret) < 32) throw new Error('MEMBER_SECRET must contain at least 32 bytes of random secret');
  const machineToken = env.MEMBER_MACHINE_TOKEN || '';
  if ((env.NODE_ENV === 'production' || machineToken) && Buffer.byteLength(machineToken) < 32) throw new Error('MEMBER_MACHINE_TOKEN must contain at least 32 bytes');
  const host = env.MEMBER_HOST || '127.0.0.1';
  if (development && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Local development must bind to loopback');
  const port = integer(env.MEMBER_PORT || '5190', 'MEMBER_PORT');
  const mode = env.MEMBER_MAIL_MODE || 'smtp';
  if (mode !== 'smtp' && mode !== 'local') throw new Error('Invalid MEMBER_MAIL_MODE');
  if (mode === 'local' && !development) throw new Error('Local mail sink is restricted to explicit loopback development');
  if (mode === 'smtp' && (!env.MEMBER_SMTP_HOST || !env.MEMBER_SMTP_FROM)) throw new Error('SMTP host and from address are required');
  if (Boolean(env.MEMBER_SMTP_USER) !== Boolean(env.MEMBER_SMTP_PASSWORD)) throw new Error('SMTP username and password must be configured together');
  const from = env.MEMBER_SMTP_FROM || 'FeishuBrief <local@localhost.invalid>';
  if (/[\r\n]/.test(from)) throw new Error('Invalid SMTP from address');
  return {
    origin: origin.origin, databasePath: resolve(env.MEMBER_DATABASE_PATH || 'data/member.sqlite'), secret, machineToken,
    secureCookies: !development, development, host, port, notifications: notificationConfig(env),
    mail: { mode, host: env.MEMBER_SMTP_HOST, port: integer(env.MEMBER_SMTP_PORT || '465', 'MEMBER_SMTP_PORT'),
      secure: env.MEMBER_SMTP_SECURE !== 'false', user: env.MEMBER_SMTP_USER, password: env.MEMBER_SMTP_PASSWORD,
      from, localPath: mode === 'local' ? resolve(env.MEMBER_LOCAL_MAIL_PATH || 'data/local-mail') : undefined },
  };
}
export function notificationConfig(env: NodeJS.ProcessEnv): NotificationConfig {
  const workerEnabled = flag(env.MEMBER_NOTIFICATION_WORKER_ENABLED, 'MEMBER_NOTIFICATION_WORKER_ENABLED');
  const schedulerEnabled = flag(env.MEMBER_SCHEDULER_ENABLED, 'MEMBER_SCHEDULER_ENABLED');
  if (schedulerEnabled && !workerEnabled) throw new Error('MEMBER_SCHEDULER_ENABLED requires MEMBER_NOTIFICATION_WORKER_ENABLED');
  const pollIntervalMs = Number(env.MEMBER_NOTIFICATION_POLL_MS || '15000');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60000) throw new Error('MEMBER_NOTIFICATION_POLL_MS must be between 1000 and 60000');
  const providers: NotificationProviderConfig = {};
  const feishu = [env.MEMBER_FEISHU_APP_ID, env.MEMBER_FEISHU_APP_SECRET, env.MEMBER_FEISHU_ENCRYPT_KEY, env.MEMBER_FEISHU_VERIFICATION_TOKEN];
  if (feishu.some(Boolean)) {
    if (!feishu.every(value => value && value.trim() === value)) throw new Error('Configure all four MEMBER_FEISHU credentials together');
    providers.feishu = { appId: feishu[0]!, appSecret: feishu[1]!, encryptKey: feishu[2]!, verificationToken: feishu[3]! };
  }
  const pushplus = [env.MEMBER_PUSHPLUS_TOKEN, env.MEMBER_PUSHPLUS_SECRET_KEY];
  if (pushplus.some(Boolean)) {
    if (!pushplus.every(value => value && value.trim() === value)) throw new Error('Configure MEMBER_PUSHPLUS_TOKEN and MEMBER_PUSHPLUS_SECRET_KEY together');
    providers.pushplus = { token: pushplus[0]!, secretKey: pushplus[1]! };
  }
  return { workerEnabled, schedulerEnabled, pollIntervalMs, providers };
}
function flag(value: string | undefined, name: string): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false`);
}
function integer(value: string, name: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error(`Invalid ${name}`);
  return result;
}
