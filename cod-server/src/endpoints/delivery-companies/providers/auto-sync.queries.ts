/**
 * Carrier Status Auto-Sync — queries
 *
 * Selection + bookkeeping for the polling engine (see auto-sync.ts). Kept
 * separate so the engine stays a pure orchestrator and the SQL is testable
 * against real D1.
 */

import { and, desc, eq, getTableColumns, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { carrierSyncRuns, deliveryCompanies, orders } from "../../../../../cod-shared/db/schema";
import type { OrderStatus } from "../../../../../cod-shared/db/schema";
import type { AppDb } from "../../../../../cod-shared/db/client";

export type SyncTrigger = "cron" | "manual" | "company";

/** Order rows the engine is allowed to poll: shipped, non-terminal, throttled. */
export interface SyncableOrder {
  id: string;
  orderNumber: string;
  trackingNumber: string;
  companyId: string;
  status: OrderStatus;
  wilayaId: number | null;
  lastTrackingSyncAt: string | null;
  lastCarrierStatus: string | null;
  trackingSyncFails: number;
}

export interface SyncRunCounters {
  scanned: number;
  polled: number;
  updated: number;
  unchanged: number;
  unmapped: number;
  errors: number;
  unmappedStatuses: string[];
}

export function emptyCounters(): SyncRunCounters {
  return {
    scanned: 0,
    polled: 0,
    updated: 0,
    unchanged: 0,
    unmapped: 0,
    errors: 0,
    unmappedStatuses: [],
  };
}

/**
 * Active companies eligible for polling.
 *
 * A company is eligible when it is active, auto-sync is on, and it has the
 * credentials the registry needs (apiToken — plus apiUserGuid for the
 * providers that require it). Filtering here keeps a half-configured company
 * out of the run instead of throwing once per order.
 */
export async function getAutoSyncCompanies(db: AppDb, companyId?: string) {
  const conditions = [
    eq(deliveryCompanies.active, true),
    eq(deliveryCompanies.autoSyncEnabled, true),
  ];
  if (companyId) conditions.push(eq(deliveryCompanies.id, companyId));

  const rows = await db
    .select()
    .from(deliveryCompanies)
    .where(and(...conditions))
    .all();

  return rows.filter((c) => {
    if (!c.apiToken) return false;
    if ((c.code === "noest" || c.code === "zr_express") && !c.apiUserGuid) return false;
    if (c.code === "yalidine" && !c.apiUserGuid) return false;
    if ((c.code === "ecotrack" || c.code.endsWith("_ecotrack")) && !c.apiEndpoint) return false;
    return true;
  });
}

/**
 * Orders due for a poll: shipped at this company, not terminal, and either
 * never synced or last synced more than `intervalMin` minutes ago.
 *
 * Terminal orders are excluded by status — the carrier has nothing left to
 * tell us about them. `maxFails` caps the backoff so a tracking number the
 * carrier does not know stops burning API quota.
 */
export async function getOrdersDueForSync(
  db: AppDb,
  opts: {
    companyId: string;
    intervalMin: number;
    limit: number;
    maxFails?: number;
    force?: boolean;
    /** Restrict to an explicit order selection (bulk "sync these"). */
    orderIds?: string[];
  },
): Promise<SyncableOrder[]> {
  const { companyId, intervalMin, limit, maxFails = 10, force = false, orderIds } = opts;

  const conditions = [
    eq(orders.companyId, companyId),
    ne(orders.trackingNumber, ""),
    sql`${orders.trackingNumber} IS NOT NULL`,
    sql`${orders.status} NOT IN ('delivered', 'returned', 'cancelled')`,
  ];

  // An explicit selection is an operator decision: ignore the failure backoff
  // (they are retrying on purpose) but keep the terminal-status guard.
  if (orderIds && orderIds.length > 0) {
    conditions.push(inArray(orders.id, orderIds));
  } else {
    conditions.push(sql`${orders.trackingSyncFails} < ${maxFails}`);
  }

  if (!force) {
    const cutoff = new Date(Date.now() - intervalMin * 60_000).toISOString();
    conditions.push(or(isNull(orders.lastTrackingSyncAt), lt(orders.lastTrackingSyncAt, cutoff))!);
  }

  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      trackingNumber: orders.trackingNumber,
      companyId: orders.companyId,
      status: orders.status,
      wilayaId: orders.wilayaId,
      lastTrackingSyncAt: orders.lastTrackingSyncAt,
      lastCarrierStatus: orders.lastCarrierStatus,
      trackingSyncFails: orders.trackingSyncFails,
    })
    .from(orders)
    .where(and(...conditions))
    .orderBy(orders.lastTrackingSyncAt)
    .limit(limit)
    .all();

  return rows.map((r) => ({
    ...r,
    trackingNumber: r.trackingNumber as string,
    companyId: r.companyId as string,
    status: r.status as OrderStatus,
  }));
}

