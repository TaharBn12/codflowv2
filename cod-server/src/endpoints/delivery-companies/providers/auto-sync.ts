/**
 * Carrier Status Auto-Sync — engine
 *
 * Polls each company's tracking API for shipped, non-terminal orders and
 * applies what the carrier reports through `updateOrderStatusWebhook`, the
 * same forward-only rank guard the inbound Yalidine/ZR webhooks use. Polling
 * is therefore never able to regress an order, and a webhook that arrives
 * after a poll (or vice-versa) is simply a no-op.
 *
 * Why polling at all:
 *   - NOEST and EcoTrack have no inbound webhooks — polling is their only
 *     status source (docs/KNOWN_LIMITATIONS.md).
 *   - Yalidine and ZR Express do have webhooks, but a missed delivery leaves
 *     the order stuck; the poll is the catch-up path.
 *
 * Vocabulary: each provider's tracking history is mapped with the SAME mapper
 * its webhook uses, so a status string is never interpreted two ways:
 *   yalidine   → mapYalidineStatus  (history `status` strings)
 *   zr_express → mapZrStateName     (state-history `newState.name`)
 *   ecotrack   → mapEcotrackActivity(tracking `activity` keys)
 *   noest      → mapNoestStatus     (event_key, EcoTrack-platform derived)
 *
 * Unmapped strings never guess a status: they are stored verbatim on
 * orders.last_carrier_status and collected in carrier_sync_runs so the admin
 * can extend the mapping.
 */

import type { AppDb } from "../../../../../cod-shared/db/client";
import type { OrderStatus } from "../../../../../cod-shared/db/schema";
import { ORDER_STATUSES } from "../../orders/validation";
import { incrementDeliveryAttempts, updateOrderStatusWebhook } from "../../../../../cod-shared/queries/orders";
import { shouldTriggerCapiPurchase, getCapiWorkflowId } from "../../../workflows/capi-helpers";
import { logApiCall } from "./shipments";
import { getProvider, isEcotrackCompany } from "./registry";
import { EcotrackProvider } from "./ecotrack/adapter";
import { reconcileEcotrackOrders, DEFAULT_MAX_PAGES } from "./ecotrack/reconcile";
import type { DeliveryProvider, TrackingEvent } from "./types";
import { mapYalidineStatus } from "../../webhooks/yalidine-status-mapper";
import { mapZrStateName, parseCustomMapping } from "../../webhooks/zr-status-mapper";
import { mapEcotrackActivity } from "./ecotrack/status-mapping";
import { mapNoestStatus } from "./noest/status-mapping";
import {
  createSyncRun,
  emptyCounters,
  finishSyncRun,
  getAutoSyncCompanies,
  getLastSyncRun,
  getOrdersDueForSync,
  recordOrderSync,
  type SyncRunCounters,
  type SyncTrigger,
  type SyncableOrder,
} from "./auto-sync.queries";

const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>(["delivered", "returned", "cancelled"]);

/** Max orders polled per company per run — protects the carrier API quota. */
export const DEFAULT_SYNC_BATCH_SIZE = 100;

export interface CarrierStatusSignal {
  /** Our order status, or null when the carrier string carries no transition. */
  status: OrderStatus | null;
  /** True when the string is a known carrier value (so "no status" ≠ "unmapped"). */
  known: boolean;
  /** True for failed-delivery-attempt events (increments deliveryAttempts). */
  failedAttempt: boolean;
}

function isOrderStatus(value: string | null | undefined): value is OrderStatus {
  return !!value && (ORDER_STATUSES as readonly string[]).includes(value);
}

const NO_SIGNAL: CarrierStatusSignal = { status: null, known: true, failedAttempt: false };
const UNMAPPED: CarrierStatusSignal = { status: null, known: false, failedAttempt: false };

/**
 * Interpret one carrier tracking string for a company.
 * `customMapping` is delivery_companies.webhook_status_mapping — the same
 * override the ZR webhook handler honours.
 */
