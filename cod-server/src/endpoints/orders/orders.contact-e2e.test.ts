import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppContext } from "@/types";
import { errorHandler } from "@/middleware/error";
import { openApiValidationHook } from "@/openapi/validation-hook";
import ordersRouter from "./routes";
import * as schema from "@/db/schema";
import type { AppDb } from "@/db";
import { getAllOrders } from "../../../../cod-shared/queries/orders";
import { recordOrderContactAttempt } from "../../../../cod-shared/queries/order-contact";
import { ROLE_DEFAULT_SCOPES } from "../../../../cod-shared/rbac/scopes";

let db: AppDb;
let rawD1: D1Database;
let app: OpenAPIHono<AppContext>;
const registry: Miniflare[] = [];

const ADMIN = {
  id: "admin-ct",
  email: "admin-ct@example.com",
  name: "Admin CT",
  role: "admin",
  status: "active",
  scopes: ["*"],
};
const CONFIRMER = {
  id: "confirmer-ct",
  email: "confirmer-ct@example.com",
  name: "Samira Confirmer",
  role: "confirmer",
  status: "active",
  scopes: [...ROLE_DEFAULT_SCOPES.confirmer],
};
const OTHER_CONFIRMER = {
  id: "confirmer-other",
  email: "confirmer-other@example.com",
  name: "Other Confirmer",
  role: "confirmer",
  status: "active",
  scopes: [...ROLE_DEFAULT_SCOPES.confirmer],
};

let currentUser: Record<string, unknown> = CONFIRMER;

beforeAll(async () => {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    d1Databases: { DB: "test-db" },
  });
  rawD1 = await mf.getD1Database("DB");
  const dir = resolve(__dirname, "../../db/migrations");
  const prepared: D1PreparedStatement[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const statements = readFileSync(`${dir}/${file}`, "utf8")
      .split("--> statement-breakpoint")
      .flatMap((s) => s.split(/;\s*\n/))
      .map((s) => s.replace(/;+\s*$/, "").trim())
      .filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
    for (const statement of statements) prepared.push(rawD1.prepare(statement));
  }
  for (let i = 0; i < prepared.length; i += 50) {
    await rawD1.batch(prepared.slice(i, i + 50));
  }
  db = drizzle(rawD1 as unknown as D1Database, { schema }) as unknown as AppDb;

  app = new OpenAPIHono<AppContext>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.env = { DB: rawD1 as any } as any;
    c.set("user", currentUser as any);
    await next();
  });
  app.onError(errorHandler);
  app.route("/api/orders", ordersRouter);

  for (const user of [ADMIN, CONFIRMER, OTHER_CONFIRMER]) {
    await db.insert(schema.users).values({ id: user.id, name: user.name, email: user.email, role: user.role as any, status: "active" });
  }
  registry.push(mf);
}, 120_000);

afterAll(async () => {
  for (const mf of registry) await mf.dispose();
});

beforeEach(() => {
  currentUser = CONFIRMER;
});

let seq = 0;
const NOW = () => new Date().toISOString();

async function seedOrder(opts: { status?: string; assignee?: string | null } = {}) {
  const n = ++seq;
  const orderId = `ord-ct-${n}`;
  const customerId = `cust-ct-${n}`;
  await db.insert(schema.customers).values({
    id: customerId, name: `CT Customer ${n}`, phone: `0555${String(400000 + n).slice(-6)}`,
    wilaya: "الجزائر", totalOrders: 1, totalSpent: 5000, createdAt: NOW(),
  });
  await db.insert(schema.orders).values({
    id: orderId, orderNumber: `ORD-CT-${n}`, customerId, customerName: `CT Customer ${n}`,
    phone: `0555${String(400000 + n).slice(-6)}`, price: 5000, status: (opts.status ?? "new") as any,
    deliveryMethod: "unassigned", deliveryType: "home", deliveryFee: 500, driverFee: 0,
    codAmount: 5500, createdAt: NOW(), updatedAt: NOW(),
  });
  await db.insert(schema.orderStatusHistory).values({
    id: `hist-ct-${n}`, orderId, status: (opts.status ?? "new") as any, timestamp: NOW(), by: null,
  });
  const assignee = opts.assignee === undefined ? CONFIRMER.id : opts.assignee;
  if (assignee) {
    await db.insert(schema.orderConfirmationAssignments).values({
      orderId, assigneeId: assignee, assignedBy: ADMIN.id, assignedAt: NOW(), updatedAt: NOW(),
    });
  }
  return orderId;
}

