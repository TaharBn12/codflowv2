import { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { customers, orders, supportChannels, supportConversations, supportMessages, supportTickets, users, customerOrderLinks } from "@/db/schema";
import type { AppContext } from "@/types";
import { hasPermission } from "../../../../cod-shared/rbac/utils";
import { sendTransactionalEmail } from "../../../../cod-shared/lib/transactional-email";

const routes = new Hono<AppContext>();
const isAdmin = (c: any) => c.get("user")?.role === "admin";
const forbidden = (c: any) => c.json({ success: false, code: "FORBIDDEN", error: "Administrator access required" }, 403);
const mask = (value?: string | null) => value ? `••••${value.slice(-6)}` : "";
export function enabledChannelConfigurationError(channel: { type: "whatsapp" | "email"; enabled: boolean; senderId?: string | null; accessToken?: string | null; verifyToken?: string | null; appSecret?: string | null; webhookSecret?: string | null }) {
  if (!channel.enabled) return null;
  if (channel.type === "whatsapp" && (!channel.senderId || !channel.accessToken || !channel.verifyToken || !channel.appSecret)) return "WhatsApp credentials are required before activation";
  if (channel.type === "email" && !channel.webhookSecret) return "Email webhook secret is required before activation";
  return null;
}
routes.use("*", async (c, next) => {
  const actor = c.get("user");
  if (actor.role !== "admin" && !hasPermission(actor.scopes, "customers:read")) return c.json({ success: false, code: "FORBIDDEN", error: "Customer read permission required" }, 403);
  await next();
});

routes.get("/channels", async (c) => {
  const rows = await getDb(c.env.DB).select({ id: supportChannels.id, type: supportChannels.type, name: supportChannels.name, enabled: supportChannels.enabled, provider: supportChannels.provider, senderId: supportChannels.senderId, accessToken: supportChannels.accessToken, verifyToken: supportChannels.verifyToken, appSecret: supportChannels.appSecret, webhookSecret: supportChannels.webhookSecret, updatedAt: supportChannels.updatedAt }).from(supportChannels).all();
  const origin = new URL(c.env.WORKER_SELF_URL).origin;
  return c.json({ success: true, data: rows.map((row) => ({ ...row, webhookUrl: `${origin}/webhooks/support/${row.type}`, accessToken: undefined, verifyToken: undefined, appSecret: undefined, webhookSecret: undefined, accessTokenMasked: mask(row.accessToken), verifyTokenMasked: mask(row.verifyToken), appSecretMasked: mask(row.appSecret), webhookSecretMasked: mask(row.webhookSecret) })) });
});

routes.put("/channels/:type", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const type = z.enum(["whatsapp", "email"]).safeParse(c.req.param("type"));
  const body = z.object({ name: z.string().trim().min(1).max(80), enabled: z.boolean(), provider: z.string().trim().min(1).max(40), senderId: z.string().trim().max(160).optional(), accessToken: z.string().trim().optional(), verifyToken: z.string().trim().optional(), appSecret: z.string().trim().optional(), webhookSecret: z.string().trim().optional() }).safeParse(await c.req.json());
  if (!type.success || !body.success) return c.json({ success: false, code: "VALIDATION_FAILED", error: "Invalid channel settings" }, 400);
  const db = getDb(c.env.DB); const existing = await db.select().from(supportChannels).where(eq(supportChannels.type, type.data)).get(); const now = new Date().toISOString();
  const values = { id: existing?.id ?? crypto.randomUUID(), type: type.data, name: body.data.name, enabled: body.data.enabled, provider: body.data.provider, senderId: body.data.senderId || existing?.senderId || null, accessToken: body.data.accessToken || existing?.accessToken || null, verifyToken: body.data.verifyToken || existing?.verifyToken || (type.data === "whatsapp" ? crypto.randomUUID().replaceAll("-", "") : null), appSecret: body.data.appSecret || existing?.appSecret || null, webhookSecret: body.data.webhookSecret || existing?.webhookSecret || null, createdAt: existing?.createdAt ?? now, updatedAt: now };
  const configurationError = enabledChannelConfigurationError(values);
  if (configurationError) return c.json({ success: false, code: "CHANNEL_NOT_CONFIGURED", error: configurationError }, 400);
  await db.insert(supportChannels).values(values).onConflictDoUpdate({ target: supportChannels.type, set: { name: values.name, enabled: values.enabled, provider: values.provider, senderId: values.senderId, accessToken: values.accessToken, verifyToken: values.verifyToken, appSecret: values.appSecret, webhookSecret: values.webhookSecret, updatedAt: now } });
  return c.json({ success: true, data: { id: values.id, type: values.type, name: values.name, enabled: values.enabled, provider: values.provider, senderId: values.senderId, accessTokenMasked: mask(values.accessToken), verifyTokenMasked: mask(values.verifyToken), appSecretMasked: mask(values.appSecret), webhookSecretMasked: mask(values.webhookSecret), updatedAt: now, webhookUrl: `${new URL(c.env.WORKER_SELF_URL).origin}/webhooks/support/${values.type}` } });
});

