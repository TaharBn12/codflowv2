/**
 * Analytics Routes
 *
 * Endpoints that serve aggregated stats for the dashboard, the finance
 * widgets (P&L / ROAS / expenses), the per-user widget layout and the
 * automatic daily report. Built with defineRoute() — the standard
 * route-builder pattern.
 *
 * Access model
 * - Operational analytics (overview, timeseries, wilayas, products, carriers,
 *   alerts, today board, export, layout): DASHBOARD_VIEW. Confirmers only see
 *   the orders assigned to them.
 * - Finance (P&L, ROAS, expenses): ANALYTICS_FINANCE — money data stays with
 *   the owner and the people explicitly granted the scope.
 * - Daily report configuration + "send now": admin only.
 */

import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "@/types";
import { defineRoute } from "@/lib/route-builder";
import { SCOPES } from "../../../../cod-shared/rbac/scopes";
import { OrderStatusEnum } from "@/openapi/schemas";
import {
  carriersQuerySchema,
  createExpenseHandler,
  deleteExpenseHandler,
  expenseBodySchema,
  expenseUpdateSchema,
  expensesQuerySchema,
  exportQuerySchema,
  exportReport,
  getAlerts,
  getCarriers,
  getDashboardStats,
  getLayout,
  getOverview,
  getPnl,
  getProducts,
  getReportConfigHandler,
  getRoasReport,
  getTimeseries,
  getToday,
  getWilayas,
  layoutBodySchema,
  listExpensesHandler,
  productsQuerySchema,
  rangeQuerySchema,
  reportConfigBodySchema,
  roasQuerySchema,
  saveLayout,
  saveReportConfigHandler,
  sendReportNow,
  timeseriesQuerySchema,
  todayQuerySchema,
  updateExpenseHandler,
} from "./handlers";

const TAGS = ["Analytics"];
const idParams = z.object({ id: z.string().min(1) });

// ─── Legacy status cards ──────────────────────────────────────────────────────

const dashboardStatsRoute = defineRoute({
  method: "get",
  path: "/dashboard-stats",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "Order status statistics",
  description:
    "Returns order counts grouped by lifecycle status in a single optimized query — powers the dashboard summary cards.",
  operationId: "getDashboardStats",
  responses: {
    200: {
      description: "Order counts per status",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean().openapi({ example: true }),
            data: z.array(
              z.object({
                status: OrderStatusEnum,
                count: z.number().int().openapi({ example: 12 }),
              })
            ),
          }),
        },
      },
    },
  },
  handler: getDashboardStats,
});

// ─── KPI analytics (DASHBOARD_VIEW) ───────────────────────────────────────────

const overviewRoute = defineRoute({
  method: "get",
  path: "/overview",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "COD KPI overview",
  description:
    "Confirmation / delivery / return rates, AOV and collected vs pending revenue for a date range, with the previous period of equal length for comparison. Range is `[from, to)` in ISO-8601; defaults to the last 30 days.",
  operationId: "getAnalyticsOverview",
  query: rangeQuerySchema,
  handler: getOverview,
});

const timeseriesRoute = defineRoute({
  method: "get",
  path: "/timeseries",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "Orders & revenue time series",
  description:
    "Daily / weekly / monthly buckets of orders, confirmed, delivered, returned, cancelled and revenue. `tz` is the client UTC offset in minutes (Algeria = 60) so buckets follow the merchant's local day.",
  operationId: "getAnalyticsTimeseries",
  query: timeseriesQuerySchema,
  handler: getTimeseries,
});

const wilayasRoute = defineRoute({
  method: "get",
  path: "/wilayas",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "Per-wilaya performance",
  description: "Orders, delivery rate, return rate and collected revenue for each of the 58 wilayas — powers the heatmap.",
  operationId: "getAnalyticsWilayas",
  query: rangeQuerySchema,
  handler: getWilayas,
});

const productsRoute = defineRoute({
  method: "get",
  path: "/products",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "Product performance",
  description: "Best / worst products by collected revenue, return rate and gross profit (when a cost price is set).",
  operationId: "getAnalyticsProducts",
  query: productsQuerySchema,
  handler: getProducts,
});

const carriersRoute = defineRoute({
  method: "get",
  path: "/carriers",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "Carrier performance",
  description: "Delivery rate, return rate and average delivery duration per delivery company and per in-house driver. Optional `wilayaId` filter.",
  operationId: "getAnalyticsCarriers",
  query: carriersQuerySchema,
  handler: getCarriers,
});

const alertsRoute = defineRoute({
  method: "get",
  path: "/alerts",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "Smart alerts",
  description:
    "Actionable alerts: unconfirmed orders older than 24h, shipments stuck out for delivery, stock running out, drivers holding cash, webhook errors, overdue tasks and more.",
  operationId: "getDashboardAlerts",
  handler: getAlerts,
});

const todayRoute = defineRoute({
  method: "get",
  path: "/today",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "Today board",
  description: "What needs attention right now: to confirm, ready to ship, late shipments, overdue tasks, plus today's counters. `from` is the ISO start of the local day.",
  operationId: "getTodayBoard",
  query: todayQuerySchema,
  handler: getToday,
});