export function mapCarrierEvent(
  companyCode: string,
  raw: string | null | undefined,
  customMapping: Record<string, string[]> | null,
): CarrierStatusSignal {
  if (!raw || !raw.trim()) return NO_SIGNAL;
  const value = raw.trim();

  if (companyCode === "yalidine") {
    const mapped = mapYalidineStatus(value);
    if (mapped.incrementAttempts) {
      return { status: "out_for_delivery", known: true, failedAttempt: true };
    }
    if (mapped.status && isOrderStatus(mapped.status)) {
      return { status: mapped.status, known: true, failedAttempt: false };
    }
    return mapped.noop ? NO_SIGNAL : UNMAPPED;
  }

  if (companyCode === "zr_express") {
    // ZR state names are tenant-configurable free text: mapZrStateName returns
    // null both for "known but not delivery-relevant" and "unknown", so a miss
    // is treated as a no-op rather than unmapped — the admin's custom mapping
    // is the extension point, and guessing here could move an order wrongly.
    const mapped = mapZrStateName(value, customMapping);
    if (mapped && isOrderStatus(mapped)) {
      return { status: mapped, known: true, failedAttempt: false };
    }
    return NO_SIGNAL;
  }

  if (isEcotrackCompany(companyCode)) {
    const mapped = mapEcotrackActivity(value);
    if (mapped === undefined) return UNMAPPED;
    if (mapped === null) return NO_SIGNAL;
    return { status: mapped, known: true, failedAttempt: false };
  }

  if (companyCode === "noest") {
    const mapped = mapNoestStatus(value, customMapping);
    if (mapped && isOrderStatus(mapped)) {
      return { status: mapped, known: true, failedAttempt: false };
    }
    return UNMAPPED;
  }

  // Provider without a known tracking vocabulary — never guess.
  return UNMAPPED;
}

/** Carrier timestamps are "YYYY-MM-DD HH:mm:ss" (space, not T) or ISO. */
function parseEventDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Newest event wins; events without a parseable date keep their array order. */
export function newestSignal(
  companyCode: string,
  events: TrackingEvent[],
  customMapping: Record<string, string[]> | null,
): { signal: CarrierStatusSignal; raw: string | null; at: number | undefined } {
  let best: { signal: CarrierStatusSignal; raw: string; at?: number; hasDate: boolean } | null = null;

  events.forEach((event, index) => {
    const signal = mapCarrierEvent(companyCode, event.activity, customMapping);
    const at = parseEventDate(event.date);
    const candidate = { signal, raw: event.activity, at, hasDate: at !== undefined };
    // Dated events always beat undated ones; among equals the later (or, for
    // undated rows, the later array position) wins — carriers append history.
    const wins =
      !best ||
      (candidate.hasDate !== best.hasDate
        ? candidate.hasDate
        : (candidate.at ?? index) >= (best.at ?? 0));
    if (wins) best = candidate;
  });

  if (!best) return { signal: NO_SIGNAL, raw: null, at: undefined };
  const chosen = best as { signal: CarrierStatusSignal; raw: string; at?: number; hasDate: boolean };
  return { signal: chosen.signal, raw: chosen.raw, at: chosen.at };
}

/**
 * Does the carrier report a delivery failure the merchant has not seen yet?
 * Only events newer than the previous poll count, so re-reading the full
 * history can never inflate orders.deliveryAttempts twice.
 */
function hasNewFailedAttempt(
  companyCode: string,
  events: TrackingEvent[],
  customMapping: Record<string, string[]> | null,
  previousSyncAt: string | null,
): boolean {
  const cutoff = previousSyncAt ? Date.parse(previousSyncAt) : undefined;
  return events.some((event) => {
    const signal = mapCarrierEvent(companyCode, event.activity, customMapping);
    if (!signal.failedAttempt) return false;
    const at = parseEventDate(event.date);
    if (cutoff === undefined || Number.isNaN(cutoff)) return true;
    return at === undefined ? true : at > cutoff;
  });
}

export interface CapiTriggerFn {
  (params: { orderId: string; stage: "delivered"; triggerStatus: string; wilayaId: number | null }): void;
}

export interface SyncCompanyOptions {
  trigger: SyncTrigger;
  /** Bypass the per-order interval (manual "sync now"). */
  force?: boolean;
  limit?: number;
  /** Restrict the run to an explicit order selection (bulk "sync these"). */
  orderIds?: string[];
  /**
   * Provider factory override — production uses the registry, tests inject a
   * fake so no carrier HTTP call happens. Same adapter contract either way.
   */
  createProvider?: (company: Parameters<typeof getProvider>[0]) => DeliveryProvider;
  /** Optional hook so the caller can fire the Meta CAPI workflow on delivery. */
  onDelivered?: CapiTriggerFn;
}

export interface SyncCompanyResult {
  runId: string;
  companyId: string;
  companyCode: string;
  companyName: string;
  counters: SyncRunCounters;
  errorMessage: string | null;
  /** Per-order detail for the manual endpoints (bounded by the batch size). */
  details: Array<{
    orderId: string;
    orderNumber: string;
    trackingNumber: string;
    outcome: "updated" | "unchanged" | "unmapped" | "error";
    from: OrderStatus;
    to?: OrderStatus;
    carrierStatus?: string | null;
    error?: string;
  }>;
}

