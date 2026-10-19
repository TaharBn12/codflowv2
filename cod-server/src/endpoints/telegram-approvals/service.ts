/**
 * Admin approvals over Telegram + dashboard.
 *
 * A request is stored in `admin_approval_requests` first, so the decision is
 * possible from Telegram *and* from the dashboard inbox (no single point of
 * failure). Decisions are idempotent: an already-handled request never runs
 * its action twice.
 */

import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb, type AppDb } from "@/db";
import {
  adminApprovalRequests,
  orders,
  staffCommissions,
  telegramApprovalConfig,
  telegramApprovalPolicies,
  telegramUserLinks,
  users,
} from "@/db/schema";
import type { Env, AuthUser } from "@/types";
import { updateOrderStatus } from "../../../../cod-shared/queries/orders";
import { canTransition } from "@/endpoints/orders/transitions";

export const APPROVAL_ACTIONS = [
  { key: "orders.status_change", category: "orders", roles: ["admin", "staff", "confirmer"] },
  { key: "orders.edit", category: "orders", roles: ["admin", "staff", "confirmer"] },
  { key: "orders.delete", category: "orders", roles: ["admin", "staff"] },
  { key: "orders.assign_confirmer", category: "orders", roles: ["admin", "staff"] },
  { key: "orders.assign_driver", category: "orders", roles: ["admin", "staff"] },
  { key: "orders.dispatch", category: "orders", roles: ["admin", "staff"] },
  { key: "orders.return", category: "orders", roles: ["admin", "staff", "driver"] },
  { key: "commissions.mark_paid", category: "finance", roles: ["admin"] },
  { key: "drivers.record_payment", category: "finance", roles: ["admin", "staff"] },
  { key: "inventory.adjust", category: "orders", roles: ["admin", "staff"] },
  { key: "products.delete", category: "catalog", roles: ["admin", "staff"] },
  { key: "customers.delete", category: "customers", roles: ["admin", "staff"] },
  { key: "team.create", category: "team", roles: ["admin"] },
  { key: "team.permissions", category: "team", roles: ["admin"] },
  { key: "team.disable", category: "team", roles: ["admin"] },
  { key: "settings.operations", category: "settings", roles: ["admin"] },
  { key: "settings.integrations", category: "settings", roles: ["admin"] },
  { key: "landing_pages.publish", category: "marketing", roles: ["admin", "staff"] },
  { key: "landing_pages.delete", category: "marketing", roles: ["admin", "staff"] },
] as const;

export type ApprovalActionKey = (typeof APPROVAL_ACTIONS)[number]["key"];

export const APPROVAL_TTL_MINUTES: Record<string, number> = {
  "commissions.mark_paid": 24 * 60,
  "drivers.record_payment": 24 * 60,
  "orders.status_change": 12 * 60,
  "orders.return": 12 * 60,
  default: 24 * 60,
};

export function approvalTtlMinutes(action: string): number {
  return APPROVAL_TTL_MINUTES[action] ?? APPROVAL_TTL_MINUTES.default;
}

export async function requiresTelegramApproval(
  db: ReturnType<typeof getDb>,
  userId: string,
  action: ApprovalActionKey,
) {
  const row = await db
    .select({ action: telegramApprovalPolicies.action, enabled: telegramApprovalPolicies.enabled })
    .from(telegramApprovalPolicies)
    .where(eq(telegramApprovalPolicies.userId, userId))
    .all();
  const policy = row.find((item: { action: string; enabled: boolean }) => item.action === action);
  return policy?.enabled ?? action === "commissions.mark_paid";
}

export type ResolvedTelegramConfig = {
  botToken: string;
  chatId: string;
  webhookSecret: string;
  source: "environment" | "dashboard";
};

export async function resolveTelegramConfig(env: Env): Promise<ResolvedTelegramConfig | null> {
  // Dashboard settings override Worker secrets; environment values remain a
  // zero-downtime fallback until dashboard settings are saved.
  const row = await getDb(env.DB)
    .select()
    .from(telegramApprovalConfig)
    .where(eq(telegramApprovalConfig.id, "default"))
    .get();
  if (row) {
    if (!row.enabled || !row.botToken || !row.chatId || !row.webhookSecret) return null;
    return {
      botToken: row.botToken,
      chatId: row.chatId,
      webhookSecret: row.webhookSecret,
      source: "dashboard",
    };
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_APPROVAL_CHAT_ID && env.TELEGRAM_WEBHOOK_SECRET) {
    return {
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_APPROVAL_CHAT_ID,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      source: "environment",
    };
  }
  return null;
}

