/**
 * Bulk order mutations — cancel and delete.
 *
 * The orders list already had bulk assign and bulk dispatch; cancelling and
 * deleting were the two actions a merchant still had to click through one row
 * at a time (a doubled-up courier pickup can be 40 orders).
 *
 * Shape of both endpoints:
 *   • one light read for the whole batch (id, orderNumber, status) so a
 *     not-found id is reported instead of silently ignored;
 *   • the existing single-order query per row, because that is where the state
 *     machine, the stock restore and the driver/commission reversals live —
 *     reimplementing them here is how money goes missing;
 *   • one activity row per batch with the tally, not one per order;
 *   • a per-row result list, so a partial run is never silent.
 *
 * A rejected row never aborts the batch: HTTP 200 with `failed > 0` is the
 * honest answer to "cancel these 40" when three of them already shipped.
 */

import { Context } from "hono";
import type { AppContext } from "@/types";
import { getDb } from "@/db";
import { orders } from "@/db/schema";
import { inArray } from "drizzle-orm";
import * as queries from "./queries";
import * as validation from "./validation";
import { logActivity, ACTIONS } from "@/lib/activity";
import { canTransitionOrder } from "../../../../cod-shared/lib/order-status";
import { ERROR_CODES } from "../../../../cod-shared/errors/codes";

export interface BulkRowResult {
  orderId: string;
  orderNumber: string | null;
  ok: boolean;
  /** "cancelled" | "deleted" when ok, else the reason it was not. */
  outcome: "cancelled" | "deleted" | "not_found" | "invalid_transition" | "error";
  /** Current status when the transition was refused. */
  status?: string;
  error?: string;
  code?: string;
}

export interface BulkTotals {
  requested: number;
  ok: number;
  skipped: number;
  failed: number;
}

function tally(results: BulkRowResult[]): BulkTotals {
  return {
    requested: results.length,
    ok: results.filter((row) => row.ok).length,
    skipped: results.filter(
      (row) => !row.ok && (row.outcome === "not_found" || row.outcome === "invalid_transition"),
    ).length,
    failed: results.filter((row) => !row.ok && row.outcome === "error").length,
  };
}

/** Load just enough of each order to validate it — no lines, no history. */
async function loadBatch(
  db: ReturnType<typeof getDb>,
  orderIds: string[],
): Promise<Map<string, { id: string; orderNumber: string; status: string }>> {
  const unique = [...new Set(orderIds)];
  const rows = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
    .from(orders)
    .where(inArray(orders.id, unique))
    .all();
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * POST /orders/bulk-cancel
 * Cancel every selected order the state machine allows.
 */
export async function bulkCancelOrders(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const bodyData: any = (c.req as any).valid?.("json");
  const validated: validation.BulkCancelInput =
    bodyData ?? validation.bulkCancelSchema.parse(await c.req.json());

  const actor = c.get("user");
  const found = await loadBatch(db, validated.orderIds);
  const results: BulkRowResult[] = [];

  for (const orderId of new Set(validated.orderIds)) {
    const order = found.get(orderId);
    if (!order) {
      results.push({
        orderId,
        orderNumber: null,
        ok: false,
        outcome: "not_found",
        error: "Order not found",
        code: ERROR_CODES.ORDER_NOT_FOUND,
      });
      continue;
    }
    if (!canTransitionOrder(order.status as never, "cancelled")) {
      results.push({
        orderId,
        orderNumber: order.orderNumber,
        ok: false,
        outcome: "invalid_transition",
        status: order.status,
        error: `Cannot cancel an order that is "${order.status}"`,
        code: ERROR_CODES.INVALID_STATUS_TRANSITION,
      });
      continue;
    }
    try {
      await queries.updateOrderStatus(
        db,
        orderId,
        "cancelled",
        actor?.id,
        actor?.name ?? undefined,
      );
      results.push({ orderId, orderNumber: order.orderNumber, ok: true, outcome: "cancelled" });
    } catch (err) {
      results.push({
        orderId,
        orderNumber: order.orderNumber,
        ok: false,
        outcome: "error",
        status: order.status,
        error: err instanceof Error ? err.message : String(err),
        code: ERROR_CODES.INTERNAL_SERVER_ERROR,
      });
    }
  }

  const totals = tally(results);
  if (totals.ok > 0) {
    await logActivity(
      db,
      actor,
      ACTIONS.ORDER_CANCELLED_BULK,
      { type: "order", id: "bulk-cancel", label: `${totals.ok} orders` },
      {
        cancelled: totals.ok,
        skipped: totals.skipped,
        failed: totals.failed,
        reason: validated.reason ?? null,
        orderIds: results.filter((row) => row.ok).map((row) => row.orderId),
      },
    );
  }

  return c.json({ success: true, data: { totals, results } }, 200);
}

/**
 * POST /orders/bulk-delete
 * Permanently delete every selected order (lines, shipments, history cascade).
 */
export async function bulkDeleteOrders(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const bodyData: any = (c.req as any).valid?.("json");
  const validated: validation.BulkDeleteInput =
    bodyData ?? validation.bulkDeleteSchema.parse(await c.req.json());

  const actor = c.get("user");
  const found = await loadBatch(db, validated.orderIds);
  const results: BulkRowResult[] = [];

  for (const orderId of new Set(validated.orderIds)) {
    const order = found.get(orderId);
    if (!order) {
      results.push({
        orderId,
        orderNumber: null,
        ok: false,
        outcome: "not_found",
        error: "Order not found",
        code: ERROR_CODES.ORDER_NOT_FOUND,
      });
      continue;
    }
    try {
      // Same query the single-order DELETE uses: customer counters, driver
      // credit and inventory all get reversed inside it.
      await queries.deleteOrder(db, orderId);
      await logActivity(db, actor, ACTIONS.ORDER_DELETED, {
        type: "order",
        id: orderId,
        label: order.orderNumber,
      }, { via: "bulk" });
      results.push({ orderId, orderNumber: order.orderNumber, ok: true, outcome: "deleted" });
    } catch (err) {
      results.push({
        orderId,
        orderNumber: order.orderNumber,
        ok: false,
        outcome: "error",
        status: order.status,
        error: err instanceof Error ? err.message : String(err),
        code: ERROR_CODES.INTERNAL_SERVER_ERROR,
      });
    }
  }

  const totals = tally(results);
  if (totals.ok > 0) {
    await logActivity(
      db,
      actor,
      ACTIONS.ORDER_DELETED_BULK,
      { type: "order", id: "bulk-delete", label: `${totals.ok} orders` },
      {
        deleted: totals.ok,
        skipped: totals.skipped,
        failed: totals.failed,
        orderIds: results.filter((row) => row.ok).map((row) => row.orderId),
      },
    );
  }

  return c.json({ success: true, data: { totals, results } }, 200);
}
