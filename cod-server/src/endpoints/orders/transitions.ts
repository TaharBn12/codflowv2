/**
 * Order status workflow — the single source of truth for which status may
 * follow which. Imported by the HTTP handler, the AI/MCP tools and the
 * Telegram bot so every surface enforces the same forward-only flow.
 */

import type { OrderStatus } from "../../../../cod-shared/db/schema";
export type { OrderStatus };

export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ["confirmed", "unreachable", "cancelled"],
  confirmed: ["preparing", "unreachable", "cancelled"],
  unreachable: ["confirmed", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["out_for_delivery", "dispatched", "cancelled"],
  assigned: ["out_for_delivery", "dispatched", "cancelled"],
  dispatched: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "returned"],
  delivered: [],
  returned: [],
  cancelled: [],
};

export function allowedNextStatuses(status: string): readonly OrderStatus[] {
  return ALLOWED_TRANSITIONS[status as OrderStatus] ?? [];
}

export function canTransition(from: string, to: string): boolean {
  return allowedNextStatuses(from).includes(to as OrderStatus);
}

/**
 * Statuses a confirmation agent may apply from the bot. Confirmation owns the
 * inbound funnel; it never ships, delivers or returns.
 */
export const CONFIRMATION_STATUSES: readonly OrderStatus[] = ["confirmed", "unreachable", "cancelled"];

/** Statuses that must never be reachable by a non-admin without approval. */
export const SENSITIVE_STATUSES: readonly OrderStatus[] = ["cancelled", "returned"];
