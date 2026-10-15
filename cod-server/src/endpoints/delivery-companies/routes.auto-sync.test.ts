/**
 * Route-level tests for the per-company carrier auto-sync endpoints.
 *
 * The engine is covered by providers/auto-sync.test.ts and its e2e twin; this
 * file pins the HTTP contract — the three paths must not be swallowed by
 * `/{id}`, the manual run must refuse a company with no credentials, and an
 * engine-level failure must surface as an error envelope rather than a 200.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppContext } from "@/types";
import { errorHandler } from "@/middleware/error";
import { openApiValidationHook } from "@/openapi/validation-hook";
import deliveryCompaniesRouter from "./routes";
import { ERROR_CODES } from "../../../../cod-shared/errors/codes";
import * as queries from "./queries";
import * as autoSync from "./providers/auto-sync";

vi.mock("@/db", () => ({ getDb: vi.fn(() => mockDb) }));
vi.mock("./queries");
vi.mock("@/lib/activity", () => ({
  logActivity: vi.fn(async () => {}),
  ACTIONS: {
    ORDER_CARRIER_SYNCED: "order.carrier_synced",
    ORDER_CARRIER_SYNC_BULK: "order.carrier_sync_bulk",
  },
}));
vi.mock("./providers/auto-sync", () => ({
  syncCompanyStatuses: vi.fn(),
  DEFAULT_SYNC_BATCH_SIZE: 100,
  makeCapiTrigger: vi.fn(() => () => {}),
}));
vi.mock("./providers/auto-sync.queries", () => ({
  getLastSyncRun: vi.fn(),
  listSyncRuns: vi.fn(),
}));

import { getLastSyncRun, listSyncRuns } from "./providers/auto-sync.queries";

let mockDb: any;

const COMPANY = {
  id: "comp_1",
  name: "Yalidine",
  code: "yalidine",
  apiToken: "token",
  apiUserGuid: "api-id",
  apiEndpoint: "https://api.yalidine.test/v1",
  notes: null,
  webhookSecret: null,
  webhookStatusMapping: null,
  autoSyncEnabled: true,
  autoSyncIntervalMin: 30,
};

const RUN = {
  id: "run_1",
  trigger: "cron",
  mode: "poll",
  startedAt: "2026-09-21T08:00:00.000Z",
  finishedAt: "2026-09-21T08:00:04.000Z",
  scanned: 5,
  polled: 5,
  updated: 2,
  unchanged: 2,
  unmapped: 1,
  errors: 0,
  unmappedStatuses: '["En attente"]',
  errorMessage: null,
};

/** The status handler runs two aggregate selects; both resolve through .get(). */
function fakeDb(selectResults: unknown[]) {
  let calls = 0;
  const chain: any = {
    from: () => chain,
    where: () => chain,
    get: async () => selectResults[Math.min(calls++, selectResults.length - 1)],
  };
  return { select: () => chain, insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })) };
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p } as unknown as ExecutionContext;

