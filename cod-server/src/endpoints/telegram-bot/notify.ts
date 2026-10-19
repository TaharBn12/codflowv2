/**
 * Outbound notifications: new-order pings, operational alerts, hourly/daily
 * digests, quiet hours, and the weekly/monthly scheduled reports.
 *
 * Every path is best-effort: a Telegram failure must never fail an order.
 */

import type { Env } from "@/types";
import { getDb, type AppDb } from "@/db";
import { orders, telegramUserLinks } from "@/db/schema";
import { eq, isNull } from "drizzle-orm";
import {
  getBotConfig,
  getSession,
  markAlertSent,
  pendingDigest,
  markDigestSent,
  queueDigest,
  recipientsForCategory,
  saveBotConfig,
  shouldSendAlert,
  type TelegramLinkRow,
} from "./store";
import { sendBotMessage, type InlineKeyboard, type TelegramFetch } from "./api";
import { resolveTelegramConfig } from "@/endpoints/telegram-approvals/service";
import { getDashboardAlerts, getReportConfig } from "../../../../cod-shared/queries/analytics";
import { getStore } from "../../../../cod-shared/queries/stores";
import { localClock } from "@/lib/daily-report";
import { botText, type BotLanguage } from "./i18n";
import { escapeHtml, money } from "./render";
import { buildPeriodReport, buildStockReport, alertLine } from "./reports";

export type AlertCategory = "orders" | "shipping" | "stock" | "finance" | "support" | "approvals" | "reports";
export type AlertSeverity = "info" | "warning" | "critical";

export interface NotifyContext {
  env: Env;
  db: AppDb;
  now: Date;
  fetchImpl?: TelegramFetch;
}

export async function botNotifyContext(env: Env, now = new Date()): Promise<NotifyContext | null> {
  const config = await resolveTelegramConfig(env);
  if (!config) return null;
  return { env, db: getDb(env.DB), now };
}

function inQuietHours(link: TelegramLinkRow, config: Awaited<ReturnType<typeof getBotConfig>>, now: Date, offsetMinutes: number): boolean {
  if (config.quietHoursStart === config.quietHoursEnd) return false;
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  const hour = local.getUTCHours();
  if (config.quietHoursStart < config.quietHoursEnd) {
    return hour >= config.quietHoursStart && hour < config.quietHoursEnd;
  }
  return hour >= config.quietHoursStart || hour < config.quietHoursEnd;
}

function isMuted(link: TelegramLinkRow, now: Date): boolean {
  return Boolean(link.mutedUntil && new Date(link.mutedUntil).getTime() > now.getTime());
}

function digestIntervalMinutes(mode: string, configMinutes: number): number {
  if (mode === "daily") return 24 * 60;
  if (mode === "hourly") return 60;
  return configMinutes;
}

/** Sends or queues one message for one linked user. */
async function deliver(
  ctx: NotifyContext,
  link: TelegramLinkRow,
  input: {
    text: string;
    keyboard?: InlineKeyboard;
    category: AlertCategory;
    severity: AlertSeverity;
    force?: boolean;
  },
): Promise<"sent" | "queued" | "skipped"> {
  const config = await getBotConfig(ctx.db);
  if (!config.enabled) return "skipped";
  const reportConfig = await getReportConfig(ctx.db);
  const clock = localClock(ctx.now, reportConfig.timezone);
  const critical = input.severity === "critical";
  const quiet = inQuietHours(link, config, ctx.now, clock.offsetMinutes);
  const muted = isMuted(link, ctx.now);
  const digest = link.digestMode !== "instant";

  if (!critical && !input.force && (quiet || muted || digest)) {
    await queueDigest(ctx.db, {
      telegramUserId: link.telegramUserId,
      kind: input.category,
      text: input.text,
    }, ctx.now);
    return "queued";
  }

  const bot = await resolveTelegramConfig(ctx.env);
  if (!bot) return "skipped";
  try {
    await sendBotMessage(
      bot,
      { chatId: link.chatId, text: input.text, keyboard: input.keyboard },
      ctx.fetchImpl,
    );
    return "sent";
  } catch (error) {
    console.warn("[telegram-bot] delivery failed", error);
    return "skipped";
  }
}