/** Poll one company's shipped orders and apply what the carrier reports. */
export async function syncCompanyStatuses(
  db: AppDb,
  company: {
    id: string;
    code: string;
    name: string;
    apiToken: string | null;
    apiUserGuid: string | null;
    apiEndpoint: string | null;
    notes?: string | null;
    webhookStatusMapping?: string | null;
    autoSyncIntervalMin?: number | null;
  },
  options: SyncCompanyOptions,
): Promise<SyncCompanyResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const counters = emptyCounters();
  const details: SyncCompanyResult["details"] = [];

  await createSyncRun(db, {
    id: runId,
    companyId: company.id,
    trigger: options.trigger,
    startedAt,
  });

  const intervalMin = Math.max(1, company.autoSyncIntervalMin ?? 30);
  const customMapping = parseCustomMapping(company.webhookStatusMapping ?? null);

  let provider: DeliveryProvider;
  try {
    provider = options.createProvider
      ? options.createProvider(company)
      : getProvider(company);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishSyncRun(db, runId, {
      counters,
      errorMessage: message,
      finishedAt: new Date().toISOString(),
    });
    return {
      runId,
      companyId: company.id,
      companyCode: company.code,
      companyName: company.name,
      counters,
      errorMessage: message,
      details,
    };
  }

  // EcoTrack-family carriers expose an order-list endpoint: one call refreshes
  // ~40 orders, so list reconciliation is far cheaper than one tracking call
  // per order. It stays inside the same forward-only rank guard, and CAPI fires
  // through the onApplied hook. An explicit order selection can't be expressed
  // against the list endpoint, so those runs fall through to per-order polling.
  if (
    isEcotrackCompany(company.code) &&
    provider instanceof EcotrackProvider &&
    typeof (provider as EcotrackProvider).getOrders === "function" &&
    !options.orderIds?.length
  ) {
    const lastRun = await getLastSyncRun(db, company.id);
    const dueForRun =
      options.force === true ||
      !lastRun?.startedAt ||
      Date.now() - Date.parse(lastRun.startedAt) >= intervalMin * 60_000;

    if (dueForRun) {
      try {
        const summary = await reconcileEcotrackOrders(db, provider, company.code, {
          maxPages: DEFAULT_MAX_PAGES,
          onApplied: (order, newStatus) => {
            if (options.onDelivered && shouldTriggerCapiPurchase(newStatus, order.wilayaId)) {
              options.onDelivered({
                orderId: order.id,
                stage: "delivered",
                triggerStatus: newStatus,
                wilayaId: order.wilayaId,
              });
            }
          },
        });

        counters.scanned = summary.ordersSeen;
        counters.polled = summary.ordersSeen;
        counters.updated = summary.updated;
        counters.unchanged = summary.unchanged + summary.notFound;
        counters.unmapped = summary.skippedUnmapped;
        counters.unmappedStatuses = summary.unmappedSamples;

        await finishSyncRun(db, runId, {
          counters,
          finishedAt: new Date().toISOString(),
          mode: "reconcile",
        });

        return {
          runId,
          companyId: company.id,
          companyCode: company.code,
          companyName: company.name,
          counters,
          errorMessage: null,
          details,
        };
      } catch (err) {
        // List reconciliation failed — fall through to per-order polling so the
        // run still refreshes what it can.
        console.error(`[carrier-sync] ${company.code} reconcile failed, falling back to polling:`, err);
      }
    }
  }

  const canPoll = typeof provider.getTrackingInfo === "function";
  const ordersDue = canPoll
    ? await getOrdersDueForSync(db, {
        companyId: company.id,
        intervalMin,
        limit: options.limit ?? DEFAULT_SYNC_BATCH_SIZE,
        force: options.force,
        orderIds: options.orderIds,
      })
    : [];

  counters.scanned = ordersDue.length;

  if (!canPoll) {
    await finishSyncRun(db, runId, {
      counters,
      errorMessage: `${company.code}: provider does not expose tracking history`,
      finishedAt: new Date().toISOString(),
    });
    return {
      runId,
      companyId: company.id,
      companyCode: company.code,
      companyName: company.name,
      counters,
      errorMessage: `${company.code}: provider does not expose tracking history`,
      details,
    };
  }

  for (const order of ordersDue) {
    const startedCall = Date.now();
    try {
      const events = (await provider.getTrackingInfo!(order.trackingNumber)) ?? [];

      await logApiCall(db, {
        companyId: company.id,
        orderId: order.id,
        action: "carrier_sync",
        method: "GET",
        endpoint: `tracking:${order.trackingNumber}`,
        httpStatus: 200,
        responseBody: { events: events.length },
        success: true,
        durationMs: Date.now() - startedCall,
      });

      counters.polled += 1;

      const { signal, raw } = newestSignal(company.code, events, customMapping);
      const at = new Date().toISOString();

      if (hasNewFailedAttempt(company.code, events, customMapping, order.lastTrackingSyncAt)) {
        await incrementDeliveryAttempts(db, order.id);
      }

      if (!signal.known) {
        counters.unmapped += 1;
        if (raw && !counters.unmappedStatuses.includes(raw)) counters.unmappedStatuses.push(raw);
        await recordOrderSync(db, order.id, { rawStatus: raw, failed: false, at });
        details.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          trackingNumber: order.trackingNumber,
          outcome: "unmapped",
          from: order.status,
          carrierStatus: raw,
        });
        continue;
      }

      let updated = false;
      if (signal.status && !TERMINAL_ORDER_STATUSES.has(order.status)) {
        const result = await updateOrderStatusWebhook(db, order.id, signal.status, `carrier-sync:${company.code}`);
        updated = result.updated;
        if (updated && options.onDelivered && shouldTriggerCapiPurchase(signal.status, order.wilayaId)) {
          options.onDelivered({
            orderId: order.id,
            stage: "delivered",
            triggerStatus: signal.status,
            wilayaId: order.wilayaId,
          });
        }
      }

      await recordOrderSync(db, order.id, { rawStatus: raw, failed: false, at });

      if (updated && signal.status) {
        counters.updated += 1;
        details.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          trackingNumber: order.trackingNumber,
          outcome: "updated",
          from: order.status,
          to: signal.status,
          carrierStatus: raw,
        });
      } else {
        counters.unchanged += 1;
        details.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          trackingNumber: order.trackingNumber,
          outcome: "unchanged",
          from: order.status,
          carrierStatus: raw,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      counters.errors += 1;
      await recordOrderSync(db, order.id, {
        rawStatus: order.lastCarrierStatus,
        failed: true,
        at: new Date().toISOString(),
      });
      await logApiCall(db, {
        companyId: company.id,
        orderId: order.id,
        action: "carrier_sync",
        method: "GET",
        endpoint: `tracking:${order.trackingNumber}`,
        success: false,
        errorMessage: message,
        durationMs: Date.now() - startedCall,
      });
      details.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        trackingNumber: order.trackingNumber,
        outcome: "error",
        from: order.status,
        error: message,
      });
    }
  }

  await finishSyncRun(db, runId, {
    counters,
    finishedAt: new Date().toISOString(),
  });

  return {
    runId,
    companyId: company.id,
    companyCode: company.code,
    companyName: company.name,
    counters,
    errorMessage: null,
    details,
  };
}

