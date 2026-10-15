/**
 * Route-level tests for the carrier status sync endpoints.
 *
 * The engine itself is covered by auto-sync.test.ts / auto-sync.e2e.test.ts;
 * this file pins the HTTP contract — routing order (the bulk path must not be
 * swallowed by /{id}), body validation, and the error envelope.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppContext } from "@/types";
import { errorHandler } from "@/middleware/error";
import { openApiValidationHook } from "@/openapi/validation-hook";
import ordersRouter from "./routes";
import * as queries from "./queries";
import * as autoSync from "@/endpoints/delivery-companies/providers/auto-sync";
import { getDeliveryCompanyRaw } from "@/endpoints/delivery-companies/queries";

vi.mock("@/db", () => ({ getDb: vi.fn(() => mockDb) }));
vi.mock("./queries");
vi.mock("@/lib/activity", () => ({
  logActivity: vi.fn(async () => {}),
  ACTIONS: {
    ORDER_CARRIER_SYNCED: "order.carrier_synced",
    ORDER_CARRIER_SYNC_BULK: "order.carrier_sync_bulk",
  },
}));
vi.mock("@/endpoints/delivery-companies/providers/auto-sync", () => ({
  syncCompanyStatuses: vi.fn(),
  DEFAULT_SYNC_BATCH_SIZE: 100,
  makeCapiTrigger: vi.fn(() => () => {}),
}));
vi.mock("@/endpoints/delivery-companies/queries", () => ({
  getDeliveryCompanyRaw: vi.fn(),
}));
vi.mock("@/endpoints/delivery-companies/providers/auto-sync.queries", () => ({
  getAutoSyncCompanies: vi.fn(async () => []),
}));

let mockDb: any;

const ORDER = {
  id: "ord_sync_1",
  orderNumber: "ORD-SYNC-1",
  status: "dispatched",
  companyId: "comp_1",
  trackingNumber: "TRK-1",
  wilayaId: 16,
};

const COMPANY = {
  id: "comp_1",
  name: "Yalidine",
  code: "yalidine",
  apiToken: "token",
  apiUserGuid: "api-id",
  apiEndpoint: "https://api.yalidine.test/v1",
  notes: null,
  webhookStatusMapping: null,
  autoSyncEnabled: true,
  autoSyncIntervalMin: 30,
};

/** Hono exposes c.executionCtx from the ExecutionContext passed to app.request. */
const execCtx = { waitUntil: (p: Promise<unknown>) => void p } as unknown as ExecutionContext;