/**
 * Fan-out for operational alerts.
 * `dedupeKey` + `minIntervalMinutes` prevent the hourly cron from repeating the
 * same notice (e.g. one stuck-shipment summary per day).
 */
export async function broadcastAlert(
  ctx: NotifyContext,
  input: {
    category: AlertCategory;
    severity: AlertSeverity;
    text?: string;
    render?: (link: TelegramLinkRow) => { text: string; keyboard?: InlineKeyboard };
    keyboard?: InlineKeyboard;
    dedupeKey?: string;
    minIntervalMinutes?: number;
  },
): Promise<{ sent: number; queued: number; skipped: number }> {
  if (
    input.dedupeKey &&
    !(await shouldSendAlert(ctx.db, input.dedupeKey, input.minIntervalMinutes ?? 12 * 60, ctx.now))
  ) {
    return { sent: 0, queued: 0, skipped: 1 };
  }
  const recipients = await recipientsForCategory(ctx.db, input.category);
  let sent = 0;
  let queued = 0;
  let skipped = 0;
  for (const recipient of recipients) {
    const rendered = input.render ? input.render(recipient.link) : { text: input.text ?? "", keyboard: input.keyboard };
    const result = await deliver(ctx, recipient.link, {
      text: rendered.text,
      keyboard: rendered.keyboard,
      category: input.category,
      severity: input.severity,
    });
    if (result === "sent") sent += 1;
    else if (result === "queued") queued += 1;
    else skipped += 1;
  }
  if (input.dedupeKey && sent + queued > 0) {
    await markAlertSent(ctx.db, input.dedupeKey, input.severity, null, ctx.now);
  }
  return { sent, queued, skipped };
}

// ─── New order ───────────────────────────────────────────────────────────────

export async function notifyNewOrder(env: Env, orderId: string, now = new Date()): Promise<void> {
  try {
    const ctx = await botNotifyContext(env, now);
    if (!ctx) return;
    const order = await ctx.db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        phone: orders.phone,
        wilayaId: orders.wilayaId,
        price: orders.price,
        deliveryFee: orders.deliveryFee,
        status: orders.status,
        orderType: orders.orderType,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();
    if (!order) return;
    const store = await getStore(ctx.db);
    await broadcastAlert(ctx, {
      category: "orders",
      severity: "info",
      dedupeKey: `new-order:${order.id}`,
      minIntervalMinutes: 24 * 60,
      render: (link) => {
        const language = link.language as BotLanguage;
        return {
          text: [
            `🆕 <b>${botText(language, "menu_orders")}</b> — ${escapeHtml(store?.name ?? "CodFlow")}`,
            "",
            `#<code>${escapeHtml(order.orderNumber)}</code>${order.orderType === "offline" ? " · 🏪" : ""}`,
            `👤 ${escapeHtml(order.customerName)} · 📞 <code>${escapeHtml(order.phone)}</code>`,
            `🗺 ${order.wilayaId ?? "—"} · 💵 <b>${money(language, order.price + order.deliveryFee)}</b>`,
            "",
            `<i>${botText(language, "menu_hint")}</i>`,
          ].join("\n"),
          keyboard: [
            [
              {
                text: `👁 ${botText(language, "order_card", { number: order.orderNumber })}`,
                callback_data: `ov:${order.id}`,
              },
            ],
            [
              { text: `✅ ${botText(language, "status_confirmed")}`, callback_data: `os:${order.id}:cf` },
              { text: `📞 ${botText(language, "copy_phone")}`, callback_data: `ph:${order.id}` },
            ],
          ],
        };
      },
    });
  } catch (error) {
    console.warn("[telegram-bot] notifyNewOrder failed", error);
  }
}

// ─── Periodic alert scan ─────────────────────────────────────────────────────

