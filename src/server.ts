import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadConfig, type AppConfig } from "./config";
import { Store } from "./db";
import { AuthService, AuthError } from "./auth";
import { createMailer, type Mailer } from "./mail";
import { ContentService, ContentError } from "./content";
import { verifyEngineExport } from "./proof";
import { securityHeaders } from "./security";
import { PlatformNotificationProvider, NotificationProviderError, type BindingProvider, type ExternalChannel } from "./notification-providers";
import { NotificationBindings, NotificationBindingError } from "./notification-bindings";
import { NotificationQueue, cancelPendingForMember } from "./notification-queue";
import { NotificationScheduler } from "./notification-scheduler";
import { NotificationRuntime } from "./notification-runtime";

const prefix = "/api/member/";
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const cookieValue = (req: IncomingMessage, name: string) => {
  const entry = (req.headers.cookie || "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  if (entry.length !== 1) return "";
  const value = entry[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : "";
};
function json(res: ServerResponse, status: number, value?: unknown) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Vary", "Cookie");
  if (status === 204) { res.end(); return; }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}
async function readRawBody(req: IncomingMessage, limit = 65536): Promise<Buffer> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw new AuthError(415, "json_required");
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new AuthError(415, "unsupported_encoding");
  if (Number(req.headers["content-length"] || 0) > limit) throw new AuthError(413, "request_too_large");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AuthError(413, "request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readBody(req: IncomingMessage, limit = 65536): Promise<unknown> {
  const raw = await readRawBody(req, limit);
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw new AuthError(400, "invalid_json"); }
}

