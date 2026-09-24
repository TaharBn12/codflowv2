import { getDb } from "@/db";
import type { Env } from "@/types";
import {
  DEFAULT_SYNC_BATCH_SIZE,
  makeCapiTrigger,
  syncAllCarrierStatuses,
} from "@/endpoints/delivery-companies/providers/auto-sync";

/**
 * Cron: pull order statuses from every delivery company that has auto-sync on.
 *
 * Runs on the worker's single cron tick (wrangler.toml `[triggers]`). Each
 * company is throttled per order by delivery_companies.auto_sync_interval_min,
 * so a tick that fires more often than the interval simply finds nothing due.
 *
 * ctx.waitUntil is applied by the caller — the whole sweep is awaited here so
 * the counters land in carrier_sync_runs before the invocation ends.
 */
export async function syncCarrierStatuses(env: Env, ctx?: ExecutionContext): Promise<void> {
  const db = getDb(env.DB);
  const onDelivered = ctx
    ? makeCapiTrigger(env, (p) => ctx.waitUntil(p))
    : undefined;

  const results = await syncAllCarrierStatuses(db, {
    trigger: "cron",
    limit: DEFAULT_SYNC_BATCH_SIZE,
    onDelivered,
  });

  for (const run of results) {
    const c = run.counters;
    console.log(
      `[cron:carrier-sync] ${run.companyCode}: scanned=${c.scanned} polled=${c.polled} ` +
        `updated=${c.updated} unchanged=${c.unchanged} unmapped=${c.unmapped} errors=${c.errors}` +
        (run.errorMessage ? ` error="${run.errorMessage}"` : ""),
    );
  }

  if (results.length === 0) {
    console.log("[cron:carrier-sync] no company with auto-sync enabled and usable credentials");
  }
}
