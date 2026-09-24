/**
 * Carrier status auto-sync — engine against real D1 (E2E).
 *
 * The mapping unit test proves interpretation; this proves the write path:
 * selection (throttle, terminal guard), the forward-only rank guard, the
 * per-order sync bookkeeping, failure backoff, and the run log — all on the
 * real schema, with an injected fake provider so no carrier HTTP happens.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { AppDb } from "@/db";
import {
  DEFAULT_SYNC_BATCH_SIZE,
  syncAllCarrierStatuses,
  syncCompanyStatuses,
} from "./auto-sync";
import { getOrdersDueForSync, listSyncRuns } from "./auto-sync.queries";
import type { DeliveryProvider, TrackingEvent } from "./types";

let db: AppDb;
const registry: Miniflare[] = [];

const COMPANY_ID = "comp-autosync";
const NOW = new Date().toISOString();

/** Tracking histories keyed by tracking number, served by the fake provider. */
let histories: Record<string, TrackingEvent[]> = {};
let throwFor = new Set<string>();
let callLog: string[] = [];

class FakeProvider implements DeliveryProvider {
  readonly code = "yalidine";
  async createShipment(): Promise<never> {
    throw new Error("not used");
  }
  async validateShipment(): Promise<boolean> {
    return true;
  }
  async getStopDesks(): Promise<never[]> {
    return [];
  }
  async getTrackingInfo(trackingNumber: string): Promise<TrackingEvent[]> {
    callLog.push(trackingNumber);
    if (throwFor.has(trackingNumber)) throw new Error("carrier exploded");
    return histories[trackingNumber] ?? [];
  }
}

const createProvider = () => new FakeProvider();