/** Write the per-order sync outcome (throttle cursor + failure counter). */
export async function recordOrderSync(
  db: AppDb,
  orderId: string,
  result: { rawStatus: string | null; failed: boolean; at: string },
): Promise<void> {
  await db
    .update(orders)
    .set({
      lastTrackingSyncAt: result.at,
      lastCarrierStatus: result.rawStatus,
      trackingSyncFails: result.failed
        ? sql`${orders.trackingSyncFails} + 1`
        : 0,
    })
    .where(eq(orders.id, orderId));
}

export interface SyncRunRecord {
  id: string;
  companyId: string;
  trigger: SyncTrigger;
  mode?: "poll" | "reconcile";
  startedAt: string;
  scanned?: number;
  polled?: number;
  updated?: number;
  unchanged?: number;
  unmapped?: number;
  errors?: number;
  unmappedStatuses?: string[] | null;
  errorMessage?: string | null;
}

export async function createSyncRun(db: AppDb, run: SyncRunRecord): Promise<string> {
  await db.insert(carrierSyncRuns).values({
    id: run.id,
    companyId: run.companyId,
    trigger: run.trigger,
    mode: run.mode ?? "poll",
    startedAt: run.startedAt,
    finishedAt: null,
    scanned: run.scanned ?? 0,
    polled: run.polled ?? 0,
    updated: run.updated ?? 0,
    unchanged: run.unchanged ?? 0,
    unmapped: run.unmapped ?? 0,
    errors: run.errors ?? 0,
    unmappedStatuses: run.unmappedStatuses ? JSON.stringify(run.unmappedStatuses) : null,
    errorMessage: run.errorMessage ?? null,
  });
  return run.id;
}

export async function finishSyncRun(
  db: AppDb,
  runId: string,
  result: {
    counters: SyncRunCounters;
    errorMessage?: string | null;
    finishedAt: string;
    mode?: "poll" | "reconcile";
  },
): Promise<void> {
  const { counters, errorMessage, finishedAt, mode } = result;
  await db
    .update(carrierSyncRuns)
    .set({
      ...(mode ? { mode } : {}),
      finishedAt,
      scanned: counters.scanned,
      polled: counters.polled,
      updated: counters.updated,
      unchanged: counters.unchanged,
      unmapped: counters.unmapped,
      errors: counters.errors,
      unmappedStatuses: counters.unmappedStatuses.length
        ? JSON.stringify(counters.unmappedStatuses.slice(0, 25))
        : null,
      errorMessage: errorMessage ?? null,
    })
    .where(eq(carrierSyncRuns.id, runId));
}

/** The company's most recent run — used to throttle list-based reconciliations. */
export async function getLastSyncRun(db: AppDb, companyId: string) {
  return await db
    .select()
    .from(carrierSyncRuns)
    .where(eq(carrierSyncRuns.companyId, companyId))
    .orderBy(desc(carrierSyncRuns.startedAt))
    .limit(1)
    .get();
}

/** Newest runs, newest first — the dashboard's sync history panel. */
export async function listSyncRuns(db: AppDb, opts: { companyId?: string; limit?: number } = {}) {
  const conditions = opts.companyId ? [eq(carrierSyncRuns.companyId, opts.companyId)] : [];
  const rows = await db
    .select({
      ...getTableColumns(carrierSyncRuns),
      companyName: deliveryCompanies.name,
      companyCode: deliveryCompanies.code,
    })
    .from(carrierSyncRuns)
    .leftJoin(deliveryCompanies, eq(carrierSyncRuns.companyId, deliveryCompanies.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(carrierSyncRuns.startedAt))
    .limit(opts.limit ?? 30)
    .all();

  return rows;
}
