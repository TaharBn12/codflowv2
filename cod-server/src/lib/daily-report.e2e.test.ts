/**
 * Daily report — real-D1 E2E.
 *
 * Builds the report from real analytics queries (store-local "today" vs
 * "yesterday"), renders it in the store language and exercises the hourly
 * cron guard (`sendDailyReportIfDue`) end to end with a mocked Telegram API.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@/db/schema";
import type { AppDb } from "@/db";
import type { Env } from "@/types";

vi.mock("@/db", () => ({ getDb: vi.fn(() => realDb) }));

import { getReportConfig, saveReportConfig } from "../../../cod-shared/queries/analytics";
import { buildDailyReport, renderTelegramReport, sendDailyReportIfDue } from "./daily-report";

let realDb: AppDb;
let env: Env;
const registry: Miniflare[] = [];

// Saturday 2026-09-20 20:30 UTC → 21:30 in Algiers.
const NOW = new Date("2026-09-20T20:30:00.000Z");

beforeAll(async () => {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    d1Databases: { DB: "daily-report-test-db" },
  });
  const d1 = await mf.getD1Database("DB");
  const dir = resolve(__dirname, "../db/migrations");
  const statements: D1PreparedStatement[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const parts = readFileSync(`${dir}/${file}`, "utf8")
      .split("--> statement-breakpoint")
      .flatMap((s) => s.split(/;\s*\n/))
      .map((s) => s.replace(/;+\s*$/, "").trim())
      .filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
    for (const statement of parts) statements.push(d1.prepare(statement));
  }
  for (let i = 0; i < statements.length; i += 50) await d1.batch(statements.slice(i, i + 50));
  realDb = drizzle(d1 as unknown as D1Database, { schema }) as unknown as AppDb;
  registry.push(mf);
  env = { DB: d1 } as unknown as Env;

  const ts = NOW.toISOString();
  await realDb.insert(schema.stores).values({ id: "store-1", name: "متجر النور", lang: "ar", createdAt: ts, updatedAt: ts } as any);
  await realDb.insert(schema.wilayas).values({ id: 19, name: "Sétif", nameAr: "سطيف" }).onConflictDoNothing();
  await realDb.insert(schema.customers).values({ id: "cust-1", name: "Client", phone: "0550000001", wilaya: "Sétif", totalOrders: 0, totalSpent: 0, createdAt: ts } as any);
  await realDb.insert(schema.products).values({ id: "p1", name: "Montre", handle: "montre", price: 2500, createdAt: ts, updatedAt: ts } as any);

  const orders = [
    // today (local): one delivered, one new
    { id: "o1", orderNumber: "ORD-1", status: "delivered", price: 5000, createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-20T16:00:00.000Z", deliveryTime: "2026-09-20T16:00:00.000Z" },
    { id: "o2", orderNumber: "ORD-2", status: "new", price: 3000, createdAt: "2026-09-20T18:00:00.000Z", updatedAt: "2026-09-20T18:00:00.000Z" },
    // yesterday (local): one delivered
    { id: "o3", orderNumber: "ORD-3", status: "delivered", price: 2000, createdAt: "2026-09-19T10:00:00.000Z", updatedAt: "2026-09-19T15:00:00.000Z" },
    // old & unconfirmed → alert
    { id: "o4", orderNumber: "ORD-4", status: "new", price: 1000, createdAt: "2026-09-17T10:00:00.000Z", updatedAt: "2026-09-17T10:00:00.000Z" },
  ];
  for (const order of orders) {
    await realDb.insert(schema.orders).values({
      customerId: "cust-1", customerName: "Client", phone: "0550000001", wilayaId: 19, wilaya: "Sétif",
      deliveryMethod: "unassigned", codAmount: order.price, ...order,
    } as any);
  }
  await realDb.insert(schema.orderProducts).values({
    id: "op1", orderId: "o1", productId: "p1", productName: "Montre", quantity: 2, returnedQuantity: 0, pricePerUnit: 2500, lineTotal: 5000, createdAt: ts,
  } as any);
}, 120_000);

afterAll(async () => {
  for (const mf of registry) await mf.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("daily report against real D1", () => {
  it("builds today-vs-yesterday numbers in the store language", async () => {
    const data = await buildDailyReport(realDb, NOW, "Africa/Algiers");
    expect(data.date).toBe("2026-09-20");
    expect(data.storeName).toBe("متجر النور");
    expect(data.language).toBe("ar");
    expect(data.today).toMatchObject({ totalOrders: 2, deliveredOrders: 1, revenueDelivered: 5000, revenuePending: 3000 });
    expect(data.yesterday).toMatchObject({ totalOrders: 1, deliveredOrders: 1, revenueDelivered: 2000 });
    expect(data.topProducts).toEqual([{ name: "Montre", orders: 1, revenueDelivered: 5000 }]);
    expect(data.topWilayas).toEqual([{ name: "سطيف", orders: 2, deliveryRate: 100 }]);
    expect(data.alerts.map((alert) => alert.id)).toContain("unconfirmed_orders");

    const text = renderTelegramReport(data);
    expect(text).toContain("متجر النور");
    expect(text).toContain("<b>2</b>");
    expect(text).toContain("2026-09-20");
  });

  it("sends once per local day when the configured hour is reached", async () => {
    await saveReportConfig(realDb, {
      enabled: true, sendHour: 21, timezone: "Africa/Algiers", telegramEnabled: true, emailEnabled: false, emailRecipients: [],
    }, null);
    await realDb.insert(schema.telegramApprovalConfig).values({
      id: "default", enabled: true, botToken: "bot-token", chatId: "chat-1", webhookSecret: "secret", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    } as any);

    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    // 20:30 local → before the 21:00 send hour → nothing goes out.
    expect(await sendDailyReportIfDue(env, new Date("2026-09-20T19:30:00.000Z"))).toBe(false);
    expect(calls).toHaveLength(0);

    // 21:30 local → due → one Telegram message, day recorded.
    expect(await sendDailyReportIfDue(env, NOW)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: "chat-1", parse_mode: "HTML" });
    expect(calls[0].body.text).toContain("متجر النور");
    expect((await getReportConfig(realDb)).lastSentOn).toBe("2026-09-20");

    // Next hourly tick on the same day → deduplicated.
    expect(await sendDailyReportIfDue(env, new Date("2026-09-20T21:30:00.000Z"))).toBe(false);
    expect(calls).toHaveLength(1);

    // Next day, after the hour → sent again.
    expect(await sendDailyReportIfDue(env, new Date("2026-09-21T20:30:00.000Z"))).toBe(true);
    expect(calls).toHaveLength(2);
    expect((await getReportConfig(realDb)).lastSentOn).toBe("2026-09-21");
  });

  it("does not retry forever when Telegram rejects the message, and stays quiet when disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 })));
    const day3 = new Date("2026-09-22T20:30:00.000Z");
    expect(await sendDailyReportIfDue(env, day3)).toBe(false);
    // Failure is not recorded as sent, so the next hourly tick retries.
    expect((await getReportConfig(realDb)).lastSentOn).toBe("2026-09-21");

    const config = await getReportConfig(realDb);
    await saveReportConfig(realDb, { ...config, enabled: false }, null);
    expect(await sendDailyReportIfDue(env, day3)).toBe(false);

    await saveReportConfig(realDb, { ...config, enabled: true, telegramEnabled: false, emailEnabled: false }, null);
    expect(await sendDailyReportIfDue(env, day3)).toBe(false);
    expect((await getReportConfig(realDb)).lastSentOn).toBe("2026-09-22"); // recorded so the cron stops re-checking
  });
});
