/**
 * Orders — Carrier Status Sync (manual triggers)
 *
 * The cron job (cron/sync-carrier-statuses.ts) is the steady-state path; these
 * handlers are the operator's override:
 *   POST /orders/:id/sync-carrier       one order, throttle bypassed
 *   POST /orders/bulk-sync-carrier      a selection (or everything due)
 *
 * Both go through the same engine as the cron, so status changes are applied by
 * updateOrderStatusWebhook's forward-only rank guard — a manual sync can never
 * move an order backwards.
 */

import type { Context } from "hono";
import type { AppContext } from "@/types";
import { getDb } from "@/db";
import { NotFoundError, BusinessLogicError, ExternalApiError } from "@/lib/errors/classes";
import { ERROR_CODES } from "../../../../cod-shared/errors/codes";
import { logActivity, ACTIONS } from "@/lib/activity";
import * as queries from "./queries";
import { getDeliveryCompanyRaw } from "@/endpoints/delivery-companies/queries";
import {
  DEFAULT_SYNC_BATCH_SIZE,
  makeCapiTrigger,
  syncCompanyStatuses,
  type SyncCompanyResult,
} from "@/endpoints/delivery-companies/providers/auto-sync";
import { getAutoSyncCompanies } from "@/endpoints/delivery-companies/providers/auto-sync.queries";

function summarize(results: SyncCompanyResult[]) {
  return results.reduce(
    (acc, run) => ({
      scanned: acc.scanned + run.counters.scanned,
      polled: acc.polled + run.counters.polled,
      updated: acc.updated + run.counters.updated,
      unchanged: acc.unchanged + run.counters.unchanged,
      unmapped: acc.unmapped + run.counters.unmapped,
      errors: acc.errors + run.counters.errors,
    }),
    { scanned: 0, polled: 0, updated: 0, unchanged: 0, unmapped: 0, errors: 0 },
  );
}

/**
 * POST /orders/:id/sync-carrier
 * Poll the carrier for this one order and apply what it reports.
 */
export async function syncOrderCarrierStatus(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const orderId = c.req.param("id")!;

  const order = await queries.getOrderById(db, orderId);
  if (!order) throw new NotFoundError("Order", orderId);

  if (!order.trackingNumber) {
    throw new BusinessLogicError(
      "Order has no tracking number — dispatch it to a delivery company first",
      ERROR_CODES.REQUIRED_FIELD_MISSING,
      { orderId },
    );
  }
  if (!order.companyId) {
    throw new BusinessLogicError(
      "Order has no delivery company assigned",
      ERROR_CODES.REQUIRED_FIELD_MISSING,
      { orderId },
    );
  }

  const company = await getDeliveryCompanyRaw(db, order.companyId);
  if (!company) throw new NotFoundError("Delivery company", order.companyId);

  // Call the engine directly rather than the sweep: the per-company auto-sync
  // switch governs the background job, not an explicit operator request. Only
  // credentials are required here.
  if (!company.apiToken) {
    throw new BusinessLogicError(
      `${company.name} is not connected — add API credentials first`,
      ERROR_CODES.MISSING_API_CREDENTIALS,
      { companyId: company.id },
    );
  }

  const run = await syncCompanyStatuses(
    db,
    {
      id: company.id,
      code: company.code,
      name: company.name,
      apiToken: company.apiToken,
      apiUserGuid: company.apiUserGuid,
      apiEndpoint: company.apiEndpoint,
      notes: company.notes,
      webhookStatusMapping: company.webhookStatusMapping,
      autoSyncIntervalMin: company.autoSyncIntervalMin,
    },
    {
      trigger: "manual",
      force: true,
      limit: 1,
      orderIds: [orderId],
      onDelivered: makeCapiTrigger(c.env, (p) => c.executionCtx.waitUntil(p)),
    },
  );

  if (run.errorMessage) {
    throw new BusinessLogicError(run.errorMessage, ERROR_CODES.PROVIDER_NOT_SUPPORTED, {
      companyId: company.id,
    });
  }

  const detail = run.details.find((d) => d.orderId === orderId);
  if (!detail) {
    throw new BusinessLogicError(
      "The carrier returned no tracking history for this order",
      ERROR_CODES.OPERATION_NOT_SUPPORTED,
      { orderId, trackingNumber: order.trackingNumber },
    );
  }

  if (detail.outcome === "error") {
    throw new ExternalApiError(company.code, detail.error ?? "Carrier tracking call failed", { orderId });
  }

  // Status transitions themselves are already written to order_status_history
  // by updateOrderStatusWebhook (by = "carrier-sync:<code>"); this log entry
  // records that a human asked for the sync.
  const user = c.get("user");
  await logActivity(
    db,
    user,
    ACTIONS.ORDER_CARRIER_SYNCED,
    { type: "order", id: orderId },
    {
      outcome: detail.outcome,
      from: detail.from,
      to: detail.to ?? detail.from,
      carrierStatus: detail.carrierStatus ?? null,
      companyCode: company.code,
    },
  );

  return c.json(
    {
      success: true,
      data: {
        orderId,
        outcome: detail.outcome,
        from: detail.from,
        to: detail.to ?? detail.from,
        carrierStatus: detail.carrierStatus ?? null,
        companyId: company.id,
        companyCode: company.code,
        runId: run.runId,
      },
    },
    200,
  );
}

