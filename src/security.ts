import type { ServerResponse } from "node:http";

/** Document policy follows the actual server path. A surface change must load a new document. */
export function contentSecurityPolicy(pathname: string, production: boolean): string {
  const api = pathname.startsWith("/api/") || pathname === "/health";
  if (api) return "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'";
  const admin = /^\/admin(?:\/|$)/.test(pathname);
  return ["default-src 'none'", "base-uri 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", `connect-src 'self'${admin ? " https://api.github.com" : ""}`,
    "manifest-src 'self'", "object-src 'none'", "frame-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
    ...(production ? ["upgrade-insecure-requests"] : [])].join("; ");
}

export function securityHeaders(response: ServerResponse, pathname: string, production: boolean) {
  response.setHeader("Content-Security-Policy", contentSecurityPolicy(pathname, production));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("Cache-Control", "no-store");
  if (production) response.setHeader("Strict-Transport-Security", "max-age=31536000");
}