export function createApplication(config: AppConfig, options: { store?: Store; mail?: Mailer; clock?: () => number; consoleDir?: string; notificationProvider?: BindingProvider } = {}) {
  const store = options.store || new Store(config.databasePath);
  const clock = options.clock || Date.now;
  const content = new ContentService(store, { now: () => new Date(clock()), verifyExport: verifyEngineExport });
  const notificationConfig = config.notifications || { workerEnabled: false, schedulerEnabled: false, pollIntervalMs: 15000, providers: {} };
  const provider = options.notificationProvider || new PlatformNotificationProvider(notificationConfig.providers, { clock });
  const bindings = new NotificationBindings(store, { secret: config.secret, origin: config.origin, provider, clock,
    feishu: notificationConfig.providers.feishu,
    onUnbind: (memberId, channel) => cancelPendingForMember(store, memberId, "binding_unbound", clock(), channel) });
  const channels = (["feishu", "wechat"] as ExternalChannel[]).filter(channel => provider.configured(channel));
  const queue = new NotificationQueue(store, { content, bindings, provider, origin: config.origin, clock,
    enabledChannels: notificationConfig.workerEnabled ? channels : [] });
  const scheduler = new NotificationScheduler(store, { content, queue, clock, enabled: notificationConfig.workerEnabled && notificationConfig.schedulerEnabled });
  const runtime = new NotificationRuntime({ enabled: notificationConfig.workerEnabled, pollIntervalMs: notificationConfig.pollIntervalMs, clock,
    schedule: () => scheduler.tick(), deliver: () => queue.runOnce({ limit: 5 }) });
  const auth = new AuthService(store, { secret: config.secret, origin: config.origin, mail: options.mail || createMailer(config), clock,
    onGrantsChanged: memberId => {
      cancelPendingForMember(store, memberId, "member_grants_changed", clock());
      bindings.invalidateChallenges(memberId);
    } });
  const cookieName = config.secureCookies ? "__Host-feishubrief_session" : "feishubrief_session";
  const challengeName = config.secureCookies ? "__Host-feishubrief_challenge" : "feishubrief_challenge";
  const setCookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? "; Secure" : ""}`;
  const origin = (req: IncomingMessage) => {
    if (req.headers.origin !== config.origin || req.headers["sec-fetch-site"] === "cross-site") throw new AuthError(403, "origin_rejected");
  };
  const root = options.consoleDir ? fs.realpathSync(options.consoleDir) : null;
  const server = createServer(async (req, res) => {
    securityHeaders(res, "/api/", config.secureCookies);
    try {
      const url = new URL(req.url || "/", config.origin);
      securityHeaders(res, url.pathname, config.secureCookies);
      if (url.search) throw new AuthError(400, "query_parameters_not_supported");
      const method = req.method || "GET";
      if (url.pathname === "/health" && method === "GET") { store.db.prepare("SELECT 1").get(); json(res, 200, { status: "ok" }); return; }
      if (!url.pathname.startsWith(prefix)) {
        if (!root || method !== "GET") throw new AuthError(404, "not_found");
        if (url.pathname === "/") { res.statusCode = 302; res.setHeader("Location", "/app"); res.end(); return; }
        const requestPath = decodeURIComponent(url.pathname);
        const name = requestPath === "/" || /^\/(app|admin)(\/.*)?$/.test(requestPath) ? "index.html" : requestPath.replace(/^\/+/, "");
        const file = path.resolve(root, name);
        const rel = path.relative(root, file);
        if (rel.startsWith("..") || path.isAbsolute(rel) || !/\.(?:html|js|css|svg|ico|png|woff2?)$/.test(file) || !fs.existsSync(file)) throw new AuthError(404, "not_found");
        const actual = fs.realpathSync(file);
        const actualRel = path.relative(root, actual);
        if (actualRel.startsWith("..") || path.isAbsolute(actualRel) || !fs.statSync(actual).isFile()) throw new AuthError(404, "not_found");
        const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2" };
        res.setHeader("Content-Type", mime[path.extname(file)]);
        res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Frame-Options", "DENY");
        // The Console also builds for relative GitHub Pages hosting. On this same-origin server,
        // root-based assets keep /app/, invitations and future private deep links working.
        const surface = /^\/admin(?:\/|$)/.test(requestPath) ? "admin" : "member";
        res.end(path.extname(actual) === ".html" ? fs.readFileSync(actual, "utf8").replace(/<head>/i,
          `<head><base href="/"><meta name="feishubrief-surface" content="${surface}">`) : fs.readFileSync(actual)); return;
      }
      const route = url.pathname.slice(prefix.length);
      // These exact callbacks have platform proof instead of browser sessions/CSRF.
      // Preserve the original bytes for Feishu signature validation.
      if (route === "webhooks/feishu" && method === "POST") {
        const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, typeof value === "string" ? value : undefined]));
        json(res, 200, bindings.handleFeishu(await readRawBody(req), headers)); return;
      }
      if (route === "webhooks/pushplus" && method === "POST") {
        await bindings.handlePushplus(await readBody(req)); json(res, 200, { code: 200, msg: "success" }); return;
      }
      if (route.startsWith("machine/")) {
        const token = config.machineToken || "";
        if (token.length < 32 || !equal(req.headers.authorization || "", `Bearer ${token}`)) throw new AuthError(401, "machine_auth_required");
        if (route === "machine/catalog" && method === "GET") { json(res, 200, content.catalog()); return; }
        if (route === "machine/imports" && method === "POST") { json(res, 200, content.importExport(await readBody(req, 20 * 1024 * 1024))); return; }
        if (route === "machine/revocations" && method === "POST") { json(res, 200, content.importRevocations(await readBody(req, 20 * 1024 * 1024))); return; }
        throw new AuthError(404, "not_found");
      }
      if (req.headers["sec-fetch-site"] === "cross-site") throw new AuthError(403, "cross_site_request");
      if (route === "auth/config" && method === "GET") { json(res, 200, { registrationMode: "invite-only", emailLogin: true }); return; }
      if (route === "auth/request-code" && method === "POST") {
        origin(req);
        const input = z.object({ email: z.string().max(254), invitationToken: z.string().max(256).optional() }).strict().parse(await readBody(req));
        const result = await auth.startLogin(input, req.socket.remoteAddress || "unknown");
        res.setHeader("Set-Cookie", setCookie(challengeName, result.browserToken, 600));
        json(res, 202, { challengeId: result.challengeId }); return;
      }
      if (route === "auth/verify-code" && method === "POST") {
        origin(req);
        const input = z.object({ challengeId: z.string().max(128), code: z.string().max(16) }).strict().parse(await readBody(req));
        const result = auth.verifyLogin(input, cookieValue(req, challengeName), req.socket.remoteAddress || "unknown");
        res.setHeader("Set-Cookie", [setCookie(cookieName, result.sessionToken, 7 * 86400), setCookie(challengeName, "", 0)]);
        json(res, 200, result.session); return;
      }
      const actor = auth.authenticate(cookieValue(req, cookieName));
      if (!actor) throw new AuthError(401, "session_required");
      if (!["GET", "HEAD"].includes(method)) {
        origin(req);
        if (!equal(String(req.headers["x-csrf-token"] || ""), actor.csrfToken)) throw new AuthError(403, "csrf_rejected");
      }
      if (route === "session" && method === "GET") { json(res, 200, auth.sessionEnvelope(actor)); return; }
      if (route === "capabilities" && method === "GET") {
        json(res, 200, { ...content.capabilities(actor), notificationBindings: true,
          personalDelivery: { enabled: notificationConfig.workerEnabled && channels.length > 0, phase: 6, channels },
          scheduler: { enabled: notificationConfig.workerEnabled && notificationConfig.schedulerEnabled, phase: 6 } }); return;
      }
      if (route === "notifications" && method === "GET") {
        json(res, 200, { channels: bindings.channels(), bindings: bindings.list(actor), schedule: scheduler.get(actor), deliveries: queue.list(actor).deliveries }); return;
      }
      const bindingStart = route.match(/^notifications\/bindings\/(feishu|wechat)\/start$/);
      if (bindingStart && method === "POST") {
        z.object({}).strict().parse(await readBody(req)); json(res, 201, await bindings.start(actor, bindingStart[1] as ExternalChannel)); return;
      }
      const challenge = route.match(/^notifications\/challenges\/([a-zA-Z0-9_-]{1,128})(?:\/(confirm|qr))?$/);
      if (challenge) {
        if (!challenge[2] && method === "GET") { json(res, 200, bindings.challenge(actor, challenge[1])); return; }
        if (challenge[2] === "confirm" && method === "POST") { json(res, 200, { binding: bindings.confirm(actor, challenge[1], await readBody(req)) }); return; }
        if (challenge[2] === "qr" && method === "GET") {
          const qr = await bindings.qr(actor, challenge[1]);
          res.statusCode = 200; res.setHeader("Content-Type", qr.contentType); res.setHeader("Vary", "Cookie"); res.end(qr.body); return;
        }
      }
      const binding = route.match(/^notifications\/bindings\/([a-zA-Z0-9_-]{1,128})$/);
      if (binding && method === "DELETE") {
        z.object({}).strict().parse(await readBody(req)); bindings.unbind(actor, binding[1]); json(res, 200, { ok: true }); return;
      }
      if (route === "notifications/schedule" && method === "GET") { json(res, 200, scheduler.get(actor)); return; }
      if (route === "notifications/schedule" && method === "PUT") { json(res, 200, scheduler.put(actor, await readBody(req))); return; }
      if (route === "notifications/deliveries" && method === "GET") { json(res, 200, queue.list(actor)); return; }
      if (route === "notifications/deliveries" && method === "POST") { json(res, 201, queue.enqueue(actor, await readBody(req))); return; }
      if (route === "admin/deliveries" && method === "GET") { json(res, 200, queue.adminList(actor)); return; }
      const deliveryAction = route.match(/^admin\/deliveries\/([a-zA-Z0-9_-]{1,128})\/(resend|reconcile|review)$/);
      if (deliveryAction && method === "POST") {
        const body = z.record(z.string(), z.unknown()).parse(await readBody(req));
        if ("intentId" in body || "sourceIntentId" in body) throw new AuthError(400, "invalid_request");
        json(res, 200, deliveryAction[2] === "resend"
          ? queue.adminResend(actor, { ...body, sourceIntentId: deliveryAction[1] })
          : deliveryAction[2] === "review" ? queue.adminReview(actor, { ...body, intentId: deliveryAction[1] })
          : await queue.reconcile(actor, { ...body, intentId: deliveryAction[1] })); return;
      }
      if (route === "logout" && method === "POST") {
        z.object({}).strict().parse(await readBody(req)); auth.logout(actor);
        res.setHeader("Set-Cookie", setCookie(cookieName, "", 0)); json(res, 204); return;
      }
      if (route === "topics" && method === "GET") { json(res, 200, content.topics(actor)); return; }
      if (route === "radar" && method === "GET") { json(res, 200, content.radar(actor)); return; }
      if (route === "library" && method === "GET") { json(res, 200, content.library(actor)); return; }
      if (route === "preferences" && method === "GET") { json(res, 200, content.getPreferences(actor)); return; }
      if (route === "preferences" && method === "PUT") { json(res, 200, content.putPreferences(actor, await readBody(req))); return; }
      if (route === "subscription" && method === "GET") { json(res, 200, content.getSubscription(actor)); return; }
      if (route === "subscription" && method === "PUT") { json(res, 200, content.putSubscription(actor, await readBody(req))); return; }
      if (route === "preview" && method === "POST") { json(res, 200, content.preview(actor, await readBody(req))); return; }
      if (route === "editions" && method === "GET") { json(res, 200, content.listEditions(actor)); return; }
      if (route === "editions" && method === "POST") { json(res, 201, content.createEdition(actor, await readBody(req))); return; }
      const edition = route.match(/^editions\/([a-f0-9]{64})$/);
      if (edition && method === "GET") { json(res, 200, content.edition(actor, edition[1])); return; }
      if (route === "feedback" && method === "POST") { json(res, 201, content.feedback(actor, await readBody(req))); return; }
      if (route === "feedback" && method === "GET") { json(res, 200, content.getFeedback(actor)); return; }
      if (route === "admin/operations" && method === "GET") {
        json(res, 200, { ...content.operations(actor),
          delivery: { ...queue.summary(actor), worker: runtime.status() },
          scheduler: scheduler.summary(actor) }); return;
      }
      if (route === "admin/members" && method === "GET") { json(res, 200, { members: auth.listMembers(actor) }); return; }
      if (route === "admin/invitations" && method === "GET") { json(res, 200, { invitations: auth.listInvitations(actor) }); return; }
      if (route === "admin/invitations" && method === "POST") { json(res, 201, await auth.createInvitation(actor, await readBody(req))); return; }
      const member = route.match(/^admin\/members\/([0-9a-f-]{36})$/);
      if (member && method === "PUT") { json(res, 200, { member: auth.updateUser(actor, member[1], await readBody(req)) }); return; }
      if (route === "admin/audit" && method === "GET") { json(res, 200, { events: auth.getAudit(actor) }); return; }
      if (route === "admin/topics" && method === "GET") { json(res, 200, content.catalog(actor)); return; }
      const topic = route.match(/^admin\/topics\/([a-z0-9-]{1,60})$/);
      if (topic && method === "PUT") { json(res, 200, content.putTopic(actor, topic[1], await readBody(req))); return; }
      if (topic && method === "DELETE") { json(res, 200, content.deleteTopic(actor, topic[1], await readBody(req))); return; }
      if (route === "admin/revocations" && method === "POST") { json(res, 200, content.revoke(actor, await readBody(req))); return; }
      throw new AuthError(404, "not_found");
    } catch (error) {
      if (error instanceof AuthError || error instanceof ContentError || error instanceof NotificationBindingError) json(res, error.status, { error: error.code });
      else if (error instanceof NotificationProviderError) json(res, 503, { error: error.code });
      else if (error instanceof z.ZodError || error instanceof URIError) json(res, 400, { error: "invalid_request" });
      else json(res, 500, { error: "internal_error" });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  return { server, store, auth, content, bindings, queue, scheduler, runtime, cookieName };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = loadConfig();
  const app = createApplication(config, { consoleDir: process.env.MEMBER_CONSOLE_DIR });
  app.server.listen(config.port, config.host, () => {
    app.runtime.start();
    console.log(`Member Service listening on ${config.host}:${config.port}; registration=invite-only`);
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const closed = new Promise<void>(resolve => app.server.close(() => resolve()));
    await app.runtime.stop(); await closed;
    app.store.close(); process.exitCode = 0;
  };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}
