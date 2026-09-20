/**
 * Daily KPI report — built from the analytics queries and delivered over the
 * channels the merchant already configured (Telegram bot, Sendili email).
 *
 * The report covers the store-local day so far (00:00 → now) and compares it
 * with the full previous day. Rendering is trilingual (ar / fr / en) and
 * follows the store language.
 */

import type { AppDb } from "@/db";
import { getDb } from "@/db";
import type { Env } from "@/types";
import {
  getAnalyticsOverview,
  getDashboardAlerts,
  getProductAnalytics,
  getReportConfig,
  getWilayaAnalytics,
  markReportSent,
  type DashboardAlert,
  type OverviewTotals,
  type ReportConfig,
} from "../../../cod-shared/queries/analytics";
import { getStore } from "../../../cod-shared/queries/stores";
import { sendTransactionalEmail } from "../../../cod-shared/lib/transactional-email";
import { resolveTelegramConfig } from "@/endpoints/telegram-approvals/service";

export type ReportLanguage = "ar" | "en" | "fr";

export interface LocalClock {
  /** YYYY-MM-DD in the report timezone */
  date: string;
  hour: number;
  offsetMinutes: number;
  startOfDayIso: string;
}

export function localClock(now: Date, timeZone: string): LocalClock {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Algiers",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const asUtc = Date.UTC(year, month - 1, day, hour, Number(parts.minute), Number(parts.second));
  const offsetMinutes = Math.round((asUtc - now.getTime()) / 60_000);
  const startOfDayIso = new Date(Date.UTC(year, month - 1, day) - offsetMinutes * 60_000).toISOString();
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    offsetMinutes,
    startOfDayIso,
  };
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

const COPY: Record<ReportLanguage, Record<string, string>> = {
  ar: {
    title: "التقرير اليومي",
    orders: "الطلبات",
    confirmed: "مؤكدة",
    delivered: "مُسلَّمة",
    returned: "مرتجعة",
    cancelled: "ملغاة",
    revenue_delivered: "إيراد مُحصَّل",
    revenue_pending: "إيراد معلّق",
    confirmation_rate: "نسبة التأكيد",
    delivery_rate: "نسبة التسليم",
    return_rate: "نسبة الإرجاع",
    aov: "متوسط السلة",
    vs_yesterday: "مقارنة بالأمس",
    top_products: "أفضل المنتجات",
    top_wilayas: "أفضل الولايات",
    alerts: "تنبيهات",
    no_alerts: "لا توجد تنبيهات",
    no_orders: "لا توجد طلبات اليوم بعد",
    currency: "دج",
    footer: "أُرسل تلقائياً من CodFlow",
    alert_unconfirmed_orders: "طلبات بدون تأكيد منذ أكثر من 24 ساعة",
    alert_unreachable_orders: "طلبات لم يتم الوصول لأصحابها",
    alert_stuck_out_for_delivery: "شحنات عالقة في الطريق (+5 أيام)",
    alert_stuck_dispatched: "شحنات بلا تحديث من الناقل (+7 أيام)",
    alert_confirmed_not_shipped: "طلبات مؤكدة لم تُشحن منذ 48 ساعة",
    alert_low_stock: "منتجات منخفضة/نافدة المخزون",
    alert_stock_runway: "منتجات ستنفد خلال أسبوع",
    alert_driver_cash: "سائقون لديهم كاش غير مُسلَّم",
    alert_webhook_errors: "أخطاء webhook خلال 24 ساعة",
    alert_overdue_tasks: "مهام متأخرة",
    alert_pending_approvals: "موافقات معلّقة",
    alert_overdue_tickets: "تذاكر دعم متأخرة",
    alert_unread_support: "رسائل دعم غير مقروءة",
    alert_abandoned_24h: "سلات متروكة خلال 24 ساعة",
  },
  fr: {
    title: "Rapport quotidien",
    orders: "Commandes",
    confirmed: "Confirmées",
    delivered: "Livrées",
    returned: "Retournées",
    cancelled: "Annulées",
    revenue_delivered: "Revenu encaissé",
    revenue_pending: "Revenu en attente",
    confirmation_rate: "Taux de confirmation",
    delivery_rate: "Taux de livraison",
    return_rate: "Taux de retour",
    aov: "Panier moyen",
    vs_yesterday: "vs hier",
    top_products: "Meilleurs produits",
    top_wilayas: "Meilleures wilayas",
    alerts: "Alertes",
    no_alerts: "Aucune alerte",
    no_orders: "Aucune commande aujourd'hui pour l'instant",
    currency: "DA",
    footer: "Envoyé automatiquement par CodFlow",
    alert_unconfirmed_orders: "commandes non confirmées depuis +24h",
    alert_unreachable_orders: "commandes injoignables",
    alert_stuck_out_for_delivery: "colis bloqués en livraison (+5 j)",
    alert_stuck_dispatched: "colis sans mise à jour transporteur (+7 j)",
    alert_confirmed_not_shipped: "commandes confirmées non expédiées depuis 48h",
    alert_low_stock: "produits en stock bas / rupture",
    alert_stock_runway: "produits épuisés d'ici une semaine",
    alert_driver_cash: "livreurs avec du cash non remis",
    alert_webhook_errors: "erreurs webhook sur 24h",
    alert_overdue_tasks: "tâches en retard",
    alert_pending_approvals: "approbations en attente",
    alert_overdue_tickets: "tickets support en retard",
    alert_unread_support: "messages support non lus",
    alert_abandoned_24h: "paniers abandonnés sur 24h",
  },
  en: {
    title: "Daily report",
    orders: "Orders",
    confirmed: "Confirmed",
    delivered: "Delivered",
    returned: "Returned",
    cancelled: "Cancelled",
    revenue_delivered: "Collected revenue",
    revenue_pending: "Pending revenue",
    confirmation_rate: "Confirmation rate",
    delivery_rate: "Delivery rate",
    return_rate: "Return rate",
    aov: "Average order value",
    vs_yesterday: "vs yesterday",
    top_products: "Top products",
    top_wilayas: "Top wilayas",
    alerts: "Alerts",
    no_alerts: "No alerts",
    no_orders: "No orders yet today",
    currency: "DZD",
    footer: "Sent automatically by CodFlow",
    alert_unconfirmed_orders: "orders unconfirmed for 24h+",
    alert_unreachable_orders: "unreachable orders",
    alert_stuck_out_for_delivery: "shipments stuck out for delivery (5d+)",
    alert_stuck_dispatched: "shipments without carrier update (7d+)",
    alert_confirmed_not_shipped: "confirmed orders not shipped for 48h",
    alert_low_stock: "low / out-of-stock products",
    alert_stock_runway: "products running out within a week",
    alert_driver_cash: "drivers holding unsettled cash",
    alert_webhook_errors: "webhook errors in 24h",
    alert_overdue_tasks: "overdue tasks",
    alert_pending_approvals: "pending approvals",
    alert_overdue_tickets: "overdue support tickets",
    alert_unread_support: "unread support messages",
    alert_abandoned_24h: "abandoned carts in 24h",
  },
};

