/**
 * Dashboard analytics queries — real-D1 E2E.
 *
 * Runs every migration against a Miniflare D1 database, seeds a small but
 * representative COD dataset and asserts the numbers each dashboard widget
 * relies on (KPI cohorts, previous-period comparison, per-wilaya / product /
 * carrier breakdowns, alerts, today board, P&L, ROAS, layout + report config).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import type { AppDb } from "../db/client";
import {
  bucketKeys,
  createExpense,
  deleteExpense,
  getAnalyticsOverview,
  getAnalyticsTimeseries,
  getCarrierAnalytics,
  getDashboardAlerts,
  getDashboardLayout,
  getExpense,
  getOrderStatusStats,
  getProductAnalytics,
  getProfitAndLoss,
  getReportConfig,
  getRoas,
  getTodayBoard,
  getWilayaAnalytics,
  listExpenses,
  markReportSent,
  previousRange,
  saveDashboardLayout,
  saveReportConfig,
  updateExpense,
} from "./analytics";

let db: AppDb;
const registry: Miniflare[] = [];

// Fixed clock: Saturday 2026-09-20 20:00 UTC (21:00 in Algiers).
const NOW = new Date("2026-09-20T20:00:00.000Z");
const RANGE = { from: "2026-08-31T23:00:00.000Z", to: "2026-09-20T23:00:00.000Z" }; // Sept 1 → Sept 20 local (UTC+1)
const TZ = 60;

function iso(value: string) {
  return new Date(value).toISOString();
}

beforeAll(async () => {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    d1Databases: { DB: "analytics-test-db" },
  });
  const d1 = await mf.getD1Database("DB");
  const dir = resolve(__dirname, "../../cod-server/src/db/migrations");
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
  db = drizzle(d1 as unknown as D1Database, { schema }) as unknown as AppDb;
  registry.push(mf);

  const ts = NOW.toISOString();

  await db.insert(schema.users).values([
    { id: "admin-1", name: "Owner", email: "owner@example.com", role: "admin" },
    { id: "conf-1", name: "Agent", email: "agent@example.com", role: "confirmer" },
  ] as any);

  await db.insert(schema.wilayas).values([
    { id: 16, name: "Alger", nameAr: "الجزائر" },
    { id: 19, name: "Sétif", nameAr: "سطيف" },
  ]).onConflictDoNothing();

  await db.insert(schema.deliveryCompanies).values({
    id: "comp-1", name: "Yalidine", nameAr: "يليدين", code: "yalidine", active: true, createdAt: ts, updatedAt: ts,
  });
  await db.insert(schema.drivers).values({
    id: "drv-1", firstName: "Karim", lastName: "B.", phone: "0550000000", status: "available", pendingCash: 60_000, createdAt: ts, updatedAt: ts,
  });

  await db.insert(schema.products).values([
    { id: "p1", name: "Montre", handle: "montre", price: 2500, costPrice: 1000, trackInventory: true, inventory: 2, lowStockThreshold: 5, status: "ACTIVE", createdAt: ts, updatedAt: ts },
    { id: "p2", name: "Sac", handle: "sac", price: 4000, costPrice: null, trackInventory: false, inventory: 50, status: "ACTIVE", createdAt: ts, updatedAt: ts },
  ] as any);

  await db.insert(schema.landingPages).values({
    id: "lp-1", slug: "montre-promo", name: "Montre promo", productId: "p1", createdAt: ts, updatedAt: ts,
  } as any);

  await db.insert(schema.customers).values({
    id: "cust-1", name: "Client", phone: "0550000001", wilaya: "Sétif", totalOrders: 0, totalSpent: 0, createdAt: ts,
  } as any);

  const orders: Array<Partial<typeof schema.orders.$inferInsert> & { id: string }> = [
    // delivered via company, Sétif, delivered 2 days after assignment
    { id: "o1", orderNumber: "ORD-1", customerName: "A", phone: "0551", price: 5000, deliveryFee: 500, status: "delivered", deliveryMethod: "company", companyId: "comp-1", wilayaId: 19, createdAt: iso("2026-09-10T09:00:00Z"), updatedAt: iso("2026-09-12T10:00:00Z"), assignedAt: iso("2026-09-10T12:00:00Z"), deliveryTime: iso("2026-09-12T12:00:00Z"), deliveryAttempts: 1, landingPageId: "lp-1" },
    // returned via in-house driver, Alger
    { id: "o2", orderNumber: "ORD-2", customerName: "B", phone: "0552", price: 4000, deliveryFee: 400, status: "returned", deliveryMethod: "driver", driverId: "drv-1", driverFee: 200, wilayaId: 16, createdAt: iso("2026-09-11T09:00:00Z"), updatedAt: iso("2026-09-13T10:00:00Z"), deliveryAttempts: 2 },
    // new, unconfirmed for 34h, Sétif
    { id: "o3", orderNumber: "ORD-3", customerName: "C", phone: "0553", price: 3000, status: "new", deliveryMethod: "unassigned", wilayaId: 19, createdAt: iso("2026-09-19T10:00:00Z"), updatedAt: iso("2026-09-19T10:00:00Z") },
    // out for delivery with company, stuck since Sept 8, Sétif
    { id: "o4", orderNumber: "ORD-4", customerName: "D", phone: "0554", price: 6000, deliveryFee: 600, status: "out_for_delivery", deliveryMethod: "company", companyId: "comp-1", wilayaId: 19, createdAt: iso("2026-09-05T09:00:00Z"), updatedAt: iso("2026-09-08T10:00:00Z"), assignedAt: iso("2026-09-05T12:00:00Z") },
    // cancelled, no wilaya
    { id: "o5", orderNumber: "ORD-5", customerName: "E", phone: "0555", price: 2500, status: "cancelled", deliveryMethod: "unassigned", createdAt: iso("2026-09-12T09:00:00Z"), updatedAt: iso("2026-09-12T09:30:00Z") },
    // previous period: delivered on Aug 20
    { id: "o6", orderNumber: "ORD-6", customerName: "F", phone: "0556", price: 7000, status: "delivered", deliveryMethod: "company", companyId: "comp-1", wilayaId: 16, createdAt: iso("2026-08-20T09:00:00Z"), updatedAt: iso("2026-08-22T10:00:00Z") },
    // today (local Sept 20): a new order created 2h ago (not yet >24h) + one delivered today
    { id: "o7", orderNumber: "ORD-7", customerName: "G", phone: "0557", price: 1500, status: "new", deliveryMethod: "unassigned", wilayaId: 16, createdAt: iso("2026-09-20T18:00:00Z"), updatedAt: iso("2026-09-20T18:00:00Z") },
    { id: "o8", orderNumber: "ORD-8", customerName: "H", phone: "0558", price: 2000, status: "delivered", deliveryMethod: "driver", driverId: "drv-1", driverFee: 150, wilayaId: 16, createdAt: iso("2026-09-20T02:00:00Z"), updatedAt: iso("2026-09-20T15:00:00Z"), assignedAt: iso("2026-09-20T03:00:00Z"), deliveryTime: iso("2026-09-20T15:00:00Z"), deliveryAttempts: 1 },
  ];
  for (const order of orders) {
    await db.insert(schema.orders).values({ customerId: "cust-1", codAmount: order.price, ...order } as any);
  }

  await db.insert(schema.orderProducts).values([
    { id: "op1", orderId: "o1", productId: "p1", productName: "Montre", quantity: 2, returnedQuantity: 0, pricePerUnit: 2500, lineTotal: 5000, createdAt: ts },
    { id: "op2", orderId: "o2", productId: "p2", productName: "Sac", quantity: 1, returnedQuantity: 1, pricePerUnit: 4000, lineTotal: 4000, createdAt: ts },
    { id: "op4", orderId: "o4", productId: "p1", productName: "Montre", quantity: 1, returnedQuantity: 0, pricePerUnit: 6000, lineTotal: 6000, createdAt: ts },
    { id: "op8", orderId: "o8", productId: "p2", productName: "Sac", quantity: 1, returnedQuantity: 0, pricePerUnit: 2000, lineTotal: 2000, createdAt: ts },
  ] as any);

  await db.insert(schema.orderConfirmationAssignments).values({
    id: "oca-1", orderId: "o3", assigneeId: "conf-1", assignedAt: ts, createdAt: ts, updatedAt: ts,
  } as any);

  await db.insert(schema.staffCommissions).values({
    id: "com-1", orderId: "o1", userId: "conf-1", category: "confirmation", amount: 300, rateType: "fixed", rateValue: 300, status: "earned", createdAt: ts, updatedAt: ts,
  } as any);

  await db.insert(schema.operationTasks).values({
    id: "task-1", title: "Rappeler le client", assigneeId: "conf-1", status: "open", dueAt: iso("2026-09-19T10:00:00Z"), createdAt: ts, updatedAt: ts,
  } as any);

  await db.insert(schema.webhookEvents).values({
    id: "wh-1", provider: "yalidine", eventId: "evt-1", companyId: "comp-1", eventType: "parcel_status_updated", rawPayload: "{}", result: "error", createdAt: iso("2026-09-20T19:00:00Z"),
  } as any);

  await db.insert(schema.businessExpenses).values([
    { id: "exp-ads-1", date: "2026-09-10", category: "ads", platform: "meta", amount: 10_000, landingPageId: "lp-1", createdBy: "admin-1", createdAt: ts, updatedAt: ts },
    { id: "exp-ads-2", date: "2026-09-11", category: "ads", platform: "tiktok", amount: 5_000, createdBy: "admin-1", createdAt: ts, updatedAt: ts },
    { id: "exp-rent", date: "2026-09-01", category: "rent", amount: 20_000, createdBy: "admin-1", createdAt: ts, updatedAt: ts },
    { id: "exp-old", date: "2026-08-15", category: "ads", platform: "meta", amount: 99_000, createdBy: "admin-1", createdAt: ts, updatedAt: ts },
  ] as any);
}, 120_000);

afterAll(async () => {
  for (const mf of registry) await mf.dispose();
});

describe("analytics queries against real D1", () => {
  it("keeps the legacy status breakdown working (all-time + confirmer scope)", async () => {
    const all = await getOrderStatusStats(db);
    expect(Object.fromEntries(all.map((row) => [row.status, row.count]))).toMatchObject({ new: 2, delivered: 3, returned: 1, cancelled: 1, out_for_delivery: 1 });
    const mine = await getOrderStatusStats(db, "conf-1");
    expect(mine).toEqual([{ status: "new", count: 1 }]);
  });

  it("computes the KPI overview with a previous-period comparison", async () => {
    const result = await getAnalyticsOverview(db, RANGE);
    expect(result.previousRange).toEqual(previousRange(RANGE));
    // In range: o1 delivered, o2 returned, o3 new, o4 out_for_delivery, o5 cancelled, o7 new, o8 delivered.
    expect(result.current).toMatchObject({
      totalOrders: 7,
      confirmedOrders: 4, // delivered ×2 + returned + out_for_delivery
      deliveredOrders: 2,
      returnedOrders: 1,
      cancelledOrders: 1,
      pendingConfirmation: 2,
      inTransit: 1,
      revenueDelivered: 7000,
      deliveryFeesDelivered: 500,
      revenuePending: 10_500, // new (3000 + 1500) + out_for_delivery (6000)
      revenueLostReturns: 4000,
      avgOrderValue: 3583, // 21 500 / 6 — cancelled excluded
      confirmationRate: 57.1,
      deliveryRate: 66.7,
      returnRate: 33.3,
      cancellationRate: 14.3,
    });
    expect(result.previous).toMatchObject({ totalOrders: 1, deliveredOrders: 1, revenueDelivered: 7000 });
  });

  it("scopes the overview to a confirmer's assigned orders", async () => {
    const result = await getAnalyticsOverview(db, RANGE, "conf-1");
    expect(result.current.totalOrders).toBe(1);
    expect(result.current.revenuePending).toBe(3000);
  });

  it("buckets the time series by local day and fills empty buckets", async () => {
    const series = await getAnalyticsTimeseries(db, RANGE, "day", TZ);
    expect(series).toHaveLength(20);
    expect(series.map((point) => point.period)).toEqual(bucketKeys(RANGE, "day", TZ));
    const sept10 = series.find((point) => point.period === "2026-09-10");
    expect(sept10).toMatchObject({ orders: 1, confirmed: 1, delivered: 1, revenueDelivered: 5000 });
    const sept12 = series.find((point) => point.period === "2026-09-12");
    expect(sept12).toMatchObject({ orders: 1, cancelled: 1, delivered: 0 });
    const empty = series.find((point) => point.period === "2026-09-02");
    expect(empty).toMatchObject({ orders: 0, revenueDelivered: 0 });

    const today = series.find((point) => point.period === "2026-09-20");
    expect(today).toMatchObject({ orders: 2, delivered: 1, revenueDelivered: 2000, revenuePending: 1500 });

    const weekly = await getAnalyticsTimeseries(db, RANGE, "week", TZ);
    expect(weekly.reduce((sum, point) => sum + point.orders, 0)).toBe(7);
    expect(weekly[0].period).toBe("2026-08-31"); // Monday of the first week
    const monthly = await getAnalyticsTimeseries(db, RANGE, "month", TZ);
    expect(monthly).toEqual([expect.objectContaining({ period: "2026-09", orders: 7, delivered: 2 })]);

    const mine = await getAnalyticsTimeseries(db, RANGE, "day", TZ, "conf-1");
    expect(mine.reduce((sum, point) => sum + point.orders, 0)).toBe(1);
  });

  it("breaks orders down per wilaya with delivery and return rates", async () => {
    const rows = await getWilayaAnalytics(db, RANGE);
    const setif = rows.find((row) => row.wilayaId === 19);
    expect(setif).toMatchObject({ name: "Sétif", nameAr: "سطيف", orders: 3, delivered: 1, returned: 0, inProgress: 2, revenueDelivered: 5000, deliveryRate: 100 });
    const alger = rows.find((row) => row.wilayaId === 16);
    expect(alger).toMatchObject({ orders: 3, delivered: 1, returned: 1, inProgress: 1, revenueDelivered: 2000, deliveryRate: 50, returnRate: 50 });
    const unknown = rows.find((row) => row.wilayaId == null);
    expect(unknown).toMatchObject({ orders: 1, cancelled: 1, deliveryRate: null });
    expect(rows.at(-1)?.wilayaId).toBeNull(); // ordered by volume

    const mine = await getWilayaAnalytics(db, RANGE, "conf-1");
    expect(mine).toEqual([expect.objectContaining({ wilayaId: 19, orders: 1 })]);
  });

  it("ranks products with gross profit when a cost price exists", async () => {
    const rows = await getProductAnalytics(db, RANGE, 50);
    const montre = rows.find((row) => row.productId === "p1");
    expect(montre).toMatchObject({
      orders: 2,
      deliveredOrders: 1,
      unitsDelivered: 2,
      revenueDelivered: 5000,
      cogs: 2000,
      grossProfit: 3000,
      hasCostPrice: true,
      deliveryRate: 100,
    });
    const sac = rows.find((row) => row.productId === "p2");
    expect(sac).toMatchObject({
      orders: 2,
      deliveredOrders: 1,
      returnedOrders: 1,
      unitsDelivered: 1,
      unitsReturned: 1,
      revenueDelivered: 2000,
      hasCostPrice: false,
      grossProfit: null,
      deliveryRate: 50,
      returnRate: 50,
    });
    expect(await getProductAnalytics(db, RANGE, 1)).toHaveLength(1);
  });

  it("compares carriers (companies vs in-house drivers)", async () => {
    const rows = await getCarrierAnalytics(db, RANGE);
    const yalidine = rows.find((row) => row.kind === "company");
    expect(yalidine).toMatchObject({ companyId: "comp-1", name: "Yalidine", orders: 2, inTransit: 1, delivered: 1, revenueDelivered: 5000, avgDeliveryDays: 2, deliveryRate: 100 });
    const drivers = rows.find((row) => row.kind === "drivers");
    expect(drivers).toMatchObject({ key: "drivers", orders: 2, delivered: 1, returned: 1, revenueDelivered: 2000, avgDeliveryDays: 0.5, avgAttempts: 1.5, deliveryRate: 50, returnRate: 50 });

    const setifOnly = await getCarrierAnalytics(db, RANGE, 19);
    expect(setifOnly).toHaveLength(1);
    expect(setifOnly[0].orders).toBe(2);
  });

  it("raises the smart alerts the merchant needs to act on", async () => {
    const alerts = await getDashboardAlerts(db, NOW);
    const byId = Object.fromEntries(alerts.map((alert) => [alert.id, alert]));
    expect(byId.unconfirmed_orders).toMatchObject({ count: 1, severity: "critical" });
    expect(byId.stuck_out_for_delivery).toMatchObject({ count: 1 });
    expect(byId.low_stock).toMatchObject({ count: 1 });
    expect(byId.low_stock.items?.[0]).toMatchObject({ label: "Montre", value: 2 });
    expect(byId.driver_cash).toMatchObject({ count: 1, amount: 60_000, severity: "critical" });
    expect(byId.webhook_errors).toMatchObject({ count: 1 });
    expect(byId.overdue_tasks).toMatchObject({ count: 1 });
    expect(byId.stuck_dispatched).toBeUndefined();

    const mine = await getDashboardAlerts(db, NOW, "conf-1");
    const mineIds = mine.map((alert) => alert.id);
    expect(mineIds).toContain("unconfirmed_orders");
    expect(mineIds).toContain("overdue_tasks");
    expect(mineIds).not.toContain("driver_cash");
    expect(mineIds).not.toContain("low_stock");
  });

  it("builds the today board for an admin and for a confirmer", async () => {
    const startOfDay = "2026-09-19T23:00:00.000Z"; // Sept 20 00:00 Algiers
    const admin = await getTodayBoard(db, startOfDay, { id: "admin-1", role: "admin" }, NOW);
    expect(admin).toMatchObject({
      toConfirm: 2,
      toRetry: 0,
      inTransit: 1,
      lateShipments: 1,
      ordersToday: 2,
      deliveredToday: 1,
      revenueDeliveredToday: 2000,
      returnedToday: 0,
      myOpenTasks: 0,
      pendingApprovals: 0,
      driversPendingCash: 60_000,
    });
    const agent = await getTodayBoard(db, startOfDay, { id: "conf-1", role: "confirmer" }, NOW);
    expect(agent.toConfirm).toBe(1);
    expect(agent.ordersToday).toBe(0);
    expect(agent.myOpenTasks).toBe(1);
    expect(agent.myOverdueTasks).toBe(1);
    expect(agent.driversPendingCash).toBe(0);
  });

  it("computes the simplified P&L", async () => {
    const pnl = await getProfitAndLoss(db, RANGE, TZ);
    const grossProfit = 7000 + 500 - 2000 - 150;
    const netProfit = grossProfit - 300 - 35_000;
    expect(pnl).toMatchObject({
      revenueDelivered: 7000,
      deliveryFeesCollected: 500,
      cogs: 2000, // 2 × Montre @ 1000; Sac has no cost price
      driverFees: 150, // only delivered in-house driver orders count
      commissions: 300,
      expenses: { ads: 15_000, rent: 20_000, carrier: 0, packaging: 0, salaries: 0, other: 0 },
      totalExpenses: 35_000,
      grossProfit,
      netProfit,
      deliveredOrders: 2,
      returnedOrders: 1,
      revenueLostReturns: 4000,
      profitPerDeliveredOrder: Math.round(netProfit / 2),
      unitsWithoutCostPrice: 1,
      productsWithoutCostPrice: 1,
    });
    expect(pnl.netMargin).toBe(Math.round((netProfit / 7000) * 1000) / 10);
  });

  it("computes ROAS from manual ad spend, overall, per platform and per landing page", async () => {
    const roas = await getRoas(db, RANGE, TZ);
    expect(roas.spend).toBe(15_000);
    expect(roas.spendByPlatform).toEqual([
      { platform: "meta", amount: 10_000 },
      { platform: "tiktok", amount: 5_000 },
    ]);
    expect(roas.orders).toBe(7);
    expect(roas.confirmedOrders).toBe(4);
    expect(roas.deliveredOrders).toBe(2);
    expect(roas.revenueDelivered).toBe(7000);
    expect(roas.revenuePending).toBe(10_500);
    expect(roas.roas).toBe(0.47);
    expect(roas.costPerOrder).toBe(2143);
    expect(roas.costPerConfirmedOrder).toBe(3750);
    expect(roas.costPerDeliveredOrder).toBe(7500);
    expect(roas.daily).toHaveLength(20);
    expect(roas.daily.find((day) => day.date === "2026-09-10")).toMatchObject({ spend: 10_000, orders: 1, delivered: 1, revenueDelivered: 5000 });
    const lp = roas.landingPages.find((row) => row.landingPageId === "lp-1");
    expect(lp).toMatchObject({ name: "Montre promo", spend: 10_000, orders: 1, deliveredOrders: 1, revenueDelivered: 5000, roas: 0.5, costPerDeliveredOrder: 10_000 });
    const organic = roas.landingPages.find((row) => row.landingPageId == null);
    expect(organic).toMatchObject({ spend: 5000, orders: 6, deliveredOrders: 1, revenueDelivered: 2000 });

    const scoped = await getRoas(db, RANGE, TZ, "lp-1");
    expect(scoped.spend).toBe(10_000);
    expect(scoped.orders).toBe(1);
  });

  it("supports the expense CRUD used by the finance widgets", async () => {
    const id = await createExpense(db, { date: "2026-09-15", category: "packaging", amount: 1200, note: "cartons" }, "admin-1");
    let record = await getExpense(db, id);
    expect(record).toMatchObject({ category: "packaging", platform: null, amount: 1200, currency: "DZD", note: "cartons", createdBy: "admin-1", landingPageId: null });

    await updateExpense(db, id, { amount: 1500, landingPageId: "lp-1" });
    record = await getExpense(db, id);
    expect(record).toMatchObject({ amount: 1500, landingPageId: "lp-1", note: "cartons" });

    const adsId = await createExpense(db, { date: "2026-09-16", category: "ads", amount: 700 }, null);
    expect(await getExpense(db, adsId)).toMatchObject({ platform: "other", createdBy: null });

    const listed = await listExpenses(db, { fromDate: "2026-09-01", toDate: "2026-09-20" });
    expect(listed.find((row) => row.id === id)).toMatchObject({ landingPageName: "Montre promo", amount: 1500 });
    expect(listed.map((row) => row.id)).toContain(id);
    expect(listed.map((row) => row.id)).not.toContain("exp-old");
    const packagingOnly = await listExpenses(db, { fromDate: "2026-09-01", toDate: "2026-09-20", category: "packaging" });
    expect(packagingOnly).toHaveLength(1);

    const forLp = await listExpenses(db, { fromDate: "2026-09-01", toDate: "2026-09-20", landingPageId: "lp-1" });
    expect(forLp.map((row) => row.id).sort()).toEqual([id, "exp-ads-1"].sort());

    await deleteExpense(db, id);
    await deleteExpense(db, adsId);
    expect(await getExpense(db, id)).toBeUndefined();
    expect((await getRoas(db, RANGE, TZ)).spend).toBe(15_000); // dataset restored for other specs
  });

  it("stores a per-user widget layout", async () => {
    expect(await getDashboardLayout(db, "admin-1")).toBeNull();
    await saveDashboardLayout(db, "admin-1", { version: 1, widgets: [{ id: "alerts", hidden: false }, { id: "kpis", hidden: true }] });
    expect(await getDashboardLayout(db, "admin-1")).toEqual({ version: 1, widgets: [{ id: "alerts", hidden: false }, { id: "kpis", hidden: true }] });
    await saveDashboardLayout(db, "admin-1", { version: 1, widgets: [{ id: "kpis", hidden: false }] });
    expect((await getDashboardLayout(db, "admin-1"))?.widgets).toHaveLength(1);
    expect(await getDashboardLayout(db, "conf-1")).toBeNull();
  });

  it("stores the daily report configuration and the last-sent marker", async () => {
    const initial = await getReportConfig(db);
    expect(initial).toMatchObject({ enabled: false, sendHour: 20, timezone: "Africa/Algiers", lastSentOn: null });
    await saveReportConfig(db, { enabled: true, sendHour: 21, timezone: "Africa/Algiers", telegramEnabled: true, emailEnabled: true, emailRecipients: ["owner@example.com"] }, "admin-1");
    const saved = await getReportConfig(db);
    expect(saved).toMatchObject({ enabled: true, sendHour: 21, emailEnabled: true, emailRecipients: ["owner@example.com"] });
    await markReportSent(db, "2026-09-20");
    expect((await getReportConfig(db)).lastSentOn).toBe("2026-09-20");
    await saveReportConfig(db, { ...saved, sendHour: 19 }, "admin-1");
    expect((await getReportConfig(db)).sendHour).toBe(19);
  });
});