routes.get("/conversations", async (c) => {
  const status = c.req.query("status"); const channel = c.req.query("channel"); const conditions: any[] = [];
  if (status && ["open", "pending", "resolved", "closed"].includes(status)) conditions.push(eq(supportConversations.status, status as any));
  if (channel && ["whatsapp", "email"].includes(channel)) conditions.push(eq(supportChannels.type, channel as any));
  const rows = await getDb(c.env.DB).select({ id: supportConversations.id, channelId: supportConversations.channelId, channelType: supportChannels.type, channelName: supportChannels.name, customerId: supportConversations.customerId, orderId: supportConversations.orderId, contact: supportConversations.contact, contactName: supportConversations.contactName, subject: supportConversations.subject, status: supportConversations.status, priority: supportConversations.priority, assigneeId: supportConversations.assigneeId, assigneeName: users.name, unreadCount: supportConversations.unreadCount, lastMessageAt: supportConversations.lastMessageAt, updatedAt: supportConversations.updatedAt }).from(supportConversations).innerJoin(supportChannels, eq(supportConversations.channelId, supportChannels.id)).leftJoin(users, eq(supportConversations.assigneeId, users.id)).where(conditions.length ? and(...conditions) : undefined).orderBy(desc(supportConversations.lastMessageAt)).limit(200).all();
  return c.json({ success: true, data: rows, count: rows.length });
});