async function telegram(
  config: ResolvedTelegramConfig,
  method: string,
  body: Record<string, unknown>,
) {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as {
    ok: boolean;
    result?: { message_id?: number };
    description?: string;
  };
  if (!response.ok || !result.ok) throw new Error(result.description ?? "Telegram request failed");
  return result;
}

export interface ApprovalRequestRecord {
  id: string;
  action: string;
  title: string;
  payload: string;
  status: "pending" | "approved" | "rejected" | "expired" | "failed";
  requestedBy: string;
  requestedByName: string;
  decidedByTelegramId: string | null;
  decisionNote: string | null;
  telegramMessageId: string | null;
  reminderSentAt: string | null;
  escalatedAt: string | null;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Notifications ───────────────────────────────────────────────────────────

/**
 * Sends a message to every admin who linked their Telegram account, plus the
 * configured approval chat. Returns the first message id (used as the canonical
 * `telegram_message_id` for the request).
 */
export async function broadcastToAdmins(
  env: Env,
  text: string,
  keyboard?: unknown[][],
): Promise<{ sent: number; messageId: number | null }> {
  const config = await resolveTelegramConfig(env);
  if (!config) return { sent: 0, messageId: null };
  const db = getDb(env.DB);
  const linkedAdmins = await db
    .select({ chatId: telegramUserLinks.chatId })
    .from(telegramUserLinks)
    .innerJoin(users, eq(users.id, telegramUserLinks.userId))
    .where(and(isNull(telegramUserLinks.revokedAt), eq(users.role, "admin"), eq(users.status, "active")))
    .all();
  const chatIds = new Set<string>([String(config.chatId), ...linkedAdmins.map((row) => String(row.chatId))]);
  let sent = 0;
  let messageId: number | null = null;
  for (const chatId of chatIds) {
    try {
      const result = await telegram(config, "sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
      sent += 1;
      if (messageId == null && result.result?.message_id) messageId = result.result.message_id;
    } catch (error) {
      console.warn("[telegram-approvals] broadcast failed", error);
    }
  }
  return { sent, messageId };
}

async function notifyUser(env: Env, userId: string, text: string): Promise<void> {
  const config = await resolveTelegramConfig(env);
  if (!config) return;
  const db = getDb(env.DB);
  const link = await db
    .select({ chatId: telegramUserLinks.chatId })
    .from(telegramUserLinks)
    .where(and(eq(telegramUserLinks.userId, userId), isNull(telegramUserLinks.revokedAt)))
    .get();
  if (!link) return;
  try {
    await telegram(config, "sendMessage", {
      chat_id: link.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (error) {
    console.warn("[telegram-approvals] requester notify failed", error);
  }
}

function approvalKeyboard(id: string) {
  return [
    [
      { text: "✅ موافقة", callback_data: `ad:y:${id}` },
      { text: "❌ رفض", callback_data: `ad:n:${id}` },
    ],
    [{ text: "🔎 التفاصيل", callback_data: `aw:${id}` }],
  ];
}

async function createRequest(
  env: Env,
  input: {
    action: string;
    title: string;
    payload: Record<string, unknown>;
    requestedBy: string;
    requestedByName: string;
    text: string;
  },
): Promise<ApprovalRequestRecord> {
  const db = getDb(env.DB);
  const now = new Date();
  const id = crypto.randomUUID();
  const record = {
    id,
    action: input.action,
    title: input.title,
    payload: JSON.stringify(input.payload),
    status: "pending" as const,
    requestedBy: input.requestedBy,
    requestedByName: input.requestedByName,
    expiresAt: new Date(now.getTime() + approvalTtlMinutes(input.action) * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await db.insert(adminApprovalRequests).values(record);

  const text = [
    `<b>🔐 ${input.title}</b>`,
    "",
    input.text,
    `طلبها: ${input.requestedByName}`,
    `صالحة حتى: ${record.expiresAt.slice(0, 16).replace("T", " ")}`,
  ].join("\n");

  const broadcast = await broadcastToAdmins(env, text, approvalKeyboard(id));
  if (broadcast.messageId) {
    await db
      .update(adminApprovalRequests)
      .set({ telegramMessageId: String(broadcast.messageId) })
      .where(eq(adminApprovalRequests.id, id));
  }
  return { ...record, telegramMessageId: broadcast.messageId ? String(broadcast.messageId) : null } as ApprovalRequestRecord;
}

export async function requestCommissionPayoutApproval(
  env: Env,
  actor: AuthUser,
  commissionIds: string[],
  amount: number,
) {
  return createRequest(env, {
    action: "mark_commissions_paid",
    title: "دفع عمولات الموظفين",
    payload: { commissionIds, amount },
    requestedBy: actor.id,
    requestedByName: actor.name,
    text: `العملية: دفع عمولات الموظفين\nالعدد: ${commissionIds.length}\nالمبلغ: ${amount.toFixed(2)} دج`,
  });
}

/**
 * Creates an approval request for an order status change (used by the bot when
 * the acting user's policy requires it, and available to the dashboard API).
 */
export async function requestOrderStatusApproval(
  env: Env,
  input: {
    requestedBy: string;
    requestedByName: string;
    orderId: string;
    orderNumber: string;
    fromStatus: string;
    targetStatus: string;
    reason?: string | null;
  },
) {
  return createRequest(env, {
    action: "orders.status_change",
    title: `تغيير حالة الطلب ${input.orderNumber}`,
    payload: {
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      from: input.fromStatus,
      status: input.targetStatus,
    },
    requestedBy: input.requestedBy,
    requestedByName: input.requestedByName,
    text: [
      `الطلب: <code>${input.orderNumber}</code>`,
      `من: ${input.fromStatus} → إلى: ${input.targetStatus}`,
      input.reason ? `السبب: ${input.reason}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

// ─── Decisions ───────────────────────────────────────────────────────────────

async function executeApprovedAction(
  env: Env,
  request: ApprovalRequestRecord,
  now: string,
): Promise<void> {
  const db = getDb(env.DB);
  if (request.action === "mark_commissions_paid") {
    const payload = JSON.parse(request.payload) as { commissionIds: string[] };
    for (const commissionId of payload.commissionIds) {
      await db
        .update(staffCommissions)
        .set({ status: "paid", paidAt: now, updatedAt: now })
        .where(eq(staffCommissions.id, commissionId));
    }
    return;
  }

  if (request.action === "orders.status_change" || request.action === "orders.return") {
    const payload = JSON.parse(request.payload) as {
      orderId: string;
      status?: string;
      from?: string;
    };
    const target = request.action === "orders.return" ? "returned" : payload.status;
    if (!target) throw new Error("Approval payload has no target status");
    const order = await db
      .select({ id: orders.id, status: orders.status, orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.id, payload.orderId))
      .get();
    if (!order) throw new Error("Order not found");
    if (!canTransition(order.status, target)) {
      throw new Error(`Transition ${order.status} → ${target} is no longer valid`);
    }
    await updateOrderStatus(
      db,
      order.id,
      target as typeof orders.$inferSelect.status,
      `approval:${request.id}`,
      `${request.requestedByName} (approved)`,
    );
    return;
  }

  throw new Error("Unsupported approval action");
}

export async function decideApproval(
  env: Env,
  id: string,
  decision: "approve" | "reject",
  telegramUserId: string,
  options: {
    note?: string | null;
    actorUserId?: string | null;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
) {
  const db = getDb(env.DB);
  const request = (await db
    .select()
    .from(adminApprovalRequests)
    .where(eq(adminApprovalRequests.id, id))
    .get()) as ApprovalRequestRecord | undefined;
  if (!request || request.status !== "pending")
    return { ok: false, text: "تمت معالجة هذا الطلب مسبقًا" };
  const now = new Date().toISOString();
  if (request.expiresAt < now) {
    await db
      .update(adminApprovalRequests)
      .set({ status: "expired", updatedAt: now })
      .where(eq(adminApprovalRequests.id, id));
    return { ok: false, text: "انتهت صلاحية طلب الموافقة" };
  }
  if (decision === "reject") {
    await db
      .update(adminApprovalRequests)
      .set({
        status: "rejected",
        decidedByTelegramId: options.actorUserId ? `user:${options.actorUserId}` : telegramUserId,
        decidedAt: now,
        decisionNote: options.note ?? null,
        updatedAt: now,
      })
      .where(eq(adminApprovalRequests.id, id));
    await notifyUser(
      env,
      request.requestedBy,
      `❌ رُفض طلبك: <b>${request.title}</b>${options.note ? `\nالسبب: ${options.note}` : ""}`,
    );
    return { ok: true, text: "❌ تم رفض العملية" };
  }
  try {
    await executeApprovedAction(env, request, now);
    // The approved action can be an order status change that should fire the
    // Meta CAPI conversion (same helper the HTTP route uses).
    if (request.action === "orders.status_change" || request.action === "orders.return") {
      try {
        const payload = JSON.parse(request.payload) as { orderId: string; status?: string };
        const target = request.action === "orders.return" ? "returned" : payload.status;
        const order = await db
          .select({ wilayaId: orders.wilayaId })
          .from(orders)
          .where(eq(orders.id, payload.orderId))
          .get();
        if (target && env.CAPI_WORKFLOW) {
          const { shouldTriggerCapiConfirmed, shouldTriggerCapiPurchase, getCapiWorkflowId } = await import(
            "@/workflows/capi-helpers"
          );
          const confirmed = shouldTriggerCapiConfirmed(target);
          if (confirmed || shouldTriggerCapiPurchase(target, order?.wilayaId ?? null)) {
            const stage = confirmed ? "confirmed" : "delivered";
            const promise = env.CAPI_WORKFLOW.create({
              id: getCapiWorkflowId(payload.orderId, stage, "Purchase"),
              params: {
                orderId: payload.orderId,
                eventName: "Purchase",
                stage,
                triggeredAt: Math.floor(Date.now() / 1000),
                triggerStatus: target,
              },
            }).catch((error: Error) => console.error("[telegram-approvals] capi trigger failed", error));
            options.waitUntil?.(promise);
          }
        }
      } catch (capiError) {
        console.warn("[telegram-approvals] capi evaluation failed", capiError);
      }
    }
    await db
      .update(adminApprovalRequests)
      .set({
        status: "approved",
        decidedByTelegramId: options.actorUserId ? `user:${options.actorUserId}` : telegramUserId,
        decidedAt: now,
        decisionNote: options.note ?? null,
        updatedAt: now,
      })
      .where(eq(adminApprovalRequests.id, id));
    await notifyUser(env, request.requestedBy, `✅ تمت الموافقة على: <b>${request.title}</b>`);
    return { ok: true, text: "✅ تمت الموافقة وتنفيذ العملية" };
  } catch (cause) {
    await db
      .update(adminApprovalRequests)
      .set({
        status: "failed",
        decisionNote: cause instanceof Error ? cause.message : String(cause),
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(adminApprovalRequests.id, id));
    return { ok: false, text: "تعذر تنفيذ العملية بعد الموافقة" };
  }
}

// ─── Inbox / reminders ───────────────────────────────────────────────────────

export interface ApprovalListOptions {
  status?: "pending" | "approved" | "rejected" | "expired" | "failed" | "all";
  limit?: number;
  offset?: number;
}

export async function getApprovalById(db: AppDb, id: string): Promise<ApprovalRequestRecord | null> {
  const row = await db
    .select()
    .from(adminApprovalRequests)
    .where(eq(adminApprovalRequests.id, id))
    .get();
  return (row as ApprovalRequestRecord | undefined) ?? null;
}

export async function listApprovals(db: AppDb, options: ApprovalListOptions = {}) {
  const status = options.status ?? "pending";
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const offset = Math.max(0, options.offset ?? 0);
  const where = status === "all" ? undefined : eq(adminApprovalRequests.status, status);
  const query = db
    .select()
    .from(adminApprovalRequests)
    .orderBy(desc(adminApprovalRequests.createdAt))
    .limit(limit)
    .offset(offset);
  const rows = where ? await query.where(where).all() : await query.all();
  const countQuery = db
    .select({ count: sql<number>`count(*)` })
    .from(adminApprovalRequests);
  const countRow = where ? await countQuery.where(where).get() : await countQuery.get();
  return { rows: rows as ApprovalRequestRecord[], total: Number(countRow?.count ?? 0) };
}

/**
 * Hourly cron:
 *  - expires overdue requests;
 *  - reminds approvers 6h before expiry (once);
 *  - notifies the requester when a request expires.
 */
export async function sendApprovalReminders(env: Env, now = new Date()): Promise<number> {
  const db = getDb(env.DB);
  const nowIso = now.toISOString();
  const expired = await db
    .select()
    .from(adminApprovalRequests)
    .where(and(eq(adminApprovalRequests.status, "pending"), lt(adminApprovalRequests.expiresAt, nowIso)))
    .all();
  for (const request of expired) {
    await db
      .update(adminApprovalRequests)
      .set({ status: "expired", updatedAt: nowIso })
      .where(eq(adminApprovalRequests.id, request.id));
    await notifyUser(env, request.requestedBy, `⌛ انتهت صلاحية طلب الموافقة: <b>${request.title}</b>`);
  }

  const soon = new Date(now.getTime() + 6 * 3_600_000).toISOString();
  const pending = await db
    .select()
    .from(adminApprovalRequests)
    .where(
      and(
        eq(adminApprovalRequests.status, "pending"),
        gte(adminApprovalRequests.expiresAt, nowIso),
        lt(adminApprovalRequests.expiresAt, soon),
        isNull(adminApprovalRequests.reminderSentAt),
      ),
    )
    .all();

  let reminded = 0;
  for (const request of pending) {
    const sent = await broadcastToAdmins(
      env,
      `⏰ تذكير: طلب موافقة ينتظر قرارك\n\n<b>${request.title}</b>\nطلبها: ${request.requestedByName}\nتنتهي: ${request.expiresAt.slice(0, 16).replace("T", " ")}`,
      approvalKeyboard(request.id),
    );
    if (sent.sent > 0) {
      await db
        .update(adminApprovalRequests)
        .set({ reminderSentAt: nowIso, updatedAt: nowIso })
        .where(eq(adminApprovalRequests.id, request.id));
      reminded += 1;
    }
  }
  return reminded + expired.length;
}

export async function answerTelegramCallback(env: Env, callbackId: string, text: string) {
  const config = await resolveTelegramConfig(env);
  if (!config) return;
  return telegram(config, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: true,
  });
}

export async function configureTelegramWebhook(env: Env) {
  const config = await resolveTelegramConfig(env);
  if (!config) throw new Error("Telegram approval settings are incomplete");
  const origin = new URL(env.WORKER_SELF_URL).origin;
  const webhookUrl = `${origin}/webhooks/telegram`;
  await telegram(config, "setWebhook", {
    url: webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  // Publish the "/" menu per language. Failures never block webhook setup.
  const commandLists: Record<string, Array<{ command: string; description: string }>> = {
    ar: [
      { command: "menu", description: "القائمة الرئيسية" },
      { command: "orders", description: "تصفح الطلبات وغيّر حالتها" },
      { command: "order", description: "بطاقة طلب برقم أو هاتف" },
      { command: "report", description: "تقرير اليوم/الأسبوع/الشهر" },
      { command: "pending", description: "الموافقات المعلّقة" },
      { command: "stock", description: "المخزون الحرج" },
      { command: "mute", description: "كتم التنبيهات مؤقتاً" },
      { command: "link", description: "ربط حسابك برمز" },
      { command: "settings", description: "الإعدادات واللغة" },
      { command: "help", description: "المساعدة" },
    ],
    fr: [
      { command: "menu", description: "Menu principal" },
      { command: "orders", description: "Commandes et statuts" },
      { command: "order", description: "Fiche commande" },
      { command: "report", description: "Rapport jour/semaine/mois" },
      { command: "pending", description: "Approbations en attente" },
      { command: "stock", description: "Stock critique" },
      { command: "mute", description: "Pause des alertes" },
      { command: "link", description: "Lier votre compte" },
      { command: "settings", description: "Paramètres et langue" },
      { command: "help", description: "Aide" },
    ],
    en: [
      { command: "menu", description: "Main menu" },
      { command: "orders", description: "Browse orders and change status" },
      { command: "order", description: "Order card by number or phone" },
      { command: "report", description: "Today/week/month report" },
      { command: "pending", description: "Pending approvals" },
      { command: "stock", description: "Critical stock" },
      { command: "mute", description: "Pause alerts" },
      { command: "link", description: "Link your account" },
      { command: "settings", description: "Settings and language" },
      { command: "help", description: "Help" },
    ],
  };
  for (const [languageCode, commands] of Object.entries(commandLists)) {
    try {
      await telegram(config, "setMyCommands", { commands, language_code: languageCode });
    } catch (error) {
      console.warn(`[telegram] setMyCommands(${languageCode}) failed`, error);
    }
  }
  return webhookUrl;
}

/** Ids of active admins — used to limit who may join the approval chat. */
export async function adminUserIds(db: AppDb): Promise<string[]> {
  return (
    await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.status, "active")))
      .all()
  ).map((row) => row.id);
}

export async function pendingApprovalCount(db: AppDb, now = new Date()): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(adminApprovalRequests)
    .where(and(eq(adminApprovalRequests.status, "pending"), gte(adminApprovalRequests.expiresAt, now.toISOString())))
    .get();
  return Number(row?.count ?? 0);
}

export async function approvalsForUsers(db: AppDb, userIds: string[]) {
  if (!userIds.length) return [];
  return db
    .select()
    .from(adminApprovalRequests)
    .where(inArray(adminApprovalRequests.requestedBy, userIds))
    .orderBy(desc(adminApprovalRequests.createdAt))
    .limit(50)
    .all();
}
