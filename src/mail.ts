import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AppConfig } from './config.js';

export interface MailMessage { to: string; subject: string; text: string }
export interface Mailer { send(message: MailMessage): Promise<void> }

export function createMailer(config: AppConfig): Mailer {
  if (config.mail.mode === 'local') {
    if (!config.development || !config.mail.localPath || !['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('Local mail is allowed only on explicit loopback development');
    const directory = config.mail.localPath;
    return { async send(message) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // A developer-only mailbox, outside public assets. Never output credentials to logs.
      await writeFile(join(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(message), { mode: 0o600, flag: 'wx' });
    } };
  }
  const transport = nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
    requireTLS: true, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return { async send(message) {
    await transport.sendMail({ from: config.mail.from, to: message.to, subject: message.subject, text: message.text });
  } };
}