describe("Orders carrier-sync routes", () => {
  let app: OpenAPIHono<AppContext>;

  beforeEach(() => {
    app = new OpenAPIHono<AppContext>({ defaultHook: openApiValidationHook });
    app.use("*", async (c, next) => {
      c.env = { DB: mockDb } as any;
      c.set("user", {
        id: "admin_user_001",
        name: "Admin User",
        role: "admin",
        scopes: ["*"],
      } as any);
      await next();
    });
    app.onError(errorHandler);
    app.route("/api/orders", ordersRouter);
    mockDb = { insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })) };
    vi.clearAllMocks();
  });

  describe("POST /api/orders/{id}/sync-carrier", () => {
    it("returns the sync outcome for the order", async () => {
      vi.mocked(queries.getOrderById).mockResolvedValue(ORDER as any);
      vi.mocked(getDeliveryCompanyRaw).mockResolvedValue(COMPANY as any);
      vi.mocked(autoSync.syncCompanyStatuses).mockResolvedValue({
        runId: "run_1",
        companyId: "comp_1",
        companyCode: "yalidine",
        companyName: "Yalidine",
        counters: { scanned: 1, polled: 1, updated: 1, unchanged: 0, unmapped: 0, errors: 0, unmappedStatuses: [] },
        errorMessage: null,
        details: [
          {
            orderId: "ord_sync_1",
            orderNumber: "ORD-SYNC-1",
            trackingNumber: "TRK-1",
            outcome: "updated",
            from: "dispatched",
            to: "delivered",
            carrierStatus: "Livré",
          },
        ],
      } as any);

      const res = await app.request(
        "/api/orders/ord_sync_1/sync-carrier",
        { method: "POST" },
        undefined,
        execCtx,
      );

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data).toMatchObject({
        orderId: "ord_sync_1",
        outcome: "updated",
        from: "dispatched",
        to: "delivered",
        carrierStatus: "Livré",
        companyCode: "yalidine",
      });
    });

    it("bypasses the throttle and restricts the run to this order", async () => {
      vi.mocked(queries.getOrderById).mockResolvedValue(ORDER as any);
      vi.mocked(getDeliveryCompanyRaw).mockResolvedValue(COMPANY as any);
      vi.mocked(autoSync.syncCompanyStatuses).mockResolvedValue({
        runId: "run_1",
        companyId: "comp_1",
        companyCode: "yalidine",
        companyName: "Yalidine",
        counters: { scanned: 1, polled: 1, updated: 0, unchanged: 1, unmapped: 0, errors: 0, unmappedStatuses: [] },
        errorMessage: null,
        details: [
          {
            orderId: "ord_sync_1",
            orderNumber: "ORD-SYNC-1",
            trackingNumber: "TRK-1",
            outcome: "unchanged",
            from: "dispatched",
            carrierStatus: "En transit",
          },
        ],
      } as any);

      await app.request("/api/orders/ord_sync_1/sync-carrier", { method: "POST" });

      expect(autoSync.syncCompanyStatuses).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ id: "comp_1", code: "yalidine" }),
        expect.objectContaining({ trigger: "manual", force: true, orderIds: ["ord_sync_1"] }),
      );
    });

    it("returns 404 when the order does not exist", async () => {
      vi.mocked(queries.getOrderById).mockResolvedValue(null as any);

      const res = await app.request("/api/orders/missing/sync-carrier", { method: "POST" }, undefined, execCtx);
      expect(res.status).toBe(404);
    });

    it("returns 422 when the order has no tracking number", async () => {
      vi.mocked(queries.getOrderById).mockResolvedValue({ ...ORDER, trackingNumber: null } as any);

      const res = await app.request(
        "/api/orders/ord_sync_1/sync-carrier",
        { method: "POST" },
        undefined,
        execCtx,
      );
      expect(res.status).toBe(422);
    });

    it("returns 422 when the company is not connected", async () => {
      vi.mocked(queries.getOrderById).mockResolvedValue(ORDER as any);
      vi.mocked(getDeliveryCompanyRaw).mockResolvedValue({ ...COMPANY, apiToken: null } as any);

      const res = await app.request(
        "/api/orders/ord_sync_1/sync-carrier",
        { method: "POST" },
        undefined,
        execCtx,
      );
      expect(res.status).toBe(422);
      const body: any = await res.json();
      expect(body.code).toBe("MISSING_API_CREDENTIALS");
    });

    it("returns 502 when the carrier call failed", async () => {
      vi.mocked(queries.getOrderById).mockResolvedValue(ORDER as any);
      vi.mocked(getDeliveryCompanyRaw).mockResolvedValue(COMPANY as any);
      vi.mocked(autoSync.syncCompanyStatuses).mockResolvedValue({
        runId: "run_1",
        companyId: "comp_1",
        companyCode: "yalidine",
        companyName: "Yalidine",
        counters: { scanned: 1, polled: 0, updated: 0, unchanged: 0, unmapped: 0, errors: 1, unmappedStatuses: [] },
        errorMessage: null,
        details: [
          {
            orderId: "ord_sync_1",
            orderNumber: "ORD-SYNC-1",
            trackingNumber: "TRK-1",
            outcome: "error",
            from: "dispatched",
            error: "carrier exploded",
          },
        ],
      } as any);

      const res = await app.request(
        "/api/orders/ord_sync_1/sync-carrier",
        { method: "POST" },
        undefined,
        execCtx,
      );
      expect(res.status).toBe(502);
      const body: any = await res.json();
      expect(body.code).toBe("EXTERNAL_API_FAILURE");
    });
  });

  describe("POST /api/orders/bulk-sync-carrier", () => {
    it("is routed as a bulk path, not captured by /{id}", async () => {
      vi.mocked(autoSync.syncCompanyStatuses).mockResolvedValue({
        runId: "run_2",
        companyId: "comp_1",
        companyCode: "yalidine",
        companyName: "Yalidine",
        counters: { scanned: 2, polled: 2, updated: 1, unchanged: 1, unmapped: 0, errors: 0, unmappedStatuses: [] },
        errorMessage: null,
        details: [],
      } as any);

      const res = await app.request(
        "/api/orders/bulk-sync-carrier",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderIds: ["ord_sync_1", "ord_sync_2"], force: true }),
        },
        undefined,
        execCtx,
      );

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.totals).toMatchObject({ scanned: 2, updated: 1 });
      // The explicit selection must be forwarded so only those orders are polled.
      expect(autoSync.syncCompanyStatuses).toHaveBeenCalledWith(
        mockDb,
        expect.anything(),
        expect.objectContaining({ orderIds: ["ord_sync_1", "ord_sync_2"], force: true }),
      );
    });

    it("rejects a selection larger than the batch cap", async () => {
      const res = await app.request(
        "/api/orders/bulk-sync-carrier",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderIds: Array.from({ length: 101 }, (_, i) => `ord_${i}`) }),
        },
        undefined,
        execCtx,
      );

      expect(res.status).toBe(400);
    });
  });
});