const ALERT_CONFIG: Record<string, { category: AlertCategory; severity: AlertSeverity }> = {
  unconfirmed_orders: { category: "orders", severity: "warning" },
  unreachable_orders: { category: "orders", severity: "info" },
  stuck_out_for_delivery: { category: "shipping", severity: "warning" },
  stuck_dispatched: { category: "shipping", severity: "warning" },
  confirmed_not_shipped: { category: "shipping", severity: "warning" },
  low_stock: { category: "stock", severity: "warning" },
  stock_runway: { category: "stock", severity: "info" },
  driver_cash: { category: "finance", severity: "warning" },
  webhook_errors: { category: "shipping", severity: "critical" },
  overdue_tasks: { category: "support", severity: "warning" },
  pending_approvals: { category: "approvals", severity: "warning" },
  overdue_tickets: { category: "support", severity: "warning" },
  unread_support: { category: "support", severity: "info" },
  abandoned_24h: { category: "orders", severity: "info" },
};

/**
 * Hourly cron. Sends a consolidated operational digest per category, at most
 * once per `minIntervalMinutes` per alert key.
 */
export async function runAlertScan(env: Env, now = new Date()): Promise<void> {
  const ctx = await botNotifyContext(env, now);
  if (!ctx) return;
  const config = await getBotConfig(ctx.db);
  if (!config.enabled) return;

  const alerts = (await getDashboardAlerts(ctx.db, now)).filter((alert) => ALERT_CONFIG[alert.id]);
  const categories = new Map<AlertCategory, typeof alerts>();
  for (const alert of alerts) {
    const category = ALERT_CONFIG[alert.id].category;
    categories.set(category, [...(categories.get(category) ?? []), alert]);
    // Critical integration failures notify immediately, not once a day.
    if (ALERT_CONFIG[alert.id].severity === "critical") {
      await broadcastAlert(ctx, {
        category,
        severity: "critical",
        render: (link) => ({
          text: `🔴 <b>${link.language === "ar" ? "تنبيه حرج" : link.language === "fr" ? "Alerte critique" : "Critical alert"}</b>\n\n${alertLine(link.language as BotLanguage, alert)}`,
        }),
        dedupeKey: `alert:${alert.id}:${now.toISOString().slice(0, 10)}`,
        minIntervalMinutes: 60,
      });
    }
  }

  for (const [category, categoryAlerts] of categories) {
    const severity = categoryAlerts.length > 3 ? "warning" : "info";
    await broadcastAlert(ctx, {
      category,
      severity,
      render: (link) => {
        const language = link.language as BotLanguage;
        const title = language === "ar" ? "تنبيهات" : language === "fr" ? "Alertes" : "Alerts";
        return {
          text: [
            `⚠️ <b>${title} — ${category}</b>`,
            "",
            ...categoryAlerts.slice(0, 10).map((alert) => alertLine(language, alert)),
            "",
            `<i>${now.toISOString().slice(0, 16).replace("T", " ")}</i>`,
          ].join("\n"),
        };
      },
      dedupeKey: `digest:${category}:${now.toISOString().slice(0, 10)}`,
      minIntervalMinutes: 12 * 60,
    });
  }
}

// ─── Digest flush ────────────────────────────────────────────────────────────