export function reportLanguage(value: string | null | undefined): ReportLanguage {
  return value === "ar" || value === "fr" || value === "en" ? value : "en";
}

function money(value: number, language: ReportLanguage) {
  const locale = language === "ar" ? "ar-DZ" : language === "fr" ? "fr-DZ" : "en-US";
  return `${Math.round(value).toLocaleString(locale)} ${COPY[language].currency}`;
}

function pct(value: number | null) {
  return value == null ? "—" : `${value}%`;
}

function delta(current: number, previous: number): string {
  if (!previous) return current ? "▲ new" : "";
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return "=";
  return `${change > 0 ? "▲" : "▼"} ${Math.abs(change)}%`;
}

export interface DailyReportData {
  date: string;
  storeName: string;
  language: ReportLanguage;
  today: OverviewTotals;
  yesterday: OverviewTotals;
  topProducts: Array<{ name: string; orders: number; revenueDelivered: number }>;
  topWilayas: Array<{ name: string; orders: number; deliveryRate: number | null }>;
  alerts: DashboardAlert[];
}

export async function buildDailyReport(
  db: AppDb,
  now: Date,
  timeZone: string,
): Promise<DailyReportData> {
  const clock = localClock(now, timeZone);
  const store = await getStore(db);
  const language = reportLanguage(store?.lang);
  const todayRange = { from: clock.startOfDayIso, to: now.toISOString() };
  const yesterdayRange = {
    from: new Date(new Date(clock.startOfDayIso).getTime() - 24 * 3_600_000).toISOString(),
    to: clock.startOfDayIso,
  };
  const [today, yesterday, products, wilayas, alerts] = await Promise.all([
    getAnalyticsOverview(db, todayRange),
    getAnalyticsOverview(db, yesterdayRange),
    getProductAnalytics(db, todayRange, 5),
    getWilayaAnalytics(db, todayRange),
    getDashboardAlerts(db, now),
  ]);
  return {
    date: clock.date,
    storeName: store?.name ?? "CodFlow",
    language,
    today: today.current,
    yesterday: yesterday.current,
    topProducts: products.slice(0, 3).map((product) => ({
      name: product.name,
      orders: product.orders,
      revenueDelivered: product.revenueDelivered,
    })),
    topWilayas: wilayas
      .filter((wilaya) => wilaya.wilayaId != null)
      .slice(0, 3)
      .map((wilaya) => ({
        name: (language === "ar" ? wilaya.nameAr : wilaya.name) ?? String(wilaya.wilayaId),
        orders: wilaya.orders,
        deliveryRate: wilaya.deliveryRate,
      })),
    alerts,
  };
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function alertLine(alert: DashboardAlert, language: ReportLanguage) {
  const label = COPY[language][`alert_${alert.id}`] ?? alert.id;
  const icon = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟠" : "🔵";
  const amount = alert.amount != null ? ` (${money(alert.amount, language)})` : "";
  return `${icon} ${alert.count} ${label}${amount}`;
}

/** Telegram message (HTML parse mode). */
export function renderTelegramReport(data: DailyReportData): string {
  const t = COPY[data.language];
  const { today: d, yesterday: y } = data;
  const lines: string[] = [];
  lines.push(`<b>📊 ${escapeHtml(t.title)} — ${escapeHtml(data.storeName)}</b>`);
  lines.push(`<i>${data.date}</i>`);
  lines.push("");
  if (!d.totalOrders) {
    lines.push(escapeHtml(t.no_orders));
  } else {
    lines.push(`🛒 ${t.orders}: <b>${d.totalOrders}</b> ${delta(d.totalOrders, y.totalOrders)}`);
    lines.push(`✅ ${t.confirmed}: <b>${d.confirmedOrders}</b> (${pct(d.confirmationRate)})`);
    lines.push(`📦 ${t.delivered}: <b>${d.deliveredOrders}</b> · ${t.returned}: ${d.returnedOrders} · ${t.cancelled}: ${d.cancelledOrders}`);
    lines.push(`💰 ${t.revenue_delivered}: <b>${money(d.revenueDelivered, data.language)}</b> ${delta(d.revenueDelivered, y.revenueDelivered)}`);
    lines.push(`⏳ ${t.revenue_pending}: ${money(d.revenuePending, data.language)}`);
    lines.push(`📈 ${t.delivery_rate}: ${pct(d.deliveryRate)} · ${t.return_rate}: ${pct(d.returnRate)} · ${t.aov}: ${money(d.avgOrderValue, data.language)}`);
  }
  if (data.topProducts.length) {
    lines.push("");
    lines.push(`<b>🏆 ${escapeHtml(t.top_products)}</b>`);
    for (const product of data.topProducts) {
      lines.push(`• ${escapeHtml(product.name)} — ${product.orders} ${t.orders.toLowerCase()} · ${money(product.revenueDelivered, data.language)}`);
    }
  }
  if (data.topWilayas.length) {
    lines.push("");
    lines.push(`<b>🗺 ${escapeHtml(t.top_wilayas)}</b>`);
    for (const wilaya of data.topWilayas) {
      lines.push(`• ${escapeHtml(wilaya.name)} — ${wilaya.orders} · ${t.delivery_rate} ${pct(wilaya.deliveryRate)}`);
    }
  }
  lines.push("");
  lines.push(`<b>⚠️ ${escapeHtml(t.alerts)}</b>`);
  if (!data.alerts.length) lines.push(escapeHtml(t.no_alerts));
  for (const alert of data.alerts.slice(0, 8)) lines.push(escapeHtml(alertLine(alert, data.language)));
  lines.push("");
  lines.push(`<i>${escapeHtml(t.footer)}</i>`);
  return lines.join("\n");
}

export function renderEmailReport(data: DailyReportData): { subject: string; html: string; text: string } {
  const t = COPY[data.language];
  const dir = data.language === "ar" ? "rtl" : "ltr";
  const { today: d, yesterday: y } = data;
  const row = (label: string, value: string, extra = "") =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555">${escapeHtml(label)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:700">${value}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#888">${extra}</td></tr>`;
  const rows = d.totalOrders
    ? [
        row(t.orders, String(d.totalOrders), `${t.vs_yesterday}: ${delta(d.totalOrders, y.totalOrders)}`),
        row(t.confirmed, String(d.confirmedOrders), pct(d.confirmationRate)),
        row(t.delivered, String(d.deliveredOrders), pct(d.deliveryRate)),
        row(t.returned, String(d.returnedOrders), pct(d.returnRate)),
        row(t.cancelled, String(d.cancelledOrders), ""),
        row(t.revenue_delivered, money(d.revenueDelivered, data.language), `${t.vs_yesterday}: ${delta(d.revenueDelivered, y.revenueDelivered)}`),
        row(t.revenue_pending, money(d.revenuePending, data.language), ""),
        row(t.aov, money(d.avgOrderValue, data.language), ""),
      ].join("")
    : `<tr><td colspan="3" style="padding:12px;color:#777">${escapeHtml(t.no_orders)}</td></tr>`;
  const list = (items: string[]) =>
    items.length ? `<ul style="margin:6px 0 0;padding-inline-start:18px">${items.map((item) => `<li>${item}</li>`).join("")}</ul>` : "";
  const html = `<!doctype html><html dir="${dir}"><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7fb;margin:0;padding:24px;color:#17202a">
<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
<div style="background:#6d28d9;color:#fff;padding:18px 22px"><div style="font-size:12px;opacity:.85">${escapeHtml(data.storeName)}</div><div style="font-size:20px;font-weight:800">📊 ${escapeHtml(t.title)} — ${data.date}</div></div>
<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
<div style="padding:16px 22px">
${data.topProducts.length ? `<h3 style="margin:0 0 4px;font-size:14px">🏆 ${escapeHtml(t.top_products)}</h3>${list(data.topProducts.map((p) => `${escapeHtml(p.name)} — ${p.orders} · ${money(p.revenueDelivered, data.language)}`))}` : ""}
${data.topWilayas.length ? `<h3 style="margin:14px 0 4px;font-size:14px">🗺 ${escapeHtml(t.top_wilayas)}</h3>${list(data.topWilayas.map((w) => `${escapeHtml(w.name)} — ${w.orders} · ${t.delivery_rate} ${pct(w.deliveryRate)}`))}` : ""}
<h3 style="margin:14px 0 4px;font-size:14px">⚠️ ${escapeHtml(t.alerts)}</h3>
${data.alerts.length ? list(data.alerts.slice(0, 10).map((a) => escapeHtml(alertLine(a, data.language)))) : `<p style="margin:0;color:#777">${escapeHtml(t.no_alerts)}</p>`}
</div>
<div style="padding:12px 22px;border-top:1px solid #eee;font-size:12px;color:#888">${escapeHtml(t.footer)}</div>
</div></body></html>`;
  const text = renderTelegramReport(data).replace(/<[^>]+>/g, "");
  return { subject: `${t.title} — ${data.storeName} — ${data.date}`, html, text };
}

// ─── Delivery ─────────────────────────────────────────────────────────────────

export interface ReportSendOutcome {
  telegram: "sent" | "skipped" | "not_configured" | "failed";
  email: { sent: number; failed: number; skipped: boolean; notConfigured: boolean };
  errors: string[];
}

async function sendTelegram(env: Env, text: string): Promise<"sent" | "not_configured" | "failed"> {
  const config = await resolveTelegramConfig(env);
  if (!config) return "not_configured";
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const result = (await response.json()) as { ok: boolean; description?: string };
    if (!response.ok || !result.ok) throw new Error(result.description ?? "Telegram request failed");
    return "sent";
  } catch {
    return "failed";
  }
}

