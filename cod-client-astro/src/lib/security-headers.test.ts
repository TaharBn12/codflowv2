import { describe, it, expect } from "vitest";
import {
  DASHBOARD_SECURITY_HEADERS,
  withAuthResponseHeaders,
  withSecurityHeaders,
} from "./security-headers";

describe("dashboard security headers", () => {
  it("adds every hardening header to a plain response", () => {
    const res = withSecurityHeaders(new Response("ok", { status: 200 }));
    for (const [name, value] of Object.entries(DASHBOARD_SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
  });

  it("keeps a handler's own value instead of overwriting it", () => {
    const res = withSecurityHeaders(
      new Response("ok", { headers: { "Referrer-Policy": "no-referrer" } }),
    );
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("preserves cookies and status on auth responses", () => {
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "codflow.session_token=a; Path=/; HttpOnly; Secure");
    headers.append("set-cookie", "codflow.session_data=b; Path=/; HttpOnly; Secure");

    const res = withAuthResponseHeaders(new Response("{}", { status: 200, headers }));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(2);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("does not put a document CSP on non-JSON responses", () => {
    const res = withAuthResponseHeaders(
      new Response("redirect", { status: 302, headers: { Location: "/sign-in" } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/sign-in");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
