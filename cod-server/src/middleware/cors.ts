/**
 * CORS Middleware
 *
 * Handles Cross-Origin Resource Sharing for client requests.
 *
 * Production fails closed: a request from an origin that is not in
 * ALLOWED_ORIGINS gets no `Access-Control-Allow-Origin` at all, so the browser
 * refuses to hand the response to the calling script. Development echoes the
 * request origin so a dev server on any port keeps working. Every response
 * carries `Vary: Origin` because the value depends on the request.
 */

import { Context, Next } from "hono";
import type { AppContext } from "@/types/app";

const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS = "Content-Type, X-API-Key, X-Store-API-Key, Accept, Authorization";
const EXPOSE_HEADERS = "Content-Type, X-API-Key, X-Store-API-Key";

/**
 * Resolve the `Access-Control-Allow-Origin` value for a request.
 *
 * Returns `null` when the response must not be exposed cross-origin.
 * A configured `*` is honoured only in non-production environments.
 */
export function resolveAllowedOrigin(
  requestOrigin: string | undefined,
  environment: string | undefined,
  allowedOriginsConfig: string | undefined,
): string | null {
  const configured = (allowedOriginsConfig ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const isProduction = environment === "production";
  const wildcardAllowed = !isProduction || configured.includes("*");

  if (!isProduction) {
    // Development: echo the caller so any localhost port works.
    if (requestOrigin) return requestOrigin;
    return wildcardAllowed ? "*" : (configured[0] ?? null);
  }

  if (requestOrigin) {
    if (wildcardAllowed && configured.includes("*")) return requestOrigin;
    return configured.includes(requestOrigin) ? requestOrigin : null;
  }

  // No Origin header: not a browser cross-origin request. Only advertise the
  // configured set when it is explicit (never the wildcard in production).
  if (wildcardAllowed && configured.includes("*")) return "*";
  return configured[0] ?? null;
}

export async function corsMiddleware(c: Context<AppContext>, next: Next) {
  const requestOrigin = c.req.header("origin");
  const allowedOrigin = resolveAllowedOrigin(
    requestOrigin,
    c.env.ENVIRONMENT,
    c.env.ALLOWED_ORIGINS,
  );

  const applyCorsHeaders = () => {
    c.header("Vary", "Origin");
    if (allowedOrigin) {
      c.header("Access-Control-Allow-Origin", allowedOrigin);
      c.header("Access-Control-Allow-Methods", ALLOW_METHODS);
      c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
      c.header("Access-Control-Expose-Headers", EXPOSE_HEADERS);
      c.header("Access-Control-Max-Age", "86400");
      // Only set the credentials header if the origin is specific (not *)
      if (allowedOrigin !== "*") {
        c.header("Access-Control-Allow-Credentials", "true");
      }
    }
  };

  applyCorsHeaders();

  // Handle preflight requests
  if (c.req.method === "OPTIONS") {
    const headers: Record<string, string> = { Vary: "Origin" };
    if (allowedOrigin) {
      headers["Access-Control-Allow-Origin"] = allowedOrigin;
      headers["Access-Control-Allow-Methods"] = ALLOW_METHODS;
      headers["Access-Control-Allow-Headers"] = ALLOW_HEADERS;
      headers["Access-Control-Max-Age"] = "86400";
    }
    return c.body(null, 204, headers);
  }

  await next();

  // Handlers that return a raw `new Response(...)` (streamed PDFs, R2 objects)
  // bypass Hono's prepared-header application, so the headers set before
  // `next()` never reach them — re-apply on the final response.
  applyCorsHeaders();
}