const exportRoute = defineRoute({
  method: "get",
  path: "/export",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "Export a report as CSV",
  description:
    "Streams a UTF-8 CSV (with BOM, Excel friendly) for the requested report. Finance reports (pnl, expenses, roas) additionally require the `analytics:finance` scope. Use `delimiter=semicolon` for French/Arabic Excel locales.",
  operationId: "exportAnalyticsReport",
  query: exportQuerySchema,
  responses: {
    200: {
      description: "CSV file",
      content: { "text/csv": { schema: z.string() } },
    },
  },
  handler: exportReport,
});

// ─── Finance (ANALYTICS_FINANCE) ──────────────────────────────────────────────

const pnlRoute = defineRoute({
  method: "get",
  path: "/pnl",
  auth: { scope: SCOPES.ANALYTICS_FINANCE },
  tags: TAGS,
  summary: "Simplified profit & loss",
  description:
    "Delivered revenue − COGS (product cost price) − driver fees − staff commissions − recorded expenses (ads, carrier invoices, packaging, salaries, rent, other).",
  operationId: "getProfitAndLoss",
  query: rangeQuerySchema,
  handler: getPnl,
});

const roasRoute = defineRoute({
  method: "get",
  path: "/roas",
  auth: { scope: SCOPES.ANALYTICS_FINANCE },
  tags: TAGS,
  summary: "Return on ad spend",
  description: "Daily ad spend (manual entries) versus orders and delivered revenue, overall and per platform. Optional `landingPageId` filter.",
  operationId: "getRoas",
  query: roasQuerySchema,
  handler: getRoasReport,
});

const listExpensesRoute = defineRoute({
  method: "get",
  path: "/expenses",
  auth: { scope: SCOPES.ANALYTICS_FINANCE },
  tags: TAGS,
  summary: "List expenses / ad spend entries",
  operationId: "listExpenses",
  query: expensesQuerySchema,
  handler: listExpensesHandler,
});

const createExpenseRoute = defineRoute({
  method: "post",
  path: "/expenses",
  auth: { scope: SCOPES.ANALYTICS_FINANCE },
  tags: TAGS,
  summary: "Record an expense or a day of ad spend",
  operationId: "createExpense",
  body: expenseBodySchema,
  handler: createExpenseHandler,
});

const updateExpenseRoute = defineRoute({
  method: "patch",
  path: "/expenses/{id}",
  auth: { scope: SCOPES.ANALYTICS_FINANCE },
  tags: TAGS,
  summary: "Update an expense",
  operationId: "updateExpense",
  params: idParams,
  body: expenseUpdateSchema,
  handler: updateExpenseHandler,
});

const deleteExpenseRoute = defineRoute({
  method: "delete",
  path: "/expenses/{id}",
  auth: { scope: SCOPES.ANALYTICS_FINANCE },
  tags: TAGS,
  summary: "Delete an expense",
  operationId: "deleteExpense",
  params: idParams,
  handler: deleteExpenseHandler,
});

// ─── Widget layout (per user) ─────────────────────────────────────────────────

const getLayoutRoute = defineRoute({
  method: "get",
  path: "/dashboard-layout",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "Get the caller's dashboard widget layout",
  operationId: "getDashboardLayout",
  handler: getLayout,
});

const saveLayoutRoute = defineRoute({
  method: "put",
  path: "/dashboard-layout",
  auth: { scope: SCOPES.DASHBOARD_VIEW },
  tags: TAGS,
  summary: "Save the caller's dashboard widget layout",
  operationId: "saveDashboardLayout",
  body: layoutBodySchema,
  handler: saveLayout,
});

// ─── Daily report (admin) ─────────────────────────────────────────────────────

const getReportConfigRoute = defineRoute({
  method: "get",
  path: "/report-config",
  auth: "admin",
  tags: TAGS,
  summary: "Get the automatic daily report configuration",
  operationId: "getDailyReportConfig",
  handler: getReportConfigHandler,
});

const saveReportConfigRoute = defineRoute({
  method: "put",
  path: "/report-config",
  auth: "admin",
  tags: TAGS,
  summary: "Update the automatic daily report configuration",
  operationId: "saveDailyReportConfig",
  body: reportConfigBodySchema,
  handler: saveReportConfigHandler,
});

const sendReportRoute = defineRoute({
  method: "post",
  path: "/report/send",
  auth: "admin",
  tags: TAGS,
  summary: "Send the daily report now",
  description: "Builds today's report and delivers it through the configured channels immediately — useful to test the setup.",
  operationId: "sendDailyReportNow",
  handler: sendReportNow,
});

const router = new OpenAPIHono<AppContext>();

for (const built of [
  dashboardStatsRoute,
  overviewRoute,
  timeseriesRoute,
  wilayasRoute,
  productsRoute,
  carriersRoute,
  alertsRoute,
  todayRoute,
  exportRoute,
  pnlRoute,
  roasRoute,
  listExpensesRoute,
  createExpenseRoute,
  updateExpenseRoute,
  deleteExpenseRoute,
  getLayoutRoute,
  saveLayoutRoute,
  getReportConfigRoute,
  saveReportConfigRoute,
  sendReportRoute,
]) {
  router.openapi(built.route as any, built.handler as any);
}

export default router;