function logAttempt(orderId: string, body: Record<string, unknown>) {
  return app.request(`/api/orders/${orderId}/contact-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function activityRows(orderId: string, action?: string) {
  const rows = await db
    .select()
    .from(schema.activityLogs)
    .where(and(eq(schema.activityLogs.entityType, "order"), eq(schema.activityLogs.entityId, orderId)))
    .all();
  return action ? rows.filter((row) => row.action === action) : rows;
}

describe("confirmer contact attempts — real D1 + real routes", () => {
  it("allows three unanswered calls per day, then refuses the fourth with CONTACT_LIMIT_REACHED", async () => {
    const orderId = await seedOrder({ status: "unreachable" });
    const outcomes = ["no_answer", "busy", "switched_off"];
    for (const [index, outcome] of outcomes.entries()) {
      const res = await logAttempt(orderId, { channel: "call", outcome });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.data.summary.unansweredToday).toBe(index + 1);
      expect(body.data.summary.remainingToday).toBe(2 - index);
    }

    const blocked = await logAttempt(orderId, { channel: "call", outcome: "no_answer" });
    expect(blocked.status).toBe(422);
    const error: any = await blocked.json();
    expect(error.code).toBe("CONTACT_LIMIT_REACHED");
    expect(error.context.limit).toBe(3);
    expect(typeof error.context.resetsAt).toBe("string");

    const stored = await db.select().from(schema.orderContactAttempts)
      .where(eq(schema.orderContactAttempts.orderId, orderId)).all();
    expect(stored).toHaveLength(3);
  });

  it("still accepts 'message sent' and an answered call after the call limit is reached", async () => {
    const orderId = await seedOrder({ status: "unreachable" });
    for (let i = 0; i < 3; i++) {
      expect((await logAttempt(orderId, { channel: "call", outcome: "no_answer" })).status).toBe(201);
    }
    const message = await logAttempt(orderId, { channel: "whatsapp", outcome: "message_sent", note: "Sent the delivery details" });
    expect(message.status).toBe(201);
    const answered = await logAttempt(orderId, { channel: "call", outcome: "answered" });
    expect(answered.status).toBe(201);
    const body: any = await answered.json();
    expect(body.data.summary.limitReached).toBe(true);
    expect(body.data.summary.totalMessages).toBe(1);
  });

  it("only counts today's calls — yesterday's attempts do not consume today's quota", async () => {
    const orderId = await seedOrder({ status: "unreachable" });
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
      const result = await recordOrderContactAttempt(db, {
        orderId, channel: "call", outcome: "no_answer",
        actor: { id: CONFIRMER.id, name: CONFIRMER.name }, now: new Date(yesterday.getTime() + i * 1000),
      });
      expect(result.recorded).toBe(true);
    }
    const res = await logAttempt(orderId, { channel: "call", outcome: "no_answer" });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.data.summary.unansweredToday).toBe(1);
  });

  it("the guarded insert never exceeds the limit under concurrent requests", async () => {
    const orderId = await seedOrder({ status: "unreachable" });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        recordOrderContactAttempt(db, {
          orderId, channel: "call", outcome: "no_answer",
          actor: { id: CONFIRMER.id, name: CONFIRMER.name },
        }),
      ),
    );
    expect(results.filter((r) => r.recorded)).toHaveLength(3);
    const stored = await db.select().from(schema.orderContactAttempts)
      .where(eq(schema.orderContactAttempts.orderId, orderId)).all();
    expect(stored).toHaveLength(3);
  });

  it("writes every attempt to the order activity log with the attempt number", async () => {
    const orderId = await seedOrder({ status: "unreachable" });
    await logAttempt(orderId, { channel: "call", outcome: "no_answer", note: "Rang 10 times" });
    await logAttempt(orderId, { channel: "sms", outcome: "message_sent" });
    const rows = await activityRows(orderId, "order.contact_attempt");
    expect(rows).toHaveLength(2);
    const call = rows.map((row) => JSON.parse(row.metadata!)).find((meta) => meta.channel === "call");
    expect(call).toMatchObject({ outcome: "no_answer", note: "Rang 10 times", attemptOfDay: 1, dailyLimit: 3 });
    expect(rows[0].actorId).toBe(CONFIRMER.id);
    expect(rows[0].actorRole).toBe("confirmer");
    expect(rows[0].entityLabel).toMatch(/^ORD-CT-/);
  });

  it("moves a new order to unreachable on a no-answer call and logs the status change", async () => {
    const orderId = await seedOrder({ status: "new" });
    const res = await logAttempt(orderId, { channel: "call", outcome: "no_answer" });
    const body: any = await res.json();
    expect(body.data.statusChanged).toEqual({ from: "new", to: "unreachable" });
    const order = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
    expect(order!.status).toBe("unreachable");
    const history = await db.select().from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, orderId)).all();
    expect(history.map((h) => h.status)).toContain("unreachable");
    const statusLogs = await activityRows(orderId, "order.status_changed");
    expect(JSON.parse(statusLogs[0].metadata!)).toMatchObject({ from: "new", to: "unreachable", reason: "contact_attempt" });
  });

  it("does not change status for a message, a wrong number, or an already-confirmed order", async () => {
    const newOrder = await seedOrder({ status: "new" });
    await logAttempt(newOrder, { channel: "whatsapp", outcome: "message_sent" });
    await logAttempt(newOrder, { channel: "call", outcome: "wrong_number" });
    expect((await db.select().from(schema.orders).where(eq(schema.orders.id, newOrder)).get())!.status).toBe("new");

    const confirmed = await seedOrder({ status: "confirmed" });
    const res = await logAttempt(confirmed, { channel: "call", outcome: "busy" });
    expect(((await res.json()) as any).data.statusChanged).toBeNull();
    expect((await db.select().from(schema.orders).where(eq(schema.orders.id, confirmed)).get())!.status).toBe("confirmed");
  });

  it("schedules a callback task for the assigned confirmer and completes it once answered", async () => {
    const orderId = await seedOrder({ status: "new" });
    const callbackAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const res = await logAttempt(orderId, { channel: "call", outcome: "callback_requested", callbackAt, note: "After work" });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.data.callbackTaskId).toBeTruthy();
    expect(body.data.summary.nextCallbackAt).toBe(callbackAt);

    const task = await db.select().from(schema.operationTasks)
      .where(eq(schema.operationTasks.id, body.data.callbackTaskId)).get();
    expect(task).toMatchObject({ type: "callback", status: "open", priority: "high", assigneeId: CONFIRMER.id, dueAt: callbackAt, orderId });

    await logAttempt(orderId, { channel: "call", outcome: "answered" });
    const done = await db.select().from(schema.operationTasks)
      .where(eq(schema.operationTasks.id, body.data.callbackTaskId)).get();
    expect(done!.status).toBe("completed");
  });

  it("validates outcome/channel pairs and callback times", async () => {
    const orderId = await seedOrder();
    expect((await logAttempt(orderId, { channel: "call", outcome: "message_sent" })).status).toBe(400);
    expect((await logAttempt(orderId, { channel: "whatsapp", outcome: "no_answer" })).status).toBe(400);
    expect((await logAttempt(orderId, { channel: "call", outcome: "callback_requested" })).status).toBe(400);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect((await logAttempt(orderId, { channel: "call", outcome: "callback_requested", callbackAt: past })).status).toBe(400);
  });

  it("refuses contact logging on closed orders", async () => {
    const orderId = await seedOrder({ status: "cancelled" });
    const res = await logAttempt(orderId, { channel: "call", outcome: "no_answer" });
    expect(res.status).toBe(422);
  });

  it("hides another confirmer's order (404) but lets admins log attempts on any order", async () => {
    const orderId = await seedOrder({ assignee: OTHER_CONFIRMER.id });
    expect((await logAttempt(orderId, { channel: "call", outcome: "no_answer" })).status).toBe(404);
    expect((await app.request(`/api/orders/${orderId}/activity`)).status).toBe(404);
    currentUser = ADMIN;
    expect((await logAttempt(orderId, { channel: "call", outcome: "no_answer" })).status).toBe(201);
  });

  it("adds internal notes to the log", async () => {
    const orderId = await seedOrder();
    const res = await app.request(`/api/orders/${orderId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "  Customer prefers evening delivery  " }),
    });
    expect(res.status).toBe(201);
    const rows = await activityRows(orderId, "order.note_added");
    expect(JSON.parse(rows[0].metadata!)).toEqual({ note: "Customer prefers evening delivery" });

    const empty = await app.request(`/api/orders/${orderId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "   " }),
    });
    expect(empty.status).toBe(400);
  });

  it("exposes today's unanswered-call count on the orders list", async () => {
    const orderId = await seedOrder({ status: "unreachable" });
    await logAttempt(orderId, { channel: "call", outcome: "no_answer" });
    await logAttempt(orderId, { channel: "call", outcome: "busy" });
    await logAttempt(orderId, { channel: "whatsapp", outcome: "message_sent" });
    const rows = await getAllOrders(db, { search: orderId.replace("ord-ct-", "ORD-CT-") });
    const row = rows.find((r) => r.id === orderId)!;
    expect(row.unansweredCallsToday).toBe(2);
    expect(row.lastContactAt).toBeTruthy();
  });
});

describe("order activity page feed — real D1", () => {
  it("merges creation, status changes, contact attempts and notes, newest first", async () => {
    const orderId = await seedOrder({ status: "new" });
    currentUser = CONFIRMER;
    await logAttempt(orderId, { channel: "call", outcome: "no_answer" });
    await logAttempt(orderId, { channel: "whatsapp", outcome: "message_sent" });
    await app.request(`/api/orders/${orderId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Will retry at 18:00" }),
    });
    await app.request(`/api/orders/${orderId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "confirmed" }),
    });

    const res = await app.request(`/api/orders/${orderId}/activity`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.order).toMatchObject({ id: orderId, status: "confirmed", confirmationAssigneeName: CONFIRMER.name });
    expect(body.data.summary.unansweredToday).toBe(1);

    const entries = body.data.entries as any[];
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds[kinds.length - 1]).toBe("created");
    expect(kinds.filter((k) => k === "contact")).toHaveLength(2);
    expect(kinds.filter((k) => k === "note")).toHaveLength(1);

    const statuses = entries.filter((entry) => entry.kind === "status");
    expect(statuses.map((entry) => entry.toStatus)).toEqual(["confirmed", "unreachable"]);
    expect(statuses[0]).toMatchObject({ fromStatus: "unreachable", actorName: CONFIRMER.name });
    expect(statuses[1]).toMatchObject({ fromStatus: "new", actorName: CONFIRMER.name });

    expect(entries.filter((entry) => entry.action === "order.status_changed")).toHaveLength(2);
    expect(entries.filter((entry) => entry.action === "order.contact_attempt")).toHaveLength(2);

    const message = entries.find((entry) => entry.channel === "whatsapp");
    expect(message).toMatchObject({ outcome: "message_sent", actorName: CONFIRMER.name, actorRole: "confirmer", metadata: null });
    const call = entries.find((entry) => entry.channel === "call");
    expect(call.metadata).toEqual({ attemptOfDay: 1, dailyLimit: 3 });

    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].createdAt >= entries[i].createdAt).toBe(true);
    }
  });

  it("labels carrier-driven status changes with their source", async () => {
    const orderId = await seedOrder({ status: "dispatched" });
    await db.insert(schema.orderStatusHistory).values({
      id: `hist-webhook-${orderId}`, orderId, status: "out_for_delivery",
      timestamp: new Date(Date.now() + 1000).toISOString(), by: "webhook:yalidine",
    });
    currentUser = ADMIN;
    const body: any = await (await app.request(`/api/orders/${orderId}/activity`)).json();
    const change = body.data.entries.find((entry: any) => entry.toStatus === "out_for_delivery");
    expect(change).toMatchObject({ kind: "status", source: "webhook:yalidine", actorName: null, fromStatus: "dispatched" });
  });

  it("returns 404 for an unknown order", async () => {
    currentUser = ADMIN;
    expect((await app.request("/api/orders/does-not-exist/activity")).status).toBe(404);
  });
});