export async function sendDailyReport(
  env: Env,
  config: ReportConfig,
  now = new Date(),
): Promise<ReportSendOutcome & { data: DailyReportData }> {
  const db = getDb(env.DB);
  const data = await buildDailyReport(db, now, config.timezone);
  const outcome: ReportSendOutcome = {
    telegram: "skipped",
    email: { sent: 0, failed: 0, skipped: !config.emailEnabled, notConfigured: false },
    errors: [],
  };

  if (config.telegramEnabled) {
    outcome.telegram = await sendTelegram(env, renderTelegramReport(data));
    if (outcome.telegram === "failed") outcome.errors.push("telegram_failed");
  }

  if (config.emailEnabled && config.emailRecipients.length) {
    const email = renderEmailReport(data);
    for (const recipient of config.emailRecipients) {
      const result = await sendTransactionalEmail(db, {
        to: recipient,
        subject: email.subject,
        html: email.html,
        text: email.text,
        idempotencyKey: `daily-report-${data.date}-${recipient}`,
      });
      if (result.sent) outcome.email.sent += 1;
      else {
        outcome.email.failed += 1;
        if (result.error === null) outcome.email.notConfigured = true;
        else outcome.errors.push(`email_${result.error}`);
      }
    }
  }

  return { ...outcome, data };
}

/**
 * Hourly cron entry point: sends the report once per local day when the
 * configured hour is reached.
 */
export async function sendDailyReportIfDue(env: Env, now = new Date()): Promise<boolean> {
  const db = getDb(env.DB);
  const config = await getReportConfig(db);
  if (!config.enabled) return false;
  const clock = localClock(now, config.timezone);
  if (clock.hour < config.sendHour) return false;
  if (config.lastSentOn === clock.date) return false;
  if (!config.telegramEnabled && !config.emailEnabled) {
    // Nothing to deliver — record the day so the hourly cron stops re-checking.
    await markReportSent(db, clock.date);
    return false;
  }
  const outcome = await sendDailyReport(env, config, now);
  const delivered = outcome.telegram === "sent" || outcome.email.sent > 0;
  if (delivered || outcome.telegram === "not_configured" || outcome.email.notConfigured) {
    await markReportSent(db, clock.date);
  }
  return delivered;
}
