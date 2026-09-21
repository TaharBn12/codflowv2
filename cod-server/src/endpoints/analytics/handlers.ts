/**
 * Analytics Handlers
 *
 * HTTP handlers for the /api/analytics/* routes.
 */

import type { Context } from "hono";
import { z } from "zod";
import type { AppContext } from "@/types";
import { getDb } from "@/db";
import { EXPENSE_CATEGORIES, AD_PLATFORMS } from "@/db/schema";
import { NotFoundError, ValidationError } from "@/lib/errors/classes";
import { ACTIONS, logActivity } from "@/lib/activity";
import { sendDailyReport } from "@/lib/daily-report";
import {
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
  localDate,
  saveDashboardLayout,
  saveReportConfig,
  updateExpense,
  type AnalyticsRange,
  type Granularity,
} from "../../../../cod-shared/queries/analytics";
import { resolveTelegramConfig } from "@/endpoints/telegram-approvals/service";
import { getEmailConfig } from "../../../../cod-shared/queries/email-config";
import { getStore } from "../../../../cod-shared/queries/stores";

// ─── Query parsing ────────────────────────────────────────────────────────────

const isoDate = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), "Invalid date");

export const rangeQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  tz: z.coerce.number().int().min(-840).max(840).optional(),
});

export const timeseriesQuerySchema = rangeQuerySchema.extend({
  granularity: z.enum(["day", "week", "month"]).optional(),
});

export const productsQuerySchema = rangeQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const carriersQuerySchema = rangeQuerySchema.extend({
  wilayaId: z.coerce.number().int().min(1).max(58).optional(),
});

export const roasQuerySchema = rangeQuerySchema.extend({
  landingPageId: z.string().optional(),
});

export const todayQuerySchema = z.object({
  from: isoDate.optional(),
});