/**
 * POST /orders/bulk-sync-carrier
 * Poll the carrier for a selection of orders (or for everything currently due).
 */
export async function bulkSyncCarrierStatus(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const body = ((c.req as any).valid?.("json") ?? (await c.req.json().catch(() => ({})))) as {
    orderIds?: string[];
    companyId?: string;
    force?: boolean;
    limit?: number;
  };

  const orderIds = Array.isArray(body.orderIds) ? body.orderIds.filter((v) => typeof v === "string") : [];
  const limit = Math.min(Math.max(body.limit ?? DEFAULT_SYNC_BATCH_SIZE, 1), DEFAULT_SYNC_BATCH_SIZE);
  const force = body.force === true;

  type CompanyRow = NonNullable<Awaited<ReturnType<typeof getDeliveryCompanyRaw>>>;
  let companies: CompanyRow[];

  if (orderIds.length > 0) {
    // Explicit selection: resolve each order's company so the engine polls only
    // the chosen orders (getOrdersDueForSync takes the id list).
    const rows = await Promise.all(orderIds.map((id) => queries.getOrderById(db, id)));
    const companyIds = [
      ...new Set(
        rows
          .filter((o): o is NonNullable<typeof o> => !!o && !!o.trackingNumber && !!o.companyId)
          .map((o) => o.companyId as string),
      ),
    ];
    companies = [];
    for (const id of companyIds) {
      const company = await getDeliveryCompanyRaw(db, id);
      // An explicit operator request is honoured even when the background sweep
      // would skip the company (auto-sync off) — only credentials are required.
      if (company?.apiToken) companies.push(company);
    }
  } else {
    companies = await getAutoSyncCompanies(db, body.companyId);
  }

  const results: SyncCompanyResult[] = [];
  for (const company of companies) {
    results.push(
      await syncCompanyStatuses(
        db,
        {
          id: company.id,
          code: company.code,
          name: company.name,
          apiToken: company.apiToken,
          apiUserGuid: company.apiUserGuid,
          apiEndpoint: company.apiEndpoint,
          notes: company.notes,
          webhookStatusMapping: company.webhookStatusMapping,
          autoSyncIntervalMin: company.autoSyncIntervalMin,
        },
        {
          trigger: orderIds.length > 0 ? "manual" : "company",
          force,
          limit,
          orderIds: orderIds.length > 0 ? orderIds : undefined,
          onDelivered: makeCapiTrigger(c.env, (p) => c.executionCtx.waitUntil(p)),
        },
      ),
    );
  }

  const details = results.flatMap((run) => run.details);

  const totals = summarize(results);
  const user = c.get("user");
  if (totals.updated > 0) {
    await logActivity(
      db,
      user,
      ACTIONS.ORDER_CARRIER_SYNC_BULK,
      { type: "order", id: "bulk-sync-carrier" },
      { action: "carrier_sync", updated: totals.updated, polled: totals.polled },
    );
  }

  return c.json(
    {
      success: true,
      data: {
        companies: results.map((run) => ({
          companyId: run.companyId,
          companyCode: run.companyCode,
          companyName: run.companyName,
          runId: run.runId,
          ...run.counters,
          unmappedStatuses: run.counters.unmappedStatuses,
          error: run.errorMessage,
        })),
        totals,
        details,
      },
    },
    200,
  );
}
