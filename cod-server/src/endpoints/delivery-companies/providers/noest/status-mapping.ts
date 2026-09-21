/**
 * NOEST → CodFlow Status Mapping
 *
 * NOEST has no inbound webhooks (docs/KNOWN_LIMITATIONS.md) — its status can
 * only be read by polling `POST /api/public/get/trackings/info`, whose rows are
 * `{ event_key, event, date }`. `event_key` is the machine-readable slug and is
 * what this mapper consumes (`NoestProvider.getTrackingInfo` puts it in
 * TrackingEvent.activity, falling back to the human-readable `event`).
 *
 * ⚠️ PROVENANCE — read before editing:
 *   The only two NOEST event_keys verified in this repo are "upload" and
 *   "customer_validation" (providers/noest/types.ts). The rest of the
 *   vocabulary below is borrowed from the EcoTrack platform mapper, because
 *   NOEST exposes the same platform endpoint (`get/trackings/info`) with the
 *   same response envelope (`{ <tracking>: { activity: [...] } }`). It is a
 *   best-effort default, NOT a verified NOEST enum.
 *
 *   That is safe by construction: every mapping here is applied only through
 *   updateOrderStatusWebhook's forward-only rank guard, and any string not in
 *   this map returns undefined so the caller logs it as unmapped and leaves the
 *   order untouched (never guess). Unmapped strings surface verbatim in
 *   carrier_sync_runs.unmapped_statuses — extend the table from real data.
 *
 * Per-company overrides live in delivery_companies.webhook_status_mapping as
 * { ourStatus: ["carrier key", ...] } — same format the ZR mapping UI writes,
 * and they win over the defaults.
 */

import type { OrderStatus } from "../../../../../../cod-shared/db/schema";
import { mapEcotrackActivity, mapEcotrackStatus } from "../ecotrack/status-mapping";

const PLATFORM_KEYS: Record<string, OrderStatus> = {
  upload: "dispatched",
  customer_validation: "dispatched",
  validate: "dispatched",
  picked: "dispatched",
  en_livraison: "out_for_delivery",
  dispatched_to_driver: "out_for_delivery",
  attempt_delivery: "out_for_delivery",
  livre: "delivered",
  encaisse: "delivered",
  retour: "returned",
  return_received: "returned",
  annule: "cancelled",
};

/** Normalize a carrier key/status: accent-insensitive, lowercase, separators collapsed. */
export function normalizeCarrierKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s\-]+/g, "_");
}

/**
 * Map a NOEST event key to one of our order statuses.
 *
 * Lookup order: per-company override → NOEST table → EcoTrack platform table.
 * undefined = unmapped (surface raw, never guess).
 */
export function mapNoestStatus(
  eventKey: string | null | undefined,
  custom: Record<string, string[]> | null = null,
): OrderStatus | undefined {
  if (!eventKey) return undefined;
  const normalized = normalizeCarrierKey(eventKey);
  if (!normalized) return undefined;

  if (custom) {
    for (const [ourStatus, keys] of Object.entries(custom)) {
      if (!Array.isArray(keys)) continue;
      if (keys.some((k) => typeof k === "string" && normalizeCarrierKey(k) === normalized)) {
        return ourStatus as OrderStatus;
      }
    }
  }

  if (PLATFORM_KEYS[normalized]) return PLATFORM_KEYS[normalized];

  // EcoTrack activity keys are already normalized slugs; undefined (unknown)
  // and null (known non-status event) both mean "no status change" here.
  const fromActivity = mapEcotrackActivity(normalized);
  if (fromActivity !== undefined) return fromActivity ?? undefined;

  // Some platform rows surface the order-status slug rather than an activity
  // key — accept that vocabulary too before declaring the value unmapped.
  return mapEcotrackStatus(normalized);
}

/** Exported for the drift-guard test. */
export const NOEST_KNOWN_KEYS = Object.keys(PLATFORM_KEYS);
