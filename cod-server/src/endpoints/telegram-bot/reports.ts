/**
 * Report builder for the bot.
 *
 * Reuses the dashboard analytics queries (same numbers as the UI) and renders
 * compact Telegram HTML. Period reports compare against the previous equal
 * window; the daily report can also be pushed by cron.
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  orders,
  orderConfirmationAssignments,
  users,
  staffCommissions,
  drivers,
  products,
  customers,
  supportConversations,
  operationTasks,
  adminApprovalRequests,
} from "@/db/schema";
import {
  getAnalyticsOverview,
  getDashboardAlerts,
  getProductAnalytics,
  getProfitAndLoss,
  getReportConfig,
  getWilayaAnalytics,
  type DashboardAlert,
} from "../../../../cod-shared/queries/analytics";
import { getStore } from "../../../../cod-shared/queries/stores";
import { localClock } from "@/lib/daily-report";
import { botText, type BotLanguage } from "./i18n";
import { delta, escapeHtml, money, pct } from "./render";

export type ReportPeriod = "today" | "yesterday" | "week" | "month";

export interface ReportRange {
  from: string;
  to: string;
  label: string;
  /** YYYY-MM-DD used for the dedupe marker of scheduled reports. */
  localDay: string;
  tzOffsetMinutes: number;
}

export async function periodRange(db: AppDb, period: ReportPeriod, now = new Date()): Promise<ReportRange> {
  const config = await getReportConfig(db);
  const clock = localClock(now, config.timezone);
  const nowIso = now.toISOString();
  const day = 86_400_000;
  const startOfDay = clock.startOfDayIso;
  switch (period) {
    case "today":
      return { from: startOfDay, to: nowIso, label: "today", localDay: clock.date, tzOffsetMinutes: clock.offsetMinutes };
    case "yesterday": {
      const from = new Date(new Date(startOfDay).getTime() - day).toISOString();
      return { from, to: startOfDay, label: "yesterday", localDay: clock.date, tzOffsetMinutes: clock.offsetMinutes };
    }
    case "week":
      return {
        from: new Date(now.getTime() - 7 * day).toISOString(),
        to: nowIso,
        label: "week",
        localDay: clock.date,
        tzOffsetMinutes: clock.offsetMinutes,
      };
    case "month":
    default:
      return {
        from: new Date(now.getTime() - 30 * day).toISOString(),
        to: nowIso,
        label: "month",
        localDay: clock.date,
        tzOffsetMinutes: clock.offsetMinutes,
      };
  }
}

function periodLabel(language: BotLanguage, range: ReportRange): string {
  if (range.label === "today") return botText(language, "report_period_today");
  if (range.label === "yesterday") return botText(language, "report_period_yesterday");
  if (range.label === "week") return botText(language, "report_period_week");
  return botText(language, "report_period_month");
}

export function alertLine(language: BotLanguage, alert: DashboardAlert): string {
  const icon = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟠" : "🔵";
  const amount = alert.amount != null ? ` (${money(language, alert.amount)})` : "";
  return `${icon} ${alert.count} ${alertLabel(language, alert.id)}${amount}`;
}