async function seedOrder(
  id: string,
  overrides: Partial<typeof schema.orders.$inferInsert> = {},
) {
  await db.insert(schema.orders).values({
    id,
    orderNumber: `ORD-${id}`,
    customerId: "cust-autosync",
    customerName: "Auto Sync Customer",
    phone: `05551000${id.slice(-2)}`,
    price: 1000,
    status: "dispatched",
    deliveryMethod: "company",
    companyId: COMPANY_ID,
    trackingNumber: `TRK-${id}`,
    deliveryFee: 0,
    driverFee: 0,
    codAmount: 1000,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as typeof schema.orders.$inferInsert);
}

beforeAll(async () => {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    d1Databases: { DB: "test-db" },
  });
  const d1 = await mf.getD1Database("DB");
  const dir = resolve(__dirname, "../../../db/migrations");
  const preparedStatements: D1PreparedStatement[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const statements = readFileSync(`${dir}/${file}`, "utf8")
      .split("--> statement-breakpoint")
      .flatMap((s) => s.split(/;\s*\n/))
      .map((s) => s.replace(/;+\s*$/, "").trim())
      .filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
    for (const statement of statements) {
      preparedStatements.push(d1.prepare(statement));
    }
  }
  for (let i = 0; i < preparedStatements.length; i += 50) {
    await d1.batch(preparedStatements.slice(i, i + 50));
  }
  db = drizzle(d1 as unknown as D1Database, { schema }) as unknown as AppDb;
  registry.push(mf);

  await db.insert(schema.deliveryCompanies).values({
    id: COMPANY_ID,
    name: "Yalidine",
    nameAr: "ياليدين",
    code: "yalidine",
    active: true,
    apiEndpoint: "https://api.yalidine.test/v1",
    apiToken: "token",
    apiUserGuid: "api-id",
    supportsHomeDelivery: true,
    supportsStopDesk: true,
    supportsTracking: true,
    autoValidate: true,
    autoSyncEnabled: true,
    autoSyncIntervalMin: 30,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(schema.customers).values({
    id: "cust-autosync",
    name: "Auto Sync Customer",
    phone: "0555100000",
    wilaya: "الجزائر",
    totalOrders: 0,
    totalSpent: 0,
    createdAt: NOW,
  });
}, 120_000);

afterAll(async () => {
  for (const mf of registry) await mf.dispose();
});

beforeEach(async () => {
  histories = {};
  throwFor = new Set();
  callLog = [];
  await db.delete(schema.companyApiLogs);
  await db.delete(schema.carrierSyncRuns);
  await db.delete(schema.orderStatusHistory);
  await db.delete(schema.orders);
});

const companyArg = {
  id: COMPANY_ID,
  code: "yalidine",
  name: "Yalidine",
  apiToken: "token",
  apiUserGuid: "api-id",
  apiEndpoint: "https://api.yalidine.test/v1",
  notes: null,
  webhookStatusMapping: null,
  autoSyncIntervalMin: 30,
};

describe("syncCompanyStatuses — real D1", () => {
  it("applies the carrier status forward and records the sync", async () => {
    await seedOrder("as-1");
    histories["TRK-as-1"] = [
      { activity: "Sorti en livraison", date: "2026-09-20 08:00:00" },
      { activity: "Livré", date: "2026-09-20 12:00:00" },
    ];

    const run = await syncCompanyStatuses(db, companyArg, { trigger: "manual", createProvider });

    expect(run.counters).toMatchObject({ scanned: 1, polled: 1, updated: 1, errors: 0 });
    expect(run.details[0]).toMatchObject({ outcome: "updated", from: "dispatched", to: "delivered" });

    const order = await db.select().from(schema.orders).where(eq(schema.orders.id, "as-1")).get();
    expect(order?.status).toBe("delivered");
    expect(order?.deliveryTime).toBeTruthy();
    expect(order?.lastCarrierStatus).toBe("Livré");
    expect(order?.lastTrackingSyncAt).toBeTruthy();
    expect(order?.trackingSyncFails).toBe(0);

    const history = await db
      .select()
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, "as-1"))
      .all();
    expect(history.map((h) => h.status)).toContain("delivered");
    expect(history[0]?.by).toBe("carrier-sync:yalidine");
  });

  it("never moves an order backwards", async () => {
    await seedOrder("as-2", { status: "out_for_delivery" });
    histories["TRK-as-2"] = [{ activity: "En préparation", date: "2026-09-20 08:00:00" }];

    const run = await syncCompanyStatuses(db, companyArg, { trigger: "cron", createProvider });

    expect(run.counters.updated).toBe(0);
    expect(run.counters.unchanged).toBe(1);
    const order = await db.select().from(schema.orders).where(eq(schema.orders.id, "as-2")).get();
    expect(order?.status).toBe("out_for_delivery");
  });

  it("leaves terminal orders alone and does not even poll them", async () => {
    await seedOrder("as-3", { status: "delivered" });
    histories["TRK-as-3"] = [{ activity: "Retourné au vendeur", date: "2026-09-20 08:00:00" }];

    const run = await syncCompanyStatuses(db, companyArg, { trigger: "cron", createProvider });

    expect(run.counters.scanned).toBe(0);
    expect(callLog).toEqual([]);
    const order = await db.select().from(schema.orders).where(eq(schema.orders.id, "as-3")).get();
    expect(order?.status).toBe("delivered");
  });

  it("stores unmapped carrier strings verbatim instead of guessing", async () => {
    await seedOrder("as-4");
    histories["TRK-as-4"] = [{ activity: "Statut Jamais Vu", date: "2026-09-20 08:00:00" }];

    const run = await syncCompanyStatuses(db, companyArg, { trigger: "cron", createProvider });

    expect(run.counters).toMatchObject({ unmapped: 1, updated: 0 });
    expect(run.counters.unmappedStatuses).toEqual(["Statut Jamais Vu"]);
    const order = await db.select().from(schema.orders).where(eq(schema.orders.id, "as-4")).get();
    expect(order?.status).toBe("dispatched");
    expect(order?.lastCarrierStatus).toBe("Statut Jamais Vu");
  });

  it("counts a failure, keeps the order intact, and backs off after maxFails", async () => {
    await seedOrder("as-5", { trackingSyncFails: 10 });
    throwFor.add("TRK-as-5");

    const run = await syncCompanyStatuses(db, companyArg, { trigger: "cron", createProvider });
    expect(run.counters.scanned).toBe(0); // backed off before calling the carrier
    expect(callLog).toEqual([]);

    await db
      .update(schema.orders)
      .set({ trackingSyncFails: 0 })
      .where(eq(schema.orders.id, "as-5"));

    const retry = await syncCompanyStatuses(db, companyArg, { trigger: "cron", createProvider });
    // The carrier call itself threw, so the order was scanned but never polled.
    expect(retry.counters).toMatchObject({ scanned: 1, polled: 0, errors: 1, updated: 0 });
    const order = await db.select().from(schema.orders).where(eq(schema.orders.id, "as-5")).get();
    expect(order?.status).toBe("dispatched");
    expect(order?.trackingSyncFails).toBe(1);
  });

  it("increments deliveryAttempts only for failures newer than the previous poll", async () => {
    await seedOrder("as-6", {
      status: "out_for_delivery",
      lastTrackingSyncAt: "2026-09-20T10:00:00.000Z",
      deliveryAttempts: 2,
    });
    histories["TRK-as-6"] = [
      { activity: "Tentative échouée", date: "2026-09-19 08:00:00" }, // before the last poll
      { activity: "Tentative échouée", date: "2026-09-21 08:00:00" }, // after it
    ];

    await syncCompanyStatuses(db, companyArg, { trigger: "cron", createProvider });

    const order = await db.select().from(schema.orders).where(eq(schema.orders.id, "as-6")).get();
    expect(order?.deliveryAttempts).toBe(3);
  });

  it("throttles by auto_sync_interval_min and bypasses it with force", async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    await seedOrder("as-7", { lastTrackingSyncAt: recent });

    const due = await getOrdersDueForSync(db, {
      companyId: COMPANY_ID,
      intervalMin: 30,
      limit: DEFAULT_SYNC_BATCH_SIZE,
    });
    expect(due.map((o) => o.id)).toEqual([]);

    const forced = await getOrdersDueForSync(db, {
      companyId: COMPANY_ID,
      intervalMin: 30,
      limit: DEFAULT_SYNC_BATCH_SIZE,
      force: true,
    });
    expect(forced.map((o) => o.id)).toEqual(["as-7"]);
  });

  it("restricts a run to an explicit order selection", async () => {
    await seedOrder("as-8");
    await seedOrder("as-9");
    histories["TRK-as-8"] = [{ activity: "Livré", date: "2026-09-20 08:00:00" }];
    histories["TRK-as-9"] = [{ activity: "Livré", date: "2026-09-20 08:00:00" }];

    const run = await syncCompanyStatuses(db, companyArg, {
      trigger: "manual",
      orderIds: ["as-8"],
      createProvider,
    });

    expect(callLog).toEqual(["TRK-as-8"]);
    expect(run.details.map((d) => d.orderId)).toEqual(["as-8"]);
    const nine = await db.select().from(schema.orders).where(eq(schema.orders.id, "as-9")).get();
    expect(nine?.status).toBe("dispatched");
  });

  it("writes one run row per company with its counters", async () => {
    await seedOrder("as-10");
    histories["TRK-as-10"] = [{ activity: "Livré", date: "2026-09-20 08:00:00" }];

    await syncCompanyStatuses(db, companyArg, { trigger: "cron", createProvider });

    const runs = await listSyncRuns(db, { companyId: COMPANY_ID });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      companyId: COMPANY_ID,
      trigger: "cron",
      mode: "poll",
      scanned: 1,
      updated: 1,
    });
    expect(runs[0]?.finishedAt).toBeTruthy();
  });

  it("records a run-level error when the provider cannot be built", async () => {
    await seedOrder("as-11");
    const run = await syncCompanyStatuses(db, { ...companyArg, apiToken: null }, {
      trigger: "cron",
    });

    expect(run.errorMessage).toMatch(/Yalidine/);
    const runs = await listSyncRuns(db, { companyId: COMPANY_ID });
    expect(runs[0]?.errorMessage).toBeTruthy();
  });

  it("sweeps every eligible company via syncAllCarrierStatuses", async () => {
    await seedOrder("as-12");
    histories["TRK-as-12"] = [{ activity: "Sorti en livraison", date: "2026-09-20 08:00:00" }];

    const results = await syncAllCarrierStatuses(db, { trigger: "cron", createProvider });

    expect(results).toHaveLength(1);
    expect(results[0]?.companyCode).toBe("yalidine");
    expect(results[0]?.counters.updated).toBe(1);
  });

  it("skips companies with auto-sync switched off", async () => {
    await db
      .update(schema.deliveryCompanies)
      .set({ autoSyncEnabled: false })
      .where(eq(schema.deliveryCompanies.id, COMPANY_ID));
    await seedOrder("as-13");

    const results = await syncAllCarrierStatuses(db, { trigger: "cron", createProvider });
    expect(results).toHaveLength(0);

    await db
      .update(schema.deliveryCompanies)
      .set({ autoSyncEnabled: true })
      .where(eq(schema.deliveryCompanies.id, COMPANY_ID));
  });
});