function splitMessage(text: string, max = 3800): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > max) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function flushDigests(env: Env, now = new Date()): Promise<number> {
  const ctx = await botNotifyContext(env, now);
  if (!ctx) return 0;
  const config = await getBotConfig(ctx.db);
  if (!config.enabled) return 0;
  const bot = await resolveTelegramConfig(env);
  if (!bot) return 0;
  const reportConfig = await getReportConfig(ctx.db);
  const clock = localClock(now, reportConfig.timezone);

  // Iterate over every active link (not only order-notify recipients: a user
  // may have queued finance or stock alerts only).
  const links = await ctx.db
    .select()
    .from(telegramUserLinks)
    .where(isNull(telegramUserLinks.revokedAt))
    .all();
  let flushed = 0;
  for (const link of links) {
    if (link.revokedAt) continue;
    if (inQuietHours(link, config, now, clock.offsetMinutes) || isMuted(link, now)) continue;
    const pending = await pendingDigest(ctx.db, link.telegramUserId, 40);
    if (!pending.length) continue;
    const oldest = new Date(pending[0].createdAt).getTime();
    const interval = digestIntervalMinutes(link.digestMode, config.digestIntervalMinutes);
    if (now.getTime() - oldest < interval * 60_000) continue;
    const language = link.language as BotLanguage;
    const text = [`<b>${botText(language, "digest_header")}</b>`, "", ...pending.map((item) => item.text)]
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n");
    try {
      for (const chunk of splitMessage(text)) {
        await sendBotMessage(bot, { chatId: link.chatId, text: chunk });
      }
      await markDigestSent(ctx.db, pending.map((item) => item.id), now);
      flushed += 1;
    } catch (error) {
      console.warn("[telegram-bot] digest flush failed", error);
    }
  }
  return flushed;
}

// ─── Scheduled weekly / monthly reports ──────────────────────────────────────

export async function sendScheduledReports(env: Env, now = new Date()): Promise<void> {
  const ctx = await botNotifyContext(env, now);
  if (!ctx) return;
  const config = await getBotConfig(ctx.db);
  if (!config.enabled) return;
  const reportConfig = await getReportConfig(ctx.db);
  const clock = localClock(now, reportConfig.timezone);
  const weekday = new Date(`${clock.date}T00:00:00Z`).getUTCDay();
  const recipients = await recipientsForCategory(ctx.db, "reports");

  const weeklyDue =
    config.weeklyReportEnabled &&
    weekday === config.weeklyReportDay &&
    clock.hour >= config.weeklyReportHour &&
    config.lastWeeklySentOn !== clock.date;
  if (weeklyDue) {
    for (const recipient of recipients) {
      try {
        const text = await buildPeriodReport(ctx.db, "week", recipient.link.language as BotLanguage, now);
        await deliver(ctx, recipient.link, { text, category: "reports", severity: "info", force: true });
      } catch (error) {
        console.warn("[telegram-bot] weekly report failed", error);
      }
    }
    await saveBotConfig(ctx.db, { lastWeeklySentOn: clock.date }, now);
  }

  const monthlyDue =
    config.monthlyReportEnabled &&
    clock.date.endsWith("-01") &&
    clock.hour >= config.monthlyReportHour &&
    config.lastMonthlySentOn !== clock.date;
  if (monthlyDue) {
    for (const recipient of recipients) {
      try {
        const [period, stock] = await Promise.all([
          buildPeriodReport(ctx.db, "month", recipient.link.language as BotLanguage, now),
          buildStockReport(ctx.db, recipient.link.language as BotLanguage),
        ]);
        await deliver(ctx, recipient.link, {
          text: [period, "", stock].join("\n"),
          category: "reports",
          severity: "info",
          force: true,
        });
      } catch (error) {
        console.warn("[telegram-bot] monthly report failed", error);
      }
    }
    await saveBotConfig(ctx.db, { lastMonthlySentOn: clock.date }, now);
  }
}

export async function sendTestMessage(env: Env, telegramUserId: string, now = new Date()): Promise<boolean> {
  const ctx = await botNotifyContext(env, now);
  if (!ctx) return false;
  const bot = await resolveTelegramConfig(env);
  if (!bot) return false;
  const link = await ctx.db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.telegramUserId, telegramUserId))
    .get();
  if (!link) return false;
  const language = link.language as BotLanguage;
  try {
    await sendBotMessage(bot, { chatId: link.chatId, text: botText(language, "test_message") }, ctx.fetchImpl);
    return true;
  } catch {
    return false;
  }
}

export async function currentSessionState(env: Env, telegramUserId: string) {
  return getSession(getDb(env.DB), telegramUserId);
}