function alertLabel(language: BotLanguage, id: string): string {
  const labels: Record<BotLanguage, Record<string, string>> = {
    ar: {
      unconfirmed_orders: "طلبات بلا تأكيد +24 ساعة",
      unreachable_orders: "طلبات لا يمكن الوصول لأصحابها",
      stuck_out_for_delivery: "شحنات عالقة في الطريق +5 أيام",
      stuck_dispatched: "شحنات بلا تحديث من الناقل +7 أيام",
      confirmed_not_shipped: "طلبات مؤكدة لم تُشحن منذ 48 ساعة",
      low_stock: "منتجات منخفضة/نافدة",
      stock_runway: "منتجات ستنفد خلال أسبوع",
      driver_cash: "كاش عند السائقين",
      webhook_errors: "أخطاء webhook خلال 24 ساعة",
      overdue_tasks: "مهام متأخرة",
      pending_approvals: "موافقات معلّقة",
      overdue_tickets: "تذاكر دعم متأخرة",
      unread_support: "رسائل دعم غير مقروءة",
      abandoned_24h: "سلات متروكة خلال 24 ساعة",
    },
    fr: {
      unconfirmed_orders: "commandes non confirmées +24 h",
      unreachable_orders: "commandes injoignables",
      stuck_out_for_delivery: "colis bloqués en livraison +5 j",
      stuck_dispatched: "colis sans mise à jour +7 j",
      confirmed_not_shipped: "confirmées non expédiées 48 h",
      low_stock: "produits en stock bas",
      stock_runway: "rupture sous une semaine",
      driver_cash: "cash livreurs",
      webhook_errors: "erreurs webhook 24 h",
      overdue_tasks: "tâches en retard",
      pending_approvals: "approbations en attente",
      overdue_tickets: "tickets support en retard",
      unread_support: "messages support non lus",
      abandoned_24h: "paniers abandonnés 24 h",
    },
    en: {
      unconfirmed_orders: "orders unconfirmed 24h+",
      unreachable_orders: "unreachable orders",
      stuck_out_for_delivery: "shipments stuck out for delivery 5d+",
      stuck_dispatched: "shipments without carrier update 7d+",
      confirmed_not_shipped: "confirmed not shipped in 48h",
      low_stock: "low / out-of-stock products",
      stock_runway: "stock runs out within a week",
      driver_cash: "driver cash",
      webhook_errors: "webhook errors 24h",
      overdue_tasks: "overdue tasks",
      pending_approvals: "pending approvals",
      overdue_tickets: "overdue support tickets",
      unread_support: "unread support messages",
      abandoned_24h: "abandoned carts 24h",
    },
  };
  return labels[language][id] ?? labels.en[id] ?? id;
}

export async function buildPeriodReport(
  db: AppDb,
  period: ReportPeriod,
  language: BotLanguage,
  now = new Date(),
): Promise<string> {
  const range = await periodRange(db, period, now);
  const store = await getStore(db);
  const [overview, products, wilayas, alerts] = await Promise.all([
    getAnalyticsOverview(db, { from: range.from, to: range.to }),
    getProductAnalytics(db, { from: range.from, to: range.to }, 3),
    getWilayaAnalytics(db, { from: range.from, to: range.to }),
    getDashboardAlerts(db, now),
  ]);
  const current = overview.current;
  const previous = overview.previous;
  const lines: string[] = [];
  lines.push(`<b>📊 ${botText(language, "report_title", { period: periodLabel(language, range), store: escapeHtml(store?.name ?? "CodFlow") })}</b>`);
  lines.push("");
  if (!current.totalOrders) {
    lines.push(botText(language, "no_data"));
  } else {
    lines.push(`🛒 ${botText(language, "orders")}: <b>${current.totalOrders}</b> ${delta(current.totalOrders, previous.totalOrders)}`);
    lines.push(
      `✅ ${botText(language, "confirmed")}: <b>${current.confirmedOrders}</b> (${pct(current.confirmationRate)}) · ⏳ ${botText(language, "pending_confirmation")}: ${current.pendingConfirmation}`,
    );
    lines.push(
      `📦 ${botText(language, "delivered")}: <b>${current.deliveredOrders}</b> · ↩️ ${botText(language, "returned")}: ${current.returnedOrders} · ⛔ ${botText(language, "cancelled")}: ${current.cancelledOrders}`,
    );
    lines.push(`🚚 ${botText(language, "in_transit")}: ${current.inTransit}`);
    lines.push("");
    lines.push(`💰 ${botText(language, "revenue_delivered")}: <b>${money(language, current.revenueDelivered)}</b> ${delta(current.revenueDelivered, previous.revenueDelivered)}`);
    lines.push(`⏳ ${botText(language, "revenue_pending")}: ${money(language, current.revenuePending)}`);
    lines.push(`💔 ${botText(language, "revenue_lost")}: ${money(language, current.revenueLostReturns)}`);
    lines.push(
      `📈 ${botText(language, "delivery_rate")}: ${pct(current.deliveryRate)} · ${botText(language, "return_rate")}: ${pct(current.returnRate)} · ${botText(language, "aov")}: ${money(language, current.avgOrderValue)}`,
    );
  }
  if (products.length) {
    lines.push("");
    lines.push(`<b>🏆 ${botText(language, "top_products")}</b>`);
    for (const product of products) {
      lines.push(
        `• ${escapeHtml(product.name)} — ${product.orders} · ${money(language, product.revenueDelivered)}`,
      );
    }
  }
  const bestWilayas = wilayas.filter((row) => row.wilayaId != null).slice(0, 3);
  if (bestWilayas.length) {
    lines.push("");
    lines.push(`<b>🗺 ${botText(language, "top_wilayas")}</b>`);
    for (const wilaya of bestWilayas) {
      const name = (language === "ar" ? wilaya.nameAr : wilaya.name) ?? String(wilaya.wilayaId);
      lines.push(`• ${escapeHtml(name)} — ${wilaya.orders} · ${pct(wilaya.deliveryRate)}`);
    }
  }
  lines.push("");
  lines.push(`<b>⚠️ ${botText(language, "alerts")}</b>`);
  if (!alerts.length) lines.push(botText(language, "no_alerts"));
  for (const alert of alerts.slice(0, 6)) lines.push(alertLine(language, alert));
  return lines.join("\n");
}