describe("Delivery companies auto-sync routes", () => {
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
    app.route("/api/delivery-companies", deliveryCompaniesRouter);
    mockDb = fakeDb([{ shipped: 7, neverSynced: 2 }, { failing: 1 }]);
    vi.clearAllMocks();
  });

  describe("GET /api/delivery-companies/{id}/auto-sync/status", () => {
    it("returns the switches, the backlog counts and the last run", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue(COMPANY as any);
      vi.mocked(getLastSyncRun).mockResolvedValue(RUN as any);

      const res = await app.request("/api/delivery-companies/comp_1/auto-sync/status");

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data).toMatchObject({
        companyId: "comp_1",
        companyCode: "yalidine",
        autoSyncEnabled: true,
        autoSyncIntervalMin: 30,
        hasCredentials: true,
        hasWebhookSecret: false,
        shippedOrders: 7,
        failingOrders: 1,
      });
      expect(body.data.lastRun).toMatchObject({
        id: "run_1",
        trigger: "cron",
        mode: "poll",
        updated: 2,
        unmapped: 1,
      });
      expect(body.data.lastRun.unmappedStatuses).toEqual(["En attente"]);
    });

    it("reports null lastRun for a company that has never synced", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue(COMPANY as any);
      vi.mocked(getLastSyncRun).mockResolvedValue(undefined);

      const res = await app.request("/api/delivery-companies/comp_1/auto-sync/status");

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.lastRun).toBeNull();
    });

    it("404s for an unknown company", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue(undefined);

      const res = await app.request("/api/delivery-companies/nope/auto-sync/status");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/delivery-companies/{id}/sync-statuses", () => {
    it("runs the engine for this company and returns the counters", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue(COMPANY as any);
      vi.mocked(autoSync.syncCompanyStatuses).mockResolvedValue({
        runId: "run_2",
        companyId: "comp_1",
        companyCode: "yalidine",
        companyName: "Yalidine",
        counters: { scanned: 3, polled: 3, updated: 1, unchanged: 2, unmapped: 0, errors: 0, unmappedStatuses: [] },
        errorMessage: null,
        details: [],
      } as any);

      const res = await app.request(
        "/api/delivery-companies/comp_1/sync-statuses",
        { method: "POST" },
        undefined,
        execCtx,
      );

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data).toMatchObject({
        runId: "run_2",
        companyCode: "yalidine",
        scanned: 3,
        polled: 3,
        updated: 1,
      });
    });

    it("passes force and limit through to the engine", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue(COMPANY as any);
      vi.mocked(autoSync.syncCompanyStatuses).mockResolvedValue({
        runId: "run_3",
        companyId: "comp_1",
        companyCode: "yalidine",
        counters: { scanned: 0, polled: 0, updated: 0, unchanged: 0, unmapped: 0, errors: 0, unmappedStatuses: [] },
        errorMessage: null,
        details: [],
      } as any);

      await app.request(
        "/api/delivery-companies/comp_1/sync-statuses?force=true&limit=5",
        { method: "POST" },
        undefined,
        execCtx,
      );

      const options = vi.mocked(autoSync.syncCompanyStatuses).mock.calls[0]![2];
      expect(options).toMatchObject({ trigger: "company", force: true, limit: 5 });
    });

    it("400s with MISSING_API_CREDENTIALS when the company is not connected", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue({
        ...COMPANY,
        apiToken: null,
      } as any);

      const res = await app.request(
        "/api/delivery-companies/comp_1/sync-statuses",
        { method: "POST" },
        undefined,
        execCtx,
      );

      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.code).toBe(ERROR_CODES.MISSING_API_CREDENTIALS);
      expect(autoSync.syncCompanyStatuses).not.toHaveBeenCalled();
    });

    it("surfaces an engine failure as an error envelope", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue(COMPANY as any);
      vi.mocked(autoSync.syncCompanyStatuses).mockResolvedValue({
        runId: "run_4",
        companyId: "comp_1",
        companyCode: "yalidine",
        counters: { scanned: 0, polled: 0, updated: 0, unchanged: 0, unmapped: 0, errors: 0, unmappedStatuses: [] },
        errorMessage: "No provider registered for yalidine",
        details: [],
      } as any);

      const res = await app.request(
        "/api/delivery-companies/comp_1/sync-statuses",
        { method: "POST" },
        undefined,
        execCtx,
      );

      // BusinessLogicError → 422 with the engine's message in the envelope.
      expect(res.status).toBe(422);
      const body: any = await res.json();
      expect(body.code).toBe(ERROR_CODES.PROVIDER_NOT_SUPPORTED);
      expect(body.error).toContain("No provider registered");
    });

    it("404s for an unknown company", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue(undefined);

      const res = await app.request(
        "/api/delivery-companies/nope/sync-statuses",
        { method: "POST" },
        undefined,
        execCtx,
      );

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/delivery-companies/{id}/sync-runs", () => {
    it("returns the company's run history newest first", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue(COMPANY as any);
      vi.mocked(listSyncRuns).mockResolvedValue([RUN, { ...RUN, id: "run_0" }] as any);

      const res = await app.request("/api/delivery-companies/comp_1/sync-runs");

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.runs).toHaveLength(2);
      expect(body.data.runs[0]).toMatchObject({ id: "run_1", mode: "poll", updated: 2 });
      expect(body.data.runs[0].unmappedStatuses).toEqual(["En attente"]);
    });

    it("defaults the limit to 30 and honours an explicit one", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue(COMPANY as any);
      vi.mocked(listSyncRuns).mockResolvedValue([]);

      await app.request("/api/delivery-companies/comp_1/sync-runs");
      expect(vi.mocked(listSyncRuns).mock.calls[0]![1]).toMatchObject({ limit: 30 });

      await app.request("/api/delivery-companies/comp_1/sync-runs?limit=3");
      expect(vi.mocked(listSyncRuns).mock.calls[1]![1]).toMatchObject({ limit: 3 });
    });

    it("404s for an unknown company", async () => {
      vi.mocked(queries.getDeliveryCompanyRaw).mockResolvedValue(undefined);

      const res = await app.request("/api/delivery-companies/nope/sync-runs");

      expect(res.status).toBe(404);
    });
  });
});
