import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  adminApprovalRequests,
  staffCommissions,
  telegramApprovalConfig,
} from "@/db/schema";
import type { Env, AuthUser } from "@/types";

export type ResolvedTelegramConfig = {
  botToken: string;
  chatId: string;
  webhookSecret: string;
  source: "environment" | "dashboard";
};

export async function resolveTelegramConfig(
  env: Env,
): Promise<ResolvedTelegramConfig | null> {
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
  if (
    env.TELEGRAM_BOT_TOKEN &&
    env.TELEGRAM_APPROVAL_CHAT_ID &&
    env.TELEGRAM_WEBHOOK_SECRET
  ) {
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
  const response = await fetch(
    `https://api.telegram.org/bot${config.botToken}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const result = (await response.json()) as {
    ok: boolean;
    result?: { message_id?: number };
    description?: string;
  };
  if (!response.ok || !result.ok)
    throw new Error(result.description ?? "Telegram request failed");
  return result;
}

export async function requestCommissionPayoutApproval(
  env: Env,
  actor: AuthUser,
  commissionIds: string[],
  amount: number,
) {
  const config = await resolveTelegramConfig(env);
  if (!config) throw new Error("Telegram approvals are not configured");
  const db = getDb(env.DB);
  const now = new Date().toISOString();
  const request = {
    id: crypto.randomUUID(),
    action: "mark_commissions_paid",
    title: "دفع عمولات الموظفين",
    payload: JSON.stringify({ commissionIds }),
    status: "pending" as const,
    requestedBy: actor.id,
    requestedByName: actor.name,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(adminApprovalRequests).values(request);
  try {
    const sent = await telegram(config, "sendMessage", {
      chat_id: config.chatId,
      text: `🔐 طلب موافقة إدارية\n\nالعملية: دفع عمولات الموظفين\nالعدد: ${commissionIds.length}\nالمبلغ: ${amount.toFixed(2)} دج\nطلبها: ${actor.name}\nصالحة لمدة 24 ساعة`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ موافقة",
              callback_data: `approval:approve:${request.id}`,
            },
            { text: "❌ رفض", callback_data: `approval:reject:${request.id}` },
          ],
        ],
      },
    });
    const messageId = sent.result?.message_id;
    if (messageId)
      await db
        .update(adminApprovalRequests)
        .set({ telegramMessageId: String(messageId) })
        .where(eq(adminApprovalRequests.id, request.id));
    return request;
  } catch (cause) {
    await db
      .update(adminApprovalRequests)
      .set({
        status: "failed",
        decisionNote: cause instanceof Error ? cause.message : String(cause),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(adminApprovalRequests.id, request.id));
    throw cause;
  }
}

export async function decideApproval(
  env: Env,
  id: string,
  decision: "approve" | "reject",
  telegramUserId: string,
) {
  const db = getDb(env.DB);
  const request = await db
    .select()
    .from(adminApprovalRequests)
    .where(eq(adminApprovalRequests.id, id))
    .get();
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
        decidedByTelegramId: telegramUserId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(adminApprovalRequests.id, id));
    return { ok: true, text: "❌ تم رفض العملية" };
  }
  try {
    if (request.action === "mark_commissions_paid") {
      const payload = JSON.parse(request.payload) as {
        commissionIds: string[];
      };
      for (const commissionId of payload.commissionIds) {
        await db
          .update(staffCommissions)
          .set({ status: "paid", paidAt: now, updatedAt: now })
          .where(eq(staffCommissions.id, commissionId));
      }
    } else throw new Error("Unsupported approval action");
    await db
      .update(adminApprovalRequests)
      .set({
        status: "approved",
        decidedByTelegramId: telegramUserId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(adminApprovalRequests.id, id));
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

export async function answerTelegramCallback(
  env: Env,
  callbackId: string,
  text: string,
) {
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
    allowed_updates: ["callback_query"],
    drop_pending_updates: false,
  });
  return webhookUrl;
}