export async function buildOpsReport(db: AppDb, language: BotLanguage, now = new Date()): Promise<string> {
  const alerts = await getDashboardAlerts(db, now);
  const [taskRow, supportRow, approvalRow] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(operationTasks)
      .where(sql`${operationTasks.status} IN ('open','in_progress') AND ${operationTasks.dueAt} IS NOT NULL AND ${operationTasks.dueAt} < ${now.toISOString()}`)
      .get(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(supportConversations)
      .where(sql`${supportConversations.unreadCount} > 0 AND ${supportConversations.status} IN ('open','pending')`)
      .get(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(adminApprovalRequests)
      .where(and(eq(adminApprovalRequests.status, "pending"), gte(adminApprovalRequests.expiresAt, now.toISOString())))
      .get(),
  ]);
  const lines = [`<b>🛠 ${botText(language, "report_ops_title")}</b>`, ""];
  lines.push(`⏰ ${botText(language, "overdue_tasks")}: <b>${Number(taskRow?.count ?? 0)}</b>`);
  lines.push(`💬 ${botText(language, "unread_support")}: <b>${Number(supportRow?.count ?? 0)}</b>`);
  lines.push(`🔐 ${botText(language, "pending_approvals")}: <b>${Number(approvalRow?.count ?? 0)}</b>`);
  lines.push("");
  lines.push(`<b>⚠️ ${botText(language, "alerts")}</b>`);
  if (!alerts.length) lines.push(botText(language, "no_alerts"));
  for (const alert of alerts.slice(0, 8)) {
    lines.push(alertLine(language, alert));
    for (const item of (alert.items ?? []).slice(0, 3)) {
      lines.push(`   • ${escapeHtml(item.label)}${item.extra ? ` — ${escapeHtml(item.extra)}` : ""}`);
    }
  }
  return lines.join("\n");
}

export async function buildStockReport(db: AppDb, language: BotLanguage): Promise<string> {
  const lowStock = await db
    .select({
      name: products.name,
      inventory: products.inventory,
      threshold: products.lowStockThreshold,
    })
    .from(products)
    .where(sql`${products.trackInventory} = 1 AND ${products.inventory} <= ${products.lowStockThreshold}`)
    .orderBy(products.inventory)
    .limit(12)
    .all();
  const lines = [`<b>📦 ${botText(language, "report_stock_title")}</b>`, ""];
  if (!lowStock.length) {
    lines.push(botText(language, "no_alerts"));
    return lines.join("\n");
  }
  for (const product of lowStock) {
    const state = product.inventory <= 0 ? `⛔ ${botText(language, "stock_out")}` : `🟠 ${botText(language, "stock_low")}`;
    lines.push(`• ${escapeHtml(product.name)} — ${product.inventory}/${product.threshold} ${state}`);
  }
  return lines.join("\n");
}