export const expensesQuerySchema = rangeQuerySchema.extend({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  landingPageId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const expenseBodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  category: z.enum(EXPENSE_CATEGORIES),
  platform: z.enum(AD_PLATFORMS).nullable().optional(),
  amount: z.number().min(0).max(1_000_000_000),
  landingPageId: z.string().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export const expenseUpdateSchema = expenseBodySchema.partial();

export const exportQuerySchema = rangeQuerySchema.extend({
  report: z.enum(["overview", "timeseries", "wilayas", "products", "carriers", "pnl", "expenses", "roas"]),
  granularity: z.enum(["day", "week", "month"]).optional(),
  lang: z.enum(["ar", "en", "fr"]).optional(),
  delimiter: z.enum(["comma", "semicolon"]).optional(),
});

export const layoutBodySchema = z.object({
  version: z.number().int().min(1).max(100),
  widgets: z
    .array(z.object({ id: z.string().min(1).max(64), hidden: z.boolean() }))
    .max(50),
});

export const reportConfigBodySchema = z.object({
  enabled: z.boolean(),
  sendHour: z.number().int().min(0).max(23),
  timezone: z.string().min(1).max(64),
  telegramEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  emailRecipients: z.array(z.string().email()).max(20),
});

const MAX_RANGE_DAYS = 400;

function parseQuery<T extends z.ZodTypeAny>(c: Context<AppContext>, schema: T): z.infer<T> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw new ValidationError(`Invalid query parameters: ${result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

function resolveRange(query: { from?: string; to?: string; tz?: number }): { range: AnalyticsRange; tz: number } {
  const tz = query.tz ?? 0;
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 24 * 3_600_000);
  if (from.getTime() >= to.getTime()) {
    throw new ValidationError("`from` must be before `to`");
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 3_600_000) {
    throw new ValidationError(`Range cannot exceed ${MAX_RANGE_DAYS} days`);
  }
  return { range: { from: from.toISOString(), to: to.toISOString() }, tz };
}

function confirmerScope(c: Context<AppContext>) {
  const actor = c.get("user");
  return actor.role === "confirmer" ? actor.id : undefined;
}

async function parseBody<T extends z.ZodTypeAny>(c: Context<AppContext>, schema: T): Promise<z.infer<T>> {
  const valid = (c.req as any).valid?.("json");
  if (valid) return valid;
  const result = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!result.success) throw new ValidationError(`Invalid request body: ${result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  return result.data;
}

// ─── Legacy status cards ──────────────────────────────────────────────────────

/**
 * GET /api/analytics/dashboard-stats
 * Returns order counts grouped by status in a single optimized query.
 */
export async function getDashboardStats(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const data =
    actor.role === "confirmer"
      ? await getOrderStatusStats(db, actor.id)
      : await getOrderStatusStats(db);
  return c.json({ success: true, data }, 200);
}

// ─── KPI overview ─────────────────────────────────────────────────────────────

export async function getOverview(c: Context<AppContext>) {
  const { range } = resolveRange(parseQuery(c, rangeQuerySchema));
  const data = await getAnalyticsOverview(getDb(c.env.DB), range, confirmerScope(c));
  return c.json({ success: true, data }, 200);
}

export async function getTimeseries(c: Context<AppContext>) {
  const query = parseQuery(c, timeseriesQuerySchema);
  const { range, tz } = resolveRange(query);
  const granularity: Granularity = query.granularity ?? "day";
  const data = await getAnalyticsTimeseries(getDb(c.env.DB), range, granularity, tz, confirmerScope(c));
  return c.json({ success: true, data, granularity, range }, 200);
}

export async function getWilayas(c: Context<AppContext>) {
  const { range } = resolveRange(parseQuery(c, rangeQuerySchema));
  const data = await getWilayaAnalytics(getDb(c.env.DB), range, confirmerScope(c));
  return c.json({ success: true, data }, 200);
}

export async function getProducts(c: Context<AppContext>) {
  const query = parseQuery(c, productsQuerySchema);
  const { range } = resolveRange(query);
  const data = await getProductAnalytics(getDb(c.env.DB), range, query.limit ?? 100, confirmerScope(c));
  return c.json({ success: true, data }, 200);
}

export async function getCarriers(c: Context<AppContext>) {
  const query = parseQuery(c, carriersQuerySchema);
  const { range } = resolveRange(query);
  const data = await getCarrierAnalytics(getDb(c.env.DB), range, query.wilayaId);
  return c.json({ success: true, data }, 200);
}

export async function getAlerts(c: Context<AppContext>) {
  const data = await getDashboardAlerts(getDb(c.env.DB), new Date(), confirmerScope(c));
  return c.json({ success: true, data }, 200);
}

export async function getToday(c: Context<AppContext>) {
  const query = parseQuery(c, todayQuerySchema);
  const now = new Date();
  const start = query.from ? new Date(query.from) : new Date(now.getTime() - 24 * 3_600_000);
  if (start.getTime() > now.getTime()) throw new ValidationError("`from` cannot be in the future");
  const actor = c.get("user");
  const data = await getTodayBoard(getDb(c.env.DB), start.toISOString(), { id: actor.id, role: actor.role }, now);
  return c.json({ success: true, data }, 200);
}

// ─── Finance ──────────────────────────────────────────────────────────────────

export async function getPnl(c: Context<AppContext>) {
  const { range, tz } = resolveRange(parseQuery(c, rangeQuerySchema));
  const data = await getProfitAndLoss(getDb(c.env.DB), range, tz);
  return c.json({ success: true, data }, 200);
}

export async function getRoasReport(c: Context<AppContext>) {
  const query = parseQuery(c, roasQuerySchema);
  const { range, tz } = resolveRange(query);
  const data = await getRoas(getDb(c.env.DB), range, tz, query.landingPageId);
  return c.json({ success: true, data }, 200);
}

export async function listExpensesHandler(c: Context<AppContext>) {
  const query = parseQuery(c, expensesQuerySchema);
  const { range, tz } = resolveRange(query);
  const data = await listExpenses(getDb(c.env.DB), {
    fromDate: localDate(range.from, tz),
    toDate: localDate(new Date(new Date(range.to).getTime() - 1).toISOString(), tz),
    category: query.category,
    landingPageId: query.landingPageId,
    limit: query.limit,
  });
  return c.json({ success: true, data, count: data.length }, 200);
}

export async function createExpenseHandler(c: Context<AppContext>) {
  const body = await parseBody(c, expenseBodySchema);
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const id = await createExpense(db, body, actor.id);
  await logActivity(db, actor, ACTIONS.EXPENSE_CREATED, { type: "expense", id, label: `${body.category} ${body.amount}` }, body);
  const record = await getExpense(db, id);
  return c.json({ success: true, data: record }, 201);
}

export async function updateExpenseHandler(c: Context<AppContext>) {
  const id = c.req.param("id")!;
  const db = getDb(c.env.DB);
  const existing = await getExpense(db, id);
  if (!existing) throw new NotFoundError("Expense", id);
  const body = await parseBody(c, expenseUpdateSchema);
  await updateExpense(db, id, body);
  await logActivity(db, c.get("user"), ACTIONS.EXPENSE_UPDATED, { type: "expense", id, label: existing.category }, body);
  const record = await getExpense(db, id);
  return c.json({ success: true, data: record }, 200);
}

export async function deleteExpenseHandler(c: Context<AppContext>) {
  const id = c.req.param("id")!;
  const db = getDb(c.env.DB);
  const existing = await getExpense(db, id);
  if (!existing) throw new NotFoundError("Expense", id);
  await deleteExpense(db, id);
  await logActivity(db, c.get("user"), ACTIONS.EXPENSE_DELETED, { type: "expense", id, label: existing.category }, { amount: existing.amount });
  return c.json({ success: true }, 200);
}

// ─── CSV export ───────────────────────────────────────────────────────────────

type Lang = "ar" | "en" | "fr";

const HEADERS: Record<string, Record<Lang, string>> = {
  metric: { ar: "المؤشر", en: "Metric", fr: "Indicateur" },
  current: { ar: "الفترة الحالية", en: "Current period", fr: "Période actuelle" },
  previous: { ar: "الفترة السابقة", en: "Previous period", fr: "Période précédente" },
  period: { ar: "الفترة", en: "Period", fr: "Période" },
  date: { ar: "التاريخ", en: "Date", fr: "Date" },
  orders: { ar: "الطلبات", en: "Orders", fr: "Commandes" },
  confirmed: { ar: "مؤكدة", en: "Confirmed", fr: "Confirmées" },
  delivered: { ar: "مُسلَّمة", en: "Delivered", fr: "Livrées" },
  returned: { ar: "مرتجعة", en: "Returned", fr: "Retournées" },
  cancelled: { ar: "ملغاة", en: "Cancelled", fr: "Annulées" },
  in_progress: { ar: "قيد المعالجة", en: "In progress", fr: "En cours" },
  in_transit: { ar: "في الطريق", en: "In transit", fr: "En transit" },
  revenue_delivered: { ar: "الإيراد المُحصَّل", en: "Collected revenue", fr: "Revenu encaissé" },
  revenue_pending: { ar: "الإيراد المعلّق", en: "Pending revenue", fr: "Revenu en attente" },
  delivery_rate: { ar: "نسبة التسليم %", en: "Delivery rate %", fr: "Taux de livraison %" },
  return_rate: { ar: "نسبة الإرجاع %", en: "Return rate %", fr: "Taux de retour %" },
  confirmation_rate: { ar: "نسبة التأكيد %", en: "Confirmation rate %", fr: "Taux de confirmation %" },
  wilaya: { ar: "الولاية", en: "Wilaya", fr: "Wilaya" },
  product: { ar: "المنتج", en: "Product", fr: "Produit" },
  units_delivered: { ar: "وحدات مُسلَّمة", en: "Units delivered", fr: "Unités livrées" },
  units_returned: { ar: "وحدات مرتجعة", en: "Units returned", fr: "Unités retournées" },
  cogs: { ar: "تكلفة البضاعة", en: "COGS", fr: "Coût des marchandises" },
  gross_profit: { ar: "الربح الإجمالي", en: "Gross profit", fr: "Marge brute" },
  carrier: { ar: "الناقل", en: "Carrier", fr: "Transporteur" },
  avg_delivery_days: { ar: "متوسط أيام التسليم", en: "Avg delivery days", fr: "Délai moyen (jours)" },
  amount: { ar: "المبلغ", en: "Amount", fr: "Montant" },
  category: { ar: "الفئة", en: "Category", fr: "Catégorie" },
  platform: { ar: "المنصة", en: "Platform", fr: "Plateforme" },
  landing_page: { ar: "صفحة الهبوط", en: "Landing page", fr: "Page de destination" },
  note: { ar: "ملاحظة", en: "Note", fr: "Note" },
  spend: { ar: "مصروف الإعلانات", en: "Ad spend", fr: "Dépenses pub" },
  roas: { ar: "ROAS", en: "ROAS", fr: "ROAS" },
  cost_per_delivered: { ar: "تكلفة الطلب المُسلَّم", en: "Cost per delivered order", fr: "Coût par commande livrée" },
  total_orders: { ar: "إجمالي الطلبات", en: "Total orders", fr: "Total commandes" },
  avg_order_value: { ar: "متوسط السلة", en: "Average order value", fr: "Panier moyen" },
  delivery_fees: { ar: "رسوم التوصيل المُحصَّلة", en: "Delivery fees collected", fr: "Frais de livraison encaissés" },
  driver_fees: { ar: "أجور السائقين", en: "Driver fees", fr: "Frais livreurs" },
  commissions: { ar: "عمولات الفريق", en: "Staff commissions", fr: "Commissions équipe" },
  expenses_ads: { ar: "مصاريف الإعلانات", en: "Ad spend", fr: "Dépenses pub" },
  expenses_carrier: { ar: "فواتير شركات التوصيل", en: "Carrier invoices", fr: "Factures transporteurs" },
  expenses_packaging: { ar: "التغليف", en: "Packaging", fr: "Emballage" },
  expenses_salaries: { ar: "الرواتب", en: "Salaries", fr: "Salaires" },
  expenses_rent: { ar: "الإيجار", en: "Rent", fr: "Loyer" },
  expenses_other: { ar: "مصاريف أخرى", en: "Other expenses", fr: "Autres dépenses" },
  net_profit: { ar: "صافي الربح", en: "Net profit", fr: "Bénéfice net" },
  net_margin: { ar: "هامش صافي %", en: "Net margin %", fr: "Marge nette %" },
  revenue_lost_returns: { ar: "إيراد ضائع (إرجاعات)", en: "Revenue lost to returns", fr: "Revenu perdu (retours)" },
};

function h(key: string, lang: Lang) {
  return HEADERS[key]?.[lang] ?? key;
}

function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(headers: string[], rows: unknown[][], delimiter: string): string {
  const lines = [headers.map(csvCell).join(delimiter), ...rows.map((row) => row.map(csvCell).join(delimiter))];
  return `\uFEFF${lines.join("\r\n")}`;
}

export async function exportReport(c: Context<AppContext>) {
  const query = parseQuery(c, exportQuerySchema);
  const { range, tz } = resolveRange(query);
  const lang: Lang = query.lang ?? "en";
  const delimiter = query.delimiter === "semicolon" ? ";" : ",";
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const scope = actor.role === "confirmer" ? actor.id : undefined;
  const financeReports = new Set(["pnl", "expenses", "roas"]);
  if (financeReports.has(query.report) && actor.role !== "admin" && !actor.scopes.includes("analytics:finance") && !actor.scopes.includes("*")) {
    return c.json({ success: false, error: "Insufficient permissions", required: "analytics:finance" }, 403);
  }

  let headers: string[] = [];
  let rows: unknown[][] = [];

  switch (query.report) {
    case "overview": {
      const data = await getAnalyticsOverview(db, range, scope);
      headers = [h("metric", lang), h("current", lang), h("previous", lang)];
      const keys: Array<[string, keyof typeof data.current]> = [
        ["total_orders", "totalOrders"],
        ["confirmed", "confirmedOrders"],
        ["delivered", "deliveredOrders"],
        ["returned", "returnedOrders"],
        ["cancelled", "cancelledOrders"],
        ["in_transit", "inTransit"],
        ["revenue_delivered", "revenueDelivered"],
        ["revenue_pending", "revenuePending"],
        ["revenue_lost_returns", "revenueLostReturns"],
        ["avg_order_value", "avgOrderValue"],
        ["confirmation_rate", "confirmationRate"],
        ["delivery_rate", "deliveryRate"],
        ["return_rate", "returnRate"],
      ];
      rows = keys.map(([label, key]) => [h(label, lang), data.current[key] ?? "", data.previous[key] ?? ""]);
      break;
    }
    case "timeseries": {
      const data = await getAnalyticsTimeseries(db, range, query.granularity ?? "day", tz, scope);
      headers = ["period", "orders", "confirmed", "delivered", "returned", "cancelled", "revenue_delivered", "revenue_pending"].map((key) => h(key, lang));
      rows = data.map((row) => [row.period, row.orders, row.confirmed, row.delivered, row.returned, row.cancelled, row.revenueDelivered, row.revenuePending]);
      break;
    }
    case "wilayas": {
      const data = await getWilayaAnalytics(db, range, scope);
      headers = ["wilaya", "orders", "delivered", "returned", "cancelled", "in_progress", "revenue_delivered", "delivery_rate", "return_rate"].map((key) => h(key, lang));
      rows = data.map((row) => [
        `${row.wilayaId ?? ""} ${(lang === "ar" ? row.nameAr : row.name) ?? ""}`.trim(),
        row.orders, row.delivered, row.returned, row.cancelled, row.inProgress, row.revenueDelivered, row.deliveryRate ?? "", row.returnRate ?? "",
      ]);
      break;
    }
    case "products": {
      const data = await getProductAnalytics(db, range, 500, scope);
      headers = ["product", "orders", "delivered", "returned", "units_delivered", "units_returned", "revenue_delivered", "cogs", "gross_profit", "delivery_rate", "return_rate"].map((key) => h(key, lang));
      rows = data.map((row) => [
        row.name, row.orders, row.deliveredOrders, row.returnedOrders, row.unitsDelivered, row.unitsReturned,
        row.revenueDelivered, row.hasCostPrice ? row.cogs : "", row.grossProfit ?? "", row.deliveryRate ?? "", row.returnRate ?? "",
      ]);
      break;
    }
    case "carriers": {
      const data = await getCarrierAnalytics(db, range);
      headers = ["carrier", "orders", "in_transit", "delivered", "returned", "revenue_delivered", "avg_delivery_days", "delivery_rate", "return_rate"].map((key) => h(key, lang));
      rows = data.map((row) => [
        row.kind === "drivers" ? (lang === "ar" ? "السائقون" : lang === "fr" ? "Livreurs" : "In-house drivers") : (lang === "ar" ? row.nameAr ?? row.name : row.name),
        row.orders, row.inTransit, row.delivered, row.returned, row.revenueDelivered, row.avgDeliveryDays ?? "", row.deliveryRate ?? "", row.returnRate ?? "",
      ]);
      break;
    }
    case "pnl": {
      const data = await getProfitAndLoss(db, range, tz);
      headers = [h("metric", lang), h("amount", lang)];
      rows = [
        ["revenue_delivered", data.revenueDelivered],
        ["delivery_fees", data.deliveryFeesCollected],
        ["cogs", -data.cogs],
        ["driver_fees", -data.driverFees],
        ["gross_profit", data.grossProfit],
        ["commissions", -data.commissions],
        ["expenses_ads", -data.expenses.ads],
        ["expenses_carrier", -data.expenses.carrier],
        ["expenses_packaging", -data.expenses.packaging],
        ["expenses_salaries", -data.expenses.salaries],
        ["expenses_rent", -data.expenses.rent],
        ["expenses_other", -data.expenses.other],
        ["net_profit", data.netProfit],
        ["net_margin", data.netMargin ?? ""],
        ["delivered", data.deliveredOrders],
        ["returned", data.returnedOrders],
        ["revenue_lost_returns", data.revenueLostReturns],
      ].map(([key, value]) => [h(String(key), lang), value]);
      break;
    }
    case "expenses": {
      const data = await listExpenses(db, {
        fromDate: localDate(range.from, tz),
        toDate: localDate(new Date(new Date(range.to).getTime() - 1).toISOString(), tz),
        limit: 1000,
      });
      headers = ["date", "category", "platform", "amount", "landing_page", "note"].map((key) => h(key, lang));
      rows = data.map((row) => [row.date, row.category, row.platform ?? "", row.amount, row.landingPageName ?? "", row.note ?? ""]);
      break;
    }
    case "roas": {
      const data = await getRoas(db, range, tz);
      headers = ["date", "spend", "orders", "delivered", "revenue_delivered", "roas", "cost_per_delivered"].map((key) => h(key, lang));
      rows = data.daily.map((row) => [
        row.date, row.spend, row.orders, row.delivered, row.revenueDelivered,
        row.spend ? Math.round((row.revenueDelivered / row.spend) * 100) / 100 : "",
        row.spend && row.delivered ? Math.round(row.spend / row.delivered) : "",
      ]);
      break;
    }
  }

  const fromDate = localDate(range.from, tz);
  const toDate = localDate(new Date(new Date(range.to).getTime() - 1).toISOString(), tz);
  const body = csv(headers, rows, delimiter);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="codflow-${query.report}-${fromDate}-${toDate}.csv"`,
      "cache-control": "no-store",
    },
  });
}

// ─── Dashboard layout ─────────────────────────────────────────────────────────

export async function getLayout(c: Context<AppContext>) {
  const data = await getDashboardLayout(getDb(c.env.DB), c.get("user").id);
  return c.json({ success: true, data }, 200);
}

export async function saveLayout(c: Context<AppContext>) {
  const body = await parseBody(c, layoutBodySchema);
  await saveDashboardLayout(getDb(c.env.DB), c.get("user").id, body);
  return c.json({ success: true, data: body }, 200);
}

// ─── Daily report ─────────────────────────────────────────────────────────────

async function channelAvailability(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const [telegram, store] = await Promise.all([
    resolveTelegramConfig(c.env).catch(() => null),
    getStore(db).catch(() => null),
  ]);
  const email = store ? await getEmailConfig(db, store.id).catch(() => undefined) : undefined;
  return {
    telegramConfigured: Boolean(telegram),
    emailConfigured: Boolean(email?.enabled),
  };
}

export async function getReportConfigHandler(c: Context<AppContext>) {
  const [config, channels] = await Promise.all([getReportConfig(getDb(c.env.DB)), channelAvailability(c)]);
  return c.json({ success: true, data: { ...config, ...channels } }, 200);
}

export async function saveReportConfigHandler(c: Context<AppContext>) {
  const body = await parseBody(c, reportConfigBodySchema);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
  } catch {
    throw new ValidationError("Unknown timezone");
  }
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  await saveReportConfig(db, body, actor.id);
  await logActivity(db, actor, ACTIONS.DAILY_REPORT_SETTINGS_CHANGED, { type: "settings", id: "daily-report", label: "Daily report" }, body);
  const [config, channels] = await Promise.all([getReportConfig(db), channelAvailability(c)]);
  return c.json({ success: true, data: { ...config, ...channels } }, 200);
}

export async function sendReportNow(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const stored = await getReportConfig(db);
  const config = {
    ...stored,
    telegramEnabled: stored.telegramEnabled || !stored.emailEnabled,
  };
  const outcome = await sendDailyReport(c.env, config);
  await logActivity(db, c.get("user"), ACTIONS.DAILY_REPORT_SENT, { type: "settings", id: "daily-report", label: "Daily report" }, {
    telegram: outcome.telegram,
    email: outcome.email,
  });
  return c.json(
    {
      success: true,
      data: {
        telegram: outcome.telegram,
        email: outcome.email,
        errors: outcome.errors,
        preview: outcome.data,
      },
    },
    200,
  );
}
