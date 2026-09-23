/**
 * Duplicate order detection.
 *
 * GET /orders/duplicates → phone numbers that ordered more than once inside a
 * rolling window, with the orders behind each group.
 *
 * Why the merchant cares: a double-submitted form or an impatient shopper turns
 * into two parcels, one refused at the door, and a return fee the merchant pays.
 * Catching it before confirmation is nearly free; catching it after dispatch is
 * not.
 *
 * Visibility follows the rest of the orders API — a confirmer only ever sees the
 * orders assigned to them, and a global duplicate list would expose every other
 * confirmer's queue, so confirmers are refused here rather than shown a
 * half-filtered list.
 */

import { Context } from "hono";
import type { AppContext } from "@/types";
import { getDb } from "@/db";
import * as queries from "./queries";
import * as validation from "./validation";
import { DUPLICATE_WINDOW_HOURS } from "../../../../cod-shared/queries/orders";
import { ERROR_CODES } from "../../../../cod-shared/errors/codes";

export async function listDuplicateOrders(c: Context<AppContext>) {
  const actor = c.get("user");
  if (actor?.role === "confirmer") {
    return c.json(
      {
        success: false,
        error: "Duplicate detection covers every order — confirmers see their own queue only",
        code: ERROR_CODES.PERMISSION_DENIED,
      },
      403,
    );
  }

  const db = getDb(c.env.DB);
  const queryData: any = (c.req as any).valid?.("query");
  const filters: validation.DuplicatesQueryInput =
    queryData ??
    validation.duplicatesQuerySchema.parse({
      windowHours: c.req.query("windowHours"),
      phone: c.req.query("phone"),
      statuses: c.req.query("statuses"),
      limit: c.req.query("limit"),
    });

  const statuses = (filters.statuses ?? "")
    .split(",")
    .map((status) => status.trim())
    .filter((status): status is validation.OrderStatus =>
      (validation.ORDER_STATUSES as readonly string[]).includes(status),
    );

  const windowHours = filters.windowHours ?? DUPLICATE_WINDOW_HOURS;
  const groups = await queries.findDuplicateOrderGroups(db, {
    windowHours,
    phone: filters.phone ?? null,
    statuses: statuses.length ? statuses : undefined,
    limit: filters.limit ?? 50,
  });

  return c.json(
    {
      success: true,
      data: {
        windowHours,
        groups,
        totalGroups: groups.length,
        totalOrders: groups.reduce((sum, group) => sum + group.count, 0),
        /** COD tied up in groups that have not shipped yet — the actionable part. */
        actionableCod: groups
          .filter((group) => !group.shipped)
          .reduce((sum, group) => sum + group.totalCod, 0),
      },
    },
    200,
  );
}