routes.post("/conversations", async (c) => {
  const parsed = z.object({ channelId: z.string().min(1), contact: z.string().trim().min(3).max(320), contactName: z.string().trim().max(120).optional(), subject: z.string().trim().max(200).optional(), customerId: z.string().optional(), orderId: z.string().optional(), priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"), assigneeId: z.string().optional() }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, code: "VALIDATION_FAILED", error: parsed.error.flatten() }, 400);
  const now = new Date().toISOString(); const row = { id: crypto.randomUUID(), ...parsed.data, contactName: parsed.data.contactName ?? null, subject: parsed.data.subject ?? null, customerId: parsed.data.customerId ?? null, orderId: parsed.data.orderId ?? null, assigneeId: parsed.data.assigneeId ?? c.get("user").id, status: "open" as const, unreadCount: 0, lastMessageAt: now, createdAt: now, updatedAt: now };
  await getDb(c.env.DB).insert(supportConversations).values(row); return c.json({ success: true, data: row }, 201);
});

routes.get("/conversations/:id/messages", async (c) => {
  const db = getDb(c.env.DB); const conversation = await db.select().from(supportConversations).where(eq(supportConversations.id, c.req.param("id"))).get();
  if (!conversation) return c.json({ success: false, code: "NOT_FOUND", error: "Conversation not found" }, 404);
  const rows = await db.select({ id: supportMessages.id, direction: supportMessages.direction, channelType: supportMessages.channelType, senderId: supportMessages.senderId, senderName: users.name, body: supportMessages.body, deliveryStatus: supportMessages.deliveryStatus, errorCode: supportMessages.errorCode, createdAt: supportMessages.createdAt }).from(supportMessages).leftJoin(users, eq(supportMessages.senderId, users.id)).where(eq(supportMessages.conversationId, conversation.id)).orderBy(supportMessages.createdAt).all();
  await db.update(supportConversations).set({ unreadCount: 0 }).where(eq(supportConversations.id, conversation.id)); return c.json({ success: true, data: rows, conversation });
});

routes.patch("/conversations/:id", async (c) => {
  const parsed = z.object({ status: z.enum(["open", "pending", "resolved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), assigneeId: z.string().nullable().optional() }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, code: "VALIDATION_FAILED", error: parsed.error.flatten() }, 400);
  await getDb(c.env.DB).update(supportConversations).set({ ...parsed.data, updatedAt: new Date().toISOString() }).where(eq(supportConversations.id, c.req.param("id"))); return c.json({ success: true });
});

routes.post("/conversations/:id/messages", async (c) => {
  const parsed = z.object({ body: z.string().trim().min(1).max(10000), internal: z.boolean().default(false) }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, code: "VALIDATION_FAILED", error: parsed.error.flatten() }, 400);
  const db = getDb(c.env.DB); const conversation = await db.select({ id: supportConversations.id, contact: supportConversations.contact, subject: supportConversations.subject, channelType: supportChannels.type, channelEnabled: supportChannels.enabled, senderId: supportChannels.senderId, accessToken: supportChannels.accessToken }).from(supportConversations).innerJoin(supportChannels, eq(supportConversations.channelId, supportChannels.id)).where(eq(supportConversations.id, c.req.param("id"))).get();
  if (!conversation) return c.json({ success: false, code: "NOT_FOUND", error: "Conversation not found" }, 404);
  const now = new Date().toISOString(); const id = crypto.randomUUID(); let deliveryStatus: "sent" | "failed" | "received" = parsed.data.internal ? "received" : "sent"; let errorCode: string | null = null; let externalId: string | null = null;
  if (!parsed.data.internal) {
    if (!conversation.channelEnabled) { deliveryStatus = "failed"; errorCode = "channel_disabled"; }
    else if (conversation.channelType === "email") { const outcome = await sendTransactionalEmail(db, { to: conversation.contact, subject: conversation.subject || "CodFlow support", html: `<p>${parsed.data.body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\n", "<br>")}</p>`, text: parsed.data.body, idempotencyKey: `support-${id}` }); deliveryStatus = outcome.sent ? "sent" : "failed"; errorCode = outcome.error; }
    else if (!conversation.senderId || !conversation.accessToken) { deliveryStatus = "failed"; errorCode = "channel_not_configured"; }
    else { try { const response = await fetch(`https://graph.facebook.com/v21.0/${conversation.senderId}/messages`, { method: "POST", headers: { authorization: `Bearer ${conversation.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", to: conversation.contact, type: "text", text: { body: parsed.data.body } }) }); const result = await response.json() as any; if (!response.ok) throw new Error(String(result?.error?.code ?? response.status)); externalId = result?.messages?.[0]?.id ?? null; } catch (error) { deliveryStatus = "failed"; errorCode = error instanceof Error ? error.message.slice(0, 80) : "provider_error"; } }
  }
  const row = { id, conversationId: conversation.id, direction: parsed.data.internal ? "internal" as const : "outbound" as const, channelType: conversation.channelType, senderId: c.get("user").id, body: parsed.data.body, externalId, deliveryStatus, errorCode, createdAt: now };
  await db.batch([db.insert(supportMessages).values(row), db.update(supportConversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(supportConversations.id, conversation.id))]); return c.json({ success: true, data: row }, 201);
});

routes.get("/tickets", async (c) => {
  const actor = c.get("user"); const conditions: any[] = []; const status = c.req.query("status"); if (status) conditions.push(eq(supportTickets.status, status as any)); if (actor.role !== "admin") conditions.push(eq(supportTickets.assigneeId, actor.id));
  const rows = await getDb(c.env.DB).select({ id: supportTickets.id, ticketNumber: supportTickets.ticketNumber, conversationId: supportTickets.conversationId, customerId: supportTickets.customerId, orderId: supportTickets.orderId, subject: supportTickets.subject, description: supportTickets.description, status: supportTickets.status, priority: supportTickets.priority, assigneeId: supportTickets.assigneeId, assigneeName: users.name, dueAt: supportTickets.dueAt, resolvedAt: supportTickets.resolvedAt, createdAt: supportTickets.createdAt, updatedAt: supportTickets.updatedAt }).from(supportTickets).leftJoin(users, eq(supportTickets.assigneeId, users.id)).where(conditions.length ? and(...conditions) : undefined).orderBy(sql`CASE ${supportTickets.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`, desc(supportTickets.createdAt)).limit(250).all(); return c.json({ success: true, data: rows, count: rows.length });
});

routes.post("/tickets", async (c) => {
  const parsed = z.object({ subject: z.string().trim().min(1).max(200), description: z.string().trim().max(5000).optional(), conversationId: z.string().optional(), customerId: z.string().optional(), orderId: z.string().optional(), priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"), assigneeId: z.string().optional(), dueAt: z.string().datetime().optional() }).safeParse(await c.req.json()); if (!parsed.success) return c.json({ success: false, code: "VALIDATION_FAILED", error: parsed.error.flatten() }, 400);
  const now = new Date().toISOString(); const row = { id: crypto.randomUUID(), ticketNumber: `T-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`, ...parsed.data, description: parsed.data.description ?? null, conversationId: parsed.data.conversationId ?? null, customerId: parsed.data.customerId ?? null, orderId: parsed.data.orderId ?? null, assigneeId: parsed.data.assigneeId ?? c.get("user").id, dueAt: parsed.data.dueAt ?? null, status: "open" as const, createdBy: c.get("user").id, resolvedAt: null, createdAt: now, updatedAt: now }; await getDb(c.env.DB).insert(supportTickets).values(row); return c.json({ success: true, data: row }, 201);
});

routes.patch("/tickets/:id", async (c) => {
  const parsed = z.object({ status: z.enum(["open", "in_progress", "waiting_customer", "resolved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), assigneeId: z.string().nullable().optional(), dueAt: z.string().datetime().nullable().optional() }).safeParse(await c.req.json()); if (!parsed.success) return c.json({ success: false, code: "VALIDATION_FAILED", error: parsed.error.flatten() }, 400); const now = new Date().toISOString(); await getDb(c.env.DB).update(supportTickets).set({ ...parsed.data, resolvedAt: parsed.data.status === "resolved" ? now : undefined, updatedAt: now }).where(eq(supportTickets.id, c.req.param("id"))); return c.json({ success: true });
});

routes.post("/orders/:id/customer-link", async (c) => {
  const parsed = z.object({ expiresInDays: z.number().int().min(1).max(90).default(30) }).safeParse(await c.req.json().catch(() => ({}))); if (!parsed.success) return c.json({ success: false, code: "VALIDATION_FAILED", error: parsed.error.flatten() }, 400);
  const db = getDb(c.env.DB); const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, c.req.param("id"))).get(); if (!order) return c.json({ success: false, code: "NOT_FOUND", error: "Order not found" }, 404);
  const bytes = crypto.getRandomValues(new Uint8Array(32)); const token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))).map((b) => b.toString(16).padStart(2, "0")).join(""); const now = new Date().toISOString(); const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 86400000).toISOString();
  await db.insert(customerOrderLinks).values({ id: crypto.randomUUID(), orderId: order.id, tokenHash: hash, expiresAt, revokedAt: null, lastViewedAt: null, createdBy: c.get("user").id, createdAt: now }); const base = new URL(c.env.WORKER_SELF_URL).origin; return c.json({ success: true, data: { url: `${base}/customer-order/${token}`, expiresAt } }, 201);
});

export default routes;
