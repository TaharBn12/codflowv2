/**
 * Security Headers Middleware
 *
 * Hardening headers for every response this Worker emits. The API is a JSON
 * surface, so the CSP is deliberately restrictive (`default-src 'none'`) and
 * is attached only to JSON responses — HTML surfaces (the OpenAPI reference
 * page and the MCP consent screen) need their own policies and must not
 * inherit a document-wide deny rule.
 *
 * HSTS is emitted only over HTTPS and never in development, so local
 * `wrangler dev` on plain HTTP keeps working and a misconfigured local stack
 * can never teach a browser to force HTTPS for localhost.
 */

import { Context, Next } from "hono";
import type { AppContext } from "@/types/app";

export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
};

export const JSON_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * True when the header set should include HSTS for this request. Exported so
 * the rule stays testable without spinning up a Worker.
 */
export function shouldEmitHsts(url: string, environment: string | undefined): boolean {
  if (environment === "development") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export async function securityHeadersMiddleware(c: Context<AppContext>, next: Next) {
  const applyBase = () => {
    for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
      c.header(name, value);
    }
    if (shouldEmitHsts(c.req.url, c.env.ENVIRONMENT)) {
      c.header("Strict-Transport-Security", HSTS_VALUE);
    }
  };

  applyBase();
  await next();

  // Handlers that return a raw `new Response(...)` (streamed PDFs, R2 objects,
  // the consent HTML page) bypass Hono's prepared-header application, so the
  // headers are re-applied on the final response.
  applyBase();

  const contentType = c.res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    c.header("Content-Security-Policy", JSON_CSP);
  }
}
