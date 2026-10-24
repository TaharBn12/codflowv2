/**
 * Security headers for the dashboard's Worker-rendered responses.
 *
 * Prerendered pages are served straight from `dist/` and get their headers
 * from `public/_headers` (Cloudflare static asset rules), which does not apply
 * to responses the Worker generates. The Worker owns exactly four surfaces —
 * `/api/auth/*`, `/mcp/oauth/login`, `/reset-password/*` and the assets
 * fallback — so the same header set is applied here in code.
 */

export const DASHBOARD_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

/** Clone a Response, adding the dashboard security header set. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(DASHBOARD_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Auth endpoints answer JSON (or redirects). CSP is applied to JSON only: the
 * MCP consent page and any HTML the auth server emits need their own policy.
 */
export function withAuthResponseHeaders(response: Response): Response {
  const wrapped = withSecurityHeaders(response);
  const contentType = wrapped.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    wrapped.headers.set(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  }
  return wrapped;
}