export interface SyncAllOptions extends SyncCompanyOptions {
  /** Restrict the run to a single company (per-company "sync now"). */
  companyId?: string;
}

/**
 * Poll every eligible company. Used by the cron trigger and the manual
 * endpoints. One company failing never aborts the others — the failure is
 * recorded on that company's run row.
 */
export async function syncAllCarrierStatuses(
  db: AppDb,
  options: SyncAllOptions,
): Promise<SyncCompanyResult[]> {
  const companies = await getAutoSyncCompanies(db, options.companyId);
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
        options,
      ),
    );
  }

  return results;
}

/** Build the CAPI trigger from a Worker env + execution context. */
export function makeCapiTrigger(
  env: { CAPI_WORKFLOW?: { create(params: { id: string; params: Record<string, unknown> }): Promise<unknown> } },
  waitUntil: (promise: Promise<unknown>) => void,
): CapiTriggerFn {
  return ({ orderId, stage, triggerStatus, wilayaId }) => {
    if (!env.CAPI_WORKFLOW) {
      console.error("[capi-workflow] CAPI_WORKFLOW binding is undefined — worker needs re-provision");
      return;
    }
    waitUntil(
      env.CAPI_WORKFLOW.create({
        id: getCapiWorkflowId(orderId, stage, "Purchase"),
        params: {
          orderId,
          eventName: "Purchase",
          stage,
          triggeredAt: Math.floor(Date.now() / 1000),
          triggerStatus,
          wilayaId,
          source: "carrier-sync",
        },
      }).catch((err: unknown) =>
        console.error("[capi-workflow] carrier-sync trigger failed:", (err as Error)?.message),
      ),
    );
  };
}