export async function buildFinanceReport(
  db: AppDb,
  language: BotLanguage,
  now = new Date(),
): Promise<string> {
  const range = await periodRange(db, "month", now);
  const [profit, driverRow, commissionRows] = await Promise.all([
    getProfitAndLoss(db, { from: range.from, to: range.to }, range.tzOffsetMinutes),
    db
      .select({ total: sql<number>`COALESCE(SUM(${drivers.pendingCash}), 0)` })
      .from(drivers)
      .get(),
    db
      .select({
        status: staffCommissions.status,
        total: sql<number>`COALESCE(SUM(${staffCommissions.amount}), 0)`,
      })
      .from(staffCommissions)
      .groupBy(staffCommissions.status)
      .all(),
  ]);
  const commissions = Object.fromEntries(
    commissionRows.map((row) => [row.status, Number(row.total ?? 0)]),
  ) as Record<string, number>;
  const lines = [`<b>💰 ${botText(language, "report_finance_title")}</b>`, `<i>${botText(language, "report_period_month")}</i>`, ""];
  lines.push(`💵 ${botText(language, "revenue_delivered")}: <b>${money(language, profit.revenueDelivered)}</b>`);
  lines.push(`💔 ${botText(language, "revenue_lost")}: ${money(language, profit.revenueLostReturns)}`);
  lines.push(`🏷 ${botText(language, "finance_driver_cash")}: <b>${money(language, Number(driverRow?.total ?? 0))}</b>`);
  lines.push(`📈 ${botText(language, "finance_commissions_earned")}: ${money(language, (commissions.earned ?? 0) + (commissions.paid ?? 0))}`);
  lines.push(`✅ ${botText(language, "finance_commissions_paid")}: ${money(language, commissions.paid ?? 0)}`);
  lines.push(`🧾 ${botText(language, "finance_expenses")}: ${money(language, profit.totalExpenses)}`);
  lines.push("");
  lines.push(`📊 ${botText(language, "finance_net")}: <b>${money(language, profit.netProfit)}</b>${profit.netMargin != null ? ` (${pct(profit.netMargin)})` : ""}`);
  if (profit.productsWithoutCostPrice > 0) {
    lines.push("");
    lines.push(`⚠️ ${profit.productsWithoutCostPrice} products without cost price — profit is underestimated.`);
  }
  return lines.join("\n");
}

export async function buildTeamReport(
  db: AppDb,
  language: BotLanguage,
  now = new Date(),
): Promise<string> {
  const range = await periodRange(db, "week", now);
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      assigned: sql<number>`COUNT(DISTINCT ${orderConfirmationAssignments.orderId})`,
      confirmed: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'confirmed' OR ${orders.status} IN ('preparing','ready','assigned','dispatched','out_for_delivery','delivered','returned') THEN 1 ELSE 0 END), 0)`,
      delivered: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'delivered' THEN 1 ELSE 0 END), 0)`,
      returned: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'returned' THEN 1 ELSE 0 END), 0)`,
    })
    .from(orderConfirmationAssignments)
    .innerJoin(orders, eq(orders.id, orderConfirmationAssignments.orderId))
    .innerJoin(users, eq(users.id, orderConfirmationAssignments.assigneeId))
    .where(and(gte(orders.createdAt, range.from), lt(orders.createdAt, range.to)))
    .groupBy(users.id, users.name, users.role)
    .all();

  const lines = [`<b>🏅 ${botText(language, "report_team_title")}</b>`, `<i>${botText(language, "report_period_week")}</i>`, ""];
  if (!rows.length) {
    lines.push(botText(language, "no_data"));
    return lines.join("\n");
  }
  const ranked = rows
    .map((row) => ({
      ...row,
      rate: Number(row.assigned) ? Math.round((Number(row.delivered) / Number(row.assigned)) * 1000) / 10 : null,
    }))
    .sort((a, b) => Number(b.delivered) - Number(a.delivered));
  for (const row of ranked.slice(0, 10)) {
    lines.push(
      botText(language, "team_row", {
        name: escapeHtml(row.name),
        confirmed: Number(row.confirmed),
        delivered: Number(row.delivered),
        rate: pct(row.rate),
      }),
    );
  }
  return lines.join("\n");
}

export async function buildCustomersReport(
  db: AppDb,
  language: BotLanguage,
  now = new Date(),
): Promise<string> {
  const range = await periodRange(db, "month", now);
  const [totalRow, newRow, repeatRow, vipRow] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(customers).get(),
    db.select({ count: sql<number>`count(*)` }).from(customers).where(gte(customers.createdAt, range.from)).get(),
    db.select({ count: sql<number>`count(*)` }).from(customers).where(gte(customers.totalOrders, 2)).get(),
    db.select({ count: sql<number>`count(*)` }).from(customers).where(gte(customers.totalOrders, 3)).get(),
  ]);
  return [
    `<b>👥 ${botText(language, "report_customers_title")}</b>`,
    "",
    `${botText(language, "customers_total")}: <b>${Number(totalRow?.count ?? 0)}</b>`,
    `✨ ${botText(language, "customers_new")}: <b>${Number(newRow?.count ?? 0)}</b>`,
    `🔁 ${botText(language, "customers_repeat")}: <b>${Number(repeatRow?.count ?? 0)}</b>`,
    `⭐ ${botText(language, "customers_vip")}: <b>${Number(vipRow?.count ?? 0)}</b>`,
  ].join("\n");
}
