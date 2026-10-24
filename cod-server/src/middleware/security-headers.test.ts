/**
 * Security Headers Middleware Tests
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  BASE_SECURITY_HEADERS,
  JSON_CSP,
  HSTS_VALUE,
  shouldEmitHsts,
  securityHeadersMiddleware,
} from "./security-headers";
import type { AppContext } from "@/types/app";

function makeApp(environment: string) {
  const app = new Hono<AppContext>();
  app.use("*", async (c, next) => {
    c.env = { ENVIRONMENT: environment } as any;
    await next();
  });
  app.use("*", securityHeadersMiddleware);
  app.get("/json", (c) => c.json({ ok: true }));
  app.get("/html", (c) => c.html("<!doctype html><title>consent</title>"));
  app.get("/raw", () => new Response("raw", { status: 200, headers: { "Content-Type": "text/plain" } }));
  return app;
}

describe("security headers", () => {
  it("sets the base hardening headers on JSON responses", async () => {
    const res = await makeApp("production").request("https://api.example.com/json");

    for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
    expect(res.headers.get("Content-Security-Policy")).toBe(JSON_CSP);
  });

  it("adds HSTS over HTTPS in production", async () => {
    const res = await makeApp("production").request("https://api.example.com/json");
    expect(res.headers.get("Strict-Transport-Security")).toBe(HSTS_VALUE);
  });

  it("never adds HSTS in development", async () => {
    const res = await makeApp("development").request("https://localhost:8787/json");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("does not put a document CSP on HTML pages", async () => {
    const res = await makeApp("production").request("https://api.example.com/html");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("covers raw Response objects", async () => {
    const res = await makeApp("production").request("https://api.example.com/raw");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("describes HSTS eligibility from URL and environment", () => {
    expect(shouldEmitHsts("https://api.example.com/x", "production")).toBe(true);
    expect(shouldEmitHsts("http://localhost:8787/x", "production")).toBe(false);
    expect(shouldEmitHsts("https://api.example.com/x", "development")).toBe(false);
    expect(shouldEmitHsts("not-a-url", "production")).toBe(false);
  });
});
