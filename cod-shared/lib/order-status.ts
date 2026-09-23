/**
 * Order status machine — the single source of truth.
 *
 * The forward-only transition table used to live twice: inline in the server's
 * `PATCH /orders/:id/status` handler and again in the dashboard's order model.
 * Bulk cancel needs the same rule (one rejected order must not abort the batch,
 * but "delivered → cancelled" must still be refused), so the table now lives
 * here and both sides import it.
 *
 * Deliberately dependency-free: the dashboard bundles this into the browser,
 * so it must not drag in drizzle or the schema module.
 *
 * The states mirror the `orders.status` enum in cod-shared/db/schema.ts.
 */

export const ORDER_STATUSES = [
  "new",
  "confirmed",
  "unreachable",
  "preparing",
  "ready",
  "assigned",
  "dispatched",
  "out_for_delivery",
  "delivered",
  "returned",
  "cancelled",
] as const;

export type OrderStatusValue = (typeof ORDER_STATUSES)[number];

/**
 * Forward-only. Two rules shaped it:
 *   • `cancelled` is reachable from every pre-delivery state — the merchant
 *     always needs an out while the parcel is still theirs;
 *   • once a parcel is `out_for_delivery` the carrier owns it, so the only
 *     exits are `delivered` and `returned`. Cancelling in transit would strand
 *     the box and desync the carrier's own state.
 */
export const ALLOWED_ORDER_TRANSITIONS: Record<
  OrderStatusValue,
  OrderStatusValue[]
> = {
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

/** Where an order may go next (empty = terminal). */
export function allowedOrderTransitions(
  from: OrderStatusValue,
): OrderStatusValue[] {
  return ALLOWED_ORDER_TRANSITIONS[from] ?? [];
}

export function canTransitionOrder(
  from: OrderStatusValue,
  to: OrderStatusValue,
): boolean {
  return allowedOrderTransitions(from).includes(to);
}

/** Delivered / returned / cancelled — no further action is possible. */
export function isTerminalOrderStatus(status: OrderStatusValue): boolean {
  return (
    status === "delivered" || status === "returned" || status === "cancelled"
  );
}
