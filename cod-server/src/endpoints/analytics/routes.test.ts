/**
 * Route-level integration tests for the Analytics OpenAPIHono router.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppContext } from "@/types";
import { errorHandler } from "@/middleware/error";
import { openApiValidationHook } from "@/openapi/validation-hook";
import analyticsRouter from "./routes";
import {
  createExpense,
  getAnalyticsOverview,
  getAnalyticsTimeseries,
  getDashboardAlerts,
  getDashboardLayout,
  getExpense,
  getOrderStatusStats,
  getProductAnalytics,
  getProfitAndLoss,
  getReportConfig,
  getTodayBoard,
  saveDashboardLayout,
  saveReportConfig,
} from "../../../../cod-shared/queries/analytics";

const mockDb = {
  select: vi.fn(),
} as any;

vi.mock("@/db", () => ({
  getDb: vi.fn(() => mockDb),
}));
vi.mock("../../../../cod-shared/queries/analytics", () => ({
  getOrderStatusStats: vi.fn(),
  getAnalyticsOverview: vi.fn(),
  getAnalyticsTimeseries: vi.fn(),
  getWilayaAnalytics: vi.fn(),
  getProductAnalytics: vi.fn(),
  getCarrierAnalytics: vi.fn(),
  getDashboardAlerts: vi.fn(),
  getTodayBoard: vi.fn(),
  getProfitAndLoss: vi.fn(),
  getRoas: vi.fn(),
  listExpenses: vi.fn(),
  getExpense: vi.fn(),
  createExpense: vi.fn(),
  updateExpense: vi.fn(),
  deleteExpense: vi.fn(),
  getDashboardLayout: vi.fn(),
  saveDashboardLayout: vi.fn(),
  getReportConfig: vi.fn(),
  saveReportConfig: vi.fn(),
  markReportSent: vi.fn(),
  localDate: vi.fn((iso: string) => iso.slice(0, 10)),
  DEFAULT_REPORT_CONFIG: {},
}));
vi.mock("@/lib/activity", () => ({
  ACTIONS: new Proxy({}, { get: (_target, key) => String(key).toLowerCase() }),
  logActivity: vi.fn(),
}));
vi.mock("@/lib/daily-report", () => ({
  sendDailyReport: vi.fn(),
}));
vi.mock("@/endpoints/telegram-approvals/service", () => ({
  resolveTelegramConfig: vi.fn(async () => null),
}));
vi.mock("../../../../cod-shared/queries/stores", () => ({
  getStore: vi.fn(async () => null),
}));
vi.mock("../../../../cod-shared/queries/email-config", () => ({
  getEmailConfig: vi.fn(async () => undefined),
}));

function makeApp(user: any) {
  const app = new OpenAPIHono<AppContext>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.env = { DB: mockDb } as any;
    if (user) c.set("user", user);
    await next();
  });
  app.onError(errorHandler);
  app.route("/api/analytics", analyticsRouter);
  return app;
}

const viewer = { id: "u1", name: "Viewer", role: "viewer", scopes: ["dashboard:view"] };
const admin = { id: "a1", name: "Admin", role: "admin", scopes: [] };
const confirmer = { id: "confirmer-1", name: "Agent", role: "confirmer", scopes: ["dashboard:view"] };

const emptyTotals = {
  totalOrders: 0,
  confirmedOrders: 0,
  deliveredOrders: 0,
  returnedOrders: 0,
  cancelledOrders: 0,
  pendingConfirmation: 0,
  inTransit: 0,
  revenueDelivered: 0,
  deliveryFeesDelivered: 0,
  revenuePending: 0,
  revenueLostReturns: 0,
  avgOrderValue: 0,
  confirmationRate: null,
  deliveryRate: null,
  returnRate: null,
  cancellationRate: null,
};

describe("Analytics routes (defineRoute)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /dashboard-stats", () => {
    it("returns 200 with status breakdown for a user holding dashboard:view", async () => {
      vi.mocked(getOrderStatusStats).mockResolvedValue([
        { status: "new", count: 12 },
        { status: "delivered", count: 5 },
      ]);
      const app = makeApp(viewer);

      const res = await app.request("/api/analytics/dashboard-stats");

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({
        success: true,
        data: [
          { status: "new", count: 12 },
          { status: "delivered", count: 5 },
        ],
      });
      expect(getOrderStatusStats).toHaveBeenCalledWith(mockDb);
    });

    it("scopes confirmer statistics to the authenticated confirmer", async () => {
      vi.mocked(getOrderStatusStats).mockResolvedValue([]);
      const app = makeApp(confirmer);

      const res = await app.request("/api/analytics/dashboard-stats");

      expect(res.status).toBe(200);
      expect(getOrderStatusStats).toHaveBeenCalledWith(mockDb, "confirmer-1");
    });

    it("allows admin without explicit dashboard:view scope", async () => {
      vi.mocked(getOrderStatusStats).mockResolvedValue([]);
      const app = makeApp(admin);

      const res = await app.request("/api/analytics/dashboard-stats");

      expect(res.status).toBe(200);
    });

    it("returns 403 when the user lacks dashboard:view", async () => {
      const app = makeApp({ id: "u1", name: "Viewer", role: "viewer", scopes: ["orders:read"] });

      const res = await app.request("/api/analytics/dashboard-stats");

      expect(res.status).toBe(403);
      expect(getOrderStatusStats).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      const app = makeApp(null);

      const res = await app.request("/api/analytics/dashboard-stats");

      expect(res.status).toBe(401);
    });
  });

  describe("GET /overview", () => {
    it("passes the requested range and scopes confirmers", async () => {
      vi.mocked(getAnalyticsOverview).mockResolvedValue({
        range: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" },
        previousRange: { from: "2026-08-25T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
        current: emptyTotals,
        previous: emptyTotals,
      });
      const app = makeApp(confirmer);

      const res = await app.request(
        "/api/analytics/overview?from=2026-09-01T00:00:00.000Z&to=2026-09-08T00:00:00.000Z&tz=60",
      );

      expect(res.status).toBe(200);
      expect(getAnalyticsOverview).toHaveBeenCalledWith(
        mockDb,
        { from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" },
        "confirmer-1",
      );
    });

    it("defaults to the last 30 days when no range is given", async () => {
      vi.mocked(getAnalyticsOverview).mockResolvedValue({
        range: { from: "", to: "" },
        previousRange: { from: "", to: "" },
        current: emptyTotals,
        previous: emptyTotals,
      });
      const app = makeApp(viewer);

      const res = await app.request("/api/analytics/overview");

      expect(res.status).toBe(200);
      const [, range] = vi.mocked(getAnalyticsOverview).mock.calls[0];
      const days = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000;
      expect(Math.round(days)).toBe(30);
    });

    it("rejects an inverted range with 400", async () => {
      const app = makeApp(viewer);

      const res = await app.request(
        "/api/analytics/overview?from=2026-09-08T00:00:00.000Z&to=2026-09-01T00:00:00.000Z",
      );

      expect(res.status).toBe(400);
      expect(getAnalyticsOverview).not.toHaveBeenCalled();
    });

    it("rejects an invalid tz with 400", async () => {
      const app = makeApp(viewer);

      const res = await app.request("/api/analytics/overview?tz=abc");

      expect(res.status).toBe(400);
    });
  });

  describe("GET /timeseries", () => {
    it("forwards granularity and tz offset", async () => {
      vi.mocked(getAnalyticsTimeseries).mockResolvedValue([]);
      const app = makeApp(viewer);

      const res = await app.request(
        "/api/analytics/timeseries?from=2026-01-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z&granularity=week&tz=60",
      );

      expect(res.status).toBe(200);
      expect(getAnalyticsTimeseries).toHaveBeenCalledWith(
        mockDb,
        { from: "2026-01-01T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z" },
        "week",
        60,
        undefined,
      );
      const body: any = await res.json();
      expect(body.granularity).toBe("week");
    });

    it("rejects an unknown granularity", async () => {
      const app = makeApp(viewer);

      const res = await app.request("/api/analytics/timeseries?granularity=hour");

      expect(res.status).toBe(400);
    });
  });

  describe("GET /products", () => {
    it("caps the limit and scopes confirmers", async () => {
      vi.mocked(getProductAnalytics).mockResolvedValue([]);
      const app = makeApp(confirmer);

      const res = await app.request("/api/analytics/products?limit=25");

      expect(res.status).toBe(200);
      expect(getProductAnalytics).toHaveBeenCalledWith(mockDb, expect.any(Object), 25, "confirmer-1");
    });
  });

  describe("GET /alerts", () => {
    it("returns the alert list", async () => {
      vi.mocked(getDashboardAlerts).mockResolvedValue([
        { id: "unconfirmed_orders", severity: "warning", count: 3, href: "/orders?status=new" },
      ]);
      const app = makeApp(viewer);

      const res = await app.request("/api/analytics/alerts");

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data[0].id).toBe("unconfirmed_orders");
      expect(getDashboardAlerts).toHaveBeenCalledWith(mockDb, expect.any(Date), undefined);
    });
  });

  describe("GET /today", () => {
    it("passes the actor to the board query", async () => {
      vi.mocked(getTodayBoard).mockResolvedValue({
        toConfirm: 0,
        readyToShip: 0,
        lateShipments: 0,
        overdueTasks: 0,
        myOverdueTasks: 0,
        pendingApprovals: 0,
        todayOrders: 0,
        todayDelivered: 0,
        todayReturned: 0,
        todayRevenue: 0,
        todayConfirmed: 0,
      } as any);
      const app = makeApp(confirmer);

      const res = await app.request("/api/analytics/today?from=2026-09-19T23:00:00.000Z");

      expect(res.status).toBe(200);
      expect(getTodayBoard).toHaveBeenCalledWith(
        mockDb,
        "2026-09-19T23:00:00.000Z",
        { id: "confirmer-1", role: "confirmer" },
        expect.any(Date),
      );
    });
  });

  describe("finance routes", () => {
    it("returns 403 for P&L when the user lacks analytics:finance", async () => {
      const app = makeApp(viewer);

      const res = await app.request("/api/analytics/pnl");

      expect(res.status).toBe(403);
      expect(getProfitAndLoss).not.toHaveBeenCalled();
    });

    it("returns P&L for a user holding analytics:finance", async () => {
      vi.mocked(getProfitAndLoss).mockResolvedValue({ netProfit: 1000 } as any);
      const app = makeApp({ ...viewer, scopes: ["dashboard:view", "analytics:finance"] });

      const res = await app.request("/api/analytics/pnl?tz=60");

      expect(res.status).toBe(200);
      expect(getProfitAndLoss).toHaveBeenCalledWith(mockDb, expect.any(Object), 60);
    });

    it("blocks finance CSV exports without analytics:finance even with dashboard:view", async () => {
      const app = makeApp(viewer);

      const res = await app.request("/api/analytics/export?report=pnl");

      expect(res.status).toBe(403);
    });

    it("exports an operational CSV with a UTF-8 BOM", async () => {
      vi.mocked(getAnalyticsTimeseries).mockResolvedValue([
        {
          period: "2026-09-01",
          orders: 10,
          confirmed: 8,
          delivered: 5,
          returned: 1,
          cancelled: 1,
          revenueDelivered: 25000,
          revenuePending: 10000,
        },
      ]);
      const app = makeApp(viewer);

      const res = await app.request("/api/analytics/export?report=timeseries&lang=fr&delimiter=semicolon");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("content-disposition")).toContain("codflow-timeseries-");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain("Période;Commandes;");
      expect(text).toContain("2026-09-01;10;8;5;1;1;25000;10000");
    });

    it("creates an expense and records who created it", async () => {
      vi.mocked(createExpense).mockResolvedValue("exp-1");
      vi.mocked(getExpense).mockResolvedValue({ id: "exp-1", amount: 5000, category: "ads" } as any);
      const app = makeApp(admin);

      const res = await app.request("/api/analytics/expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-09-20", category: "ads", platform: "meta", amount: 5000 }),
      });

      expect(res.status).toBe(201);
      expect(createExpense).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ date: "2026-09-20", category: "ads", platform: "meta", amount: 5000 }),
        "a1",
      );
    });

    it("rejects an expense with an unknown category", async () => {
      const app = makeApp(admin);

      const res = await app.request("/api/analytics/expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-09-20", category: "coffee", amount: 5000 }),
      });

      expect(res.status).toBe(400);
      expect(createExpense).not.toHaveBeenCalled();
    });
  });

  describe("dashboard layout", () => {
    it("returns the caller's saved layout", async () => {
      vi.mocked(getDashboardLayout).mockResolvedValue({ version: 1, widgets: [{ id: "kpis", hidden: false }] });
      const app = makeApp(viewer);

      const res = await app.request("/api/analytics/dashboard-layout");

      expect(res.status).toBe(200);
      expect(getDashboardLayout).toHaveBeenCalledWith(mockDb, "u1");
    });

    it("saves the layout for the caller only", async () => {
      vi.mocked(saveDashboardLayout).mockResolvedValue(undefined);
      const app = makeApp(viewer);

      const res = await app.request("/api/analytics/dashboard-layout", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, widgets: [{ id: "kpis", hidden: false }, { id: "alerts", hidden: true }] }),
      });

      expect(res.status).toBe(200);
      expect(saveDashboardLayout).toHaveBeenCalledWith(mockDb, "u1", {
        version: 1,
        widgets: [
          { id: "kpis", hidden: false },
          { id: "alerts", hidden: true },
        ],
      });
    });
  });

  describe("daily report config", () => {
    it("is admin only", async () => {
      const app = makeApp({ ...viewer, scopes: ["dashboard:view", "analytics:finance"] });

      const res = await app.request("/api/analytics/report-config");

      expect(res.status).toBe(403);
      expect(getReportConfig).not.toHaveBeenCalled();
    });

    it("saves a valid configuration", async () => {
      vi.mocked(saveReportConfig).mockResolvedValue(undefined);
      vi.mocked(getReportConfig).mockResolvedValue({
        enabled: true,
        sendHour: 20,
        timezone: "Africa/Algiers",
        telegramEnabled: true,
        emailEnabled: false,
        emailRecipients: [],
        lastSentOn: null,
      });
      const app = makeApp(admin);

      const res = await app.request("/api/analytics/report-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          sendHour: 20,
          timezone: "Africa/Algiers",
          telegramEnabled: true,
          emailEnabled: false,
          emailRecipients: [],
        }),
      });

      expect(res.status).toBe(200);
      expect(saveReportConfig).toHaveBeenCalledWith(mockDb, expect.objectContaining({ sendHour: 20 }), "a1");
      const body: any = await res.json();
      expect(body.data.telegramConfigured).toBe(false);
    });

    it("rejects an invalid hour", async () => {
      const app = makeApp(admin);

      const res = await app.request("/api/analytics/report-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          sendHour: 25,
          timezone: "Africa/Algiers",
          telegramEnabled: true,
          emailEnabled: false,
          emailRecipients: [],
        }),
      });

      expect(res.status).toBe(400);
      expect(saveReportConfig).not.toHaveBeenCalled();
    });
  });
});
