/**
 * Orders Queries
 *
 * Centralized database operations for orders management.
 */

import type { AppDb } from "../db/client";
import {
  orders,
  orderProducts,
  orderStatusHistory,
  customers,
  productVariants,
  products,
  drivers,
  driverCompensations,
  users,
  operationAgentSettings,
  operationAutomationSettings,
  orderConfirmationAssignments,
  operationTasks,
  staffCommissions,
  wilayas,
  communes,
  stockMovements,
  companyShipments,
  companyApiLogs,
  webhookEvents,
} from "../db/schema";
import type { OrderStatus } from "../db/schema";
import {
  eq,
  desc,
  and,
  like,
  or,
  sql,
  inArray,
  getTableColumns,
  aliasedTable,
} from "drizzle-orm";

const driversAlias = aliasedTable(drivers, "d");

import { safeLikeTerm } from "./search";
import {
  blacklistReasonSubselect,
  blacklistedFlag,
  findActiveBlacklistEntry,
  recordBlacklistHit,
} from "./blacklist";
import { toLocalAlgerianMobile } from "../lib/phone";

/**
 * How far back two orders may be placed and still count as "the same customer
 * ordering twice". 48h is the Algerian COD reality: a shopper who re-orders the
 * next day usually means it, one who places five orders in an afternoon does
 * not — and a parcel already in the carrier's hands cannot be merged anyway.
 */
export const DUPLICATE_WINDOW_HOURS = 48;

export interface OrderFilters {
  status?: (typeof orders.$inferSelect)["status"] | "all";
  wilayaId?: number;
  search?: string;
  limit?: number;
  offset?: number;
  /**
   * Opaque keyset cursor (encodeOrderCursor output): return rows strictly
   * before (createdAt, id). Takes precedence over offset when set.
   */
  cursor?: string;
  confirmationAssignment?: "assigned" | "unassigned" | "all";
  confirmerId?: string;
  /** Only rows with at least one other order on the same phone in the window. */
  duplicatesOnly?: boolean;
  /** Rolling window for duplicate detection. Defaults to 48h. */
  duplicateWindowHours?: number;
}

export function encodeOrderCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function parseOrderCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(b64);
    const sep = decoded.lastIndexOf("|");
    if (sep <= 0) return null;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!id) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(createdAt)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Get all orders with optional filtering.
 * Joins wilayas + communes to return Arabic display names.
 */
export async function getAllOrders(db: AppDb, filters: OrderFilters = {}) {
  const conditions = [];

  if (filters.status && filters.status !== "all") {
    conditions.push(eq(orders.status, filters.status));
  }

  if (filters.wilayaId) {
    conditions.push(eq(orders.wilayaId, filters.wilayaId));
  }

  if (filters.confirmerId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM order_confirmation_assignments ca WHERE ca.order_id = ${orders.id} AND ca.assignee_id = ${filters.confirmerId})`);
  } else if (filters.confirmationAssignment === "assigned") {
    conditions.push(sql`EXISTS (SELECT 1 FROM order_confirmation_assignments ca WHERE ca.order_id = ${orders.id})`);
  } else if (filters.confirmationAssignment === "unassigned") {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM order_confirmation_assignments ca WHERE ca.order_id = ${orders.id})`);
  }

  if (filters.search) {
    const term = `%${safeLikeTerm(filters.search)}%`;
    conditions.push(
      or(
        like(orders.orderNumber, term),
        like(orders.customerName, term),
        like(orders.phone, term),
      ),
    );
  }

  // ISO strings compare lexicographically, so a JS-computed cutoff needs no
  // date arithmetic in SQL and still uses idx_orders_phone_created.
  const windowHours = filters.duplicateWindowHours ?? DUPLICATE_WINDOW_HOURS;
  const duplicateCutoff = new Date(
    Date.now() - Math.max(1, windowHours) * 3_600_000,
  ).toISOString();

  if (filters.duplicatesOnly) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM orders dup WHERE dup.phone = ${orders.phone} AND dup.id <> ${orders.id} AND dup.created_at >= ${duplicateCutoff})`,
    );
  }

  let offset = filters.offset ?? 0;
  if (filters.cursor) {
    const after = parseOrderCursor(filters.cursor);
    if (after) {
      conditions.push(
        sql`(orders.created_at, orders.id) < (${after.createdAt}, ${after.id})`,
      );
      offset = 0;
    }
  }

  return db
    .select({
      ...getTableColumns(orders),
      wilaya: wilayas.nameAr,
      commune: communes.nameAr,
      driverName: sql<
        string | null
      >`CASE WHEN ${driversAlias.firstName} IS NOT NULL THEN ${driversAlias.firstName} || ' ' || ${driversAlias.lastName} ELSE NULL END`,
      hasReview: sql<number>`EXISTS (SELECT 1 FROM reviews WHERE reviews.order_id = orders.id)`,
      lastUpdatedBy: sql<
        string | null
      >`(SELECT by FROM order_status_history WHERE order_id = orders.id ORDER BY timestamp DESC LIMIT 1)`,
      confirmationAssigneeId: sql<string | null>`(SELECT assignee_id FROM order_confirmation_assignments WHERE order_id = orders.id LIMIT 1)`,
      confirmationAssigneeName: sql<string | null>`(SELECT u.name FROM order_confirmation_assignments ca JOIN users u ON u.id = ca.assignee_id WHERE ca.order_id = orders.id LIMIT 1)`,
      // ── Risk signals, derived per row (all index-backed lookups) ──────────
      // Blacklist membership is looked up rather than stored on the order, so
      // lifting a ban un-flags the customer's whole history immediately.
      blacklisted: blacklistedFlag(orders.phone),
      blacklistReason: blacklistReasonSubselect(orders.phone),
      // How many OTHER orders share this phone inside the rolling window —
      // 1 means "there is a twin", which is what the row badge shows.
      duplicateCount: sql<number>`(SELECT COUNT(*) FROM orders dup WHERE dup.phone = ${orders.phone} AND dup.id <> ${orders.id} AND dup.created_at >= ${duplicateCutoff})`,
    })
    .from(orders)
    .leftJoin(wilayas, eq(orders.wilayaId, wilayas.id))
    .leftJoin(communes, eq(orders.communeId, communes.id))
    .leftJoin(driversAlias, eq(orders.driverId, driversAlias.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(filters.limit ?? 50)
    .offset(offset)
    .all();
}

export async function getOrderById(db: AppDb, orderId: string) {
  const detailDuplicateCutoff = new Date(
    Date.now() - DUPLICATE_WINDOW_HOURS * 3_600_000,
  ).toISOString();
  const order = await db
    .select({
      ...getTableColumns(orders),
      wilaya: wilayas.nameAr,
      commune: communes.nameAr,
      driverName: sql<
        string | null
      >`CASE WHEN ${driversAlias.firstName} IS NOT NULL THEN ${driversAlias.firstName} || ' ' || ${driversAlias.lastName} ELSE NULL END`,
      labelUrl: companyShipments.labelUrl,
      confirmationAssigneeId: sql<string | null>`(SELECT assignee_id FROM order_confirmation_assignments WHERE order_id = orders.id LIMIT 1)`,
      confirmationAssigneeName: sql<string | null>`(SELECT u.name FROM order_confirmation_assignments ca JOIN users u ON u.id = ca.assignee_id WHERE ca.order_id = orders.id LIMIT 1)`,
      // Same derived risk signals as the list row — the detail page shows the
      // ban banner and the "N other orders on this number" link.
      blacklisted: blacklistedFlag(orders.phone),
      blacklistReason: blacklistReasonSubselect(orders.phone),
      duplicateCount: sql<number>`(SELECT COUNT(*) FROM orders dup WHERE dup.phone = ${orders.phone} AND dup.id <> ${orders.id} AND dup.created_at >= ${detailDuplicateCutoff})`,
    })
    .from(orders)
    .leftJoin(wilayas, eq(orders.wilayaId, wilayas.id))
    .leftJoin(communes, eq(orders.communeId, communes.id))
    .leftJoin(driversAlias, eq(orders.driverId, driversAlias.id))
    .leftJoin(companyShipments, eq(companyShipments.orderId, orders.id))
    .where(eq(orders.id, orderId))
    .get();

  if (!order) return null;

  const [orderProductsList, historyRows] = await db.batch([
    db.select().from(orderProducts).where(eq(orderProducts.orderId, orderId)),
    db
      .select({
        id: orderStatusHistory.id,
        orderId: orderStatusHistory.orderId,
        status: orderStatusHistory.status,
        timestamp: orderStatusHistory.timestamp,
        by: orderStatusHistory.by,
        byName: users.name,
      })
      .from(orderStatusHistory)
      .leftJoin(users, eq(orderStatusHistory.by, users.id))
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(desc(orderStatusHistory.timestamp)),
  ]);

  return {
    ...order,
    products: orderProductsList,
    statusHistory: historyRows.map((h) => ({
      id: h.id,
      orderId: h.orderId,
      status: h.status,
      timestamp: h.timestamp,
      by: h.by,
      byName: h.byName ?? null,
    })),
  };
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

export interface DuplicateGroupOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  createdAt: string;
  customerName: string;
  price: number;
  deliveryFee: number;
  wilaya: string | null;
  commune: string | null;
  /** First line's product — enough to tell "re-order" from "same basket twice". */
  productName: string | null;
  trackingNumber: string | null;
}

export interface DuplicateGroup {
  phone: string;
  count: number;
  /** Every order in the group carries the same first product. */
  sameProduct: boolean;
  /** At least one order already left for the customer — merging is too late. */
  shipped: boolean;
  /** Total COD at risk if the whole group turns out to be one real order. */
  totalCod: number;
  lastCreatedAt: string;
  orders: DuplicateGroupOrder[];
}

/**
 * Orders placed twice by the same number inside a rolling window.
 *
 * Grouping is on the exact stored phone: both write paths (storefront and
 * dashboard) validate into the canonical local form `0[567]XXXXXXXX`, so no
 * normalization is needed in SQL and `idx_orders_phone_created` covers the
 * scan. Two queries regardless of group count — the groups, then their members.
 *
 * `sameProduct` separates the two very different cases a merchant faces: the
 * same basket ordered twice is almost always an accidental double submit (cancel
 * one), while different products on the same number is a family sharing a phone
 * (leave both alone).
 */
export async function findDuplicateOrderGroups(
  db: AppDb,
  opts: {
    windowHours?: number;
    /** Restrict to one number — the "is this customer already ordering?" check. */
    phone?: string | null;
    statuses?: OrderStatus[];
    limit?: number;
  } = {},
): Promise<DuplicateGroup[]> {
  const windowHours = opts.windowHours ?? DUPLICATE_WINDOW_HOURS;
  const cutoff = new Date(
    Date.now() - Math.max(1, windowHours) * 3_600_000,
  ).toISOString();

  const conditions = [sql`${orders.createdAt} >= ${cutoff}`];
  if (opts.phone) {
    const key = toLocalAlgerianMobile(opts.phone) ?? opts.phone.trim();
    if (!key) return [];
    conditions.push(eq(orders.phone, key));
  }
  if (opts.statuses?.length) {
    conditions.push(inArray(orders.status, opts.statuses));
  }
  const where = and(...conditions);

  const groups = await db
    .select({
      phone: orders.phone,
      count: sql<number>`COUNT(*)`,
      lastCreatedAt: sql<string>`MAX(${orders.createdAt})`,
    })
    .from(orders)
    .where(where)
    .groupBy(orders.phone)
    .having(sql`COUNT(*) > 1`)
    .orderBy(sql`COUNT(*) DESC`, sql`MAX(${orders.createdAt}) DESC`)
    .limit(opts.limit ?? 50)
    .all();

  if (groups.length === 0) return [];

  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      createdAt: orders.createdAt,
      customerName: orders.customerName,
      phone: orders.phone,
      price: orders.price,
      deliveryFee: orders.deliveryFee,
      codAmount: orders.codAmount,
      trackingNumber: orders.trackingNumber,
      wilaya: wilayas.nameAr,
      commune: communes.nameAr,
      productName: sql<string | null>`(SELECT op.product_name FROM order_products op WHERE op.order_id = ${orders.id} ORDER BY op.created_at LIMIT 1)`,
    })
    .from(orders)
    .leftJoin(wilayas, eq(orders.wilayaId, wilayas.id))
    .leftJoin(communes, eq(orders.communeId, communes.id))
    .where(and(inArray(orders.phone, groups.map((group) => group.phone)), where))
    .orderBy(orders.phone, desc(orders.createdAt), desc(orders.id))
    .all();

  const byPhone = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byPhone.get(row.phone);
    if (bucket) bucket.push(row);
    else byPhone.set(row.phone, [row]);
  }

  const SHIPPED: OrderStatus[] = [
    "assigned",
    "dispatched",
    "out_for_delivery",
    "delivered",
  ];

  return groups
    .map((group) => {
      const members = byPhone.get(group.phone) ?? [];
      const productNames = members.map((member) => member.productName);
      return {
        phone: group.phone,
        count: members.length,
        sameProduct:
          members.length > 1 &&
          productNames.every((name) => name === productNames[0]),
        shipped: members.some((member) => SHIPPED.includes(member.status)),
        totalCod: members.reduce(
          (sum, member) => sum + (member.codAmount ?? member.price + member.deliveryFee),
          0,
        ),
        lastCreatedAt: group.lastCreatedAt,
        orders: members.map((member) => ({
          id: member.id,
          orderNumber: member.orderNumber,
          status: member.status,
          createdAt: member.createdAt,
          customerName: member.customerName,
          price: member.price,
          deliveryFee: member.deliveryFee,
          wilaya: member.wilaya,
          commune: member.commune,
          productName: member.productName,
          trackingNumber: member.trackingNumber,
        })),
      } satisfies DuplicateGroup;
    })
    .filter((group) => group.count > 1);
}

/**
 * How many recent orders each of these phones already has — one query for a
 * whole spreadsheet, so an import can warn "this customer ordered twice
 * yesterday" without an N+1 lookup per row.
 */
export async function countRecentOrdersByPhone(
  db: AppDb,
  phones: string[],
  windowHours: number = DUPLICATE_WINDOW_HOURS,
): Promise<Map<string, number>> {
  const keys = [
    ...new Set(
      phones
        .map((phone) => toLocalAlgerianMobile(phone))
        .filter((phone): phone is string => Boolean(phone)),
    ),
  ];
  if (keys.length === 0) return new Map();

  const cutoff = new Date(Date.now() - Math.max(1, windowHours) * 3_600_000).toISOString();
  const rows = await db
    .select({ phone: orders.phone, count: sql<number>`COUNT(*)` })
    .from(orders)
    .where(
      and(
        inArray(orders.phone, keys),
        sql`${orders.createdAt} >= ${cutoff}`,
      ),
    )
    .groupBy(orders.phone)
    .all();

  return new Map(rows.map((row) => [row.phone, Number(row.count)]));
}

export async function isAutomaticConfirmationAssignmentEnabled(db: AppDb) {
  const setting = await db.select({ enabled: operationAutomationSettings.autoAssignEnabled })
    .from(operationAutomationSettings).where(eq(operationAutomationSettings.id, "default")).get();
  return setting?.enabled ?? true;
}

export async function chooseLeastLoadedConfirmer(db: AppDb) {
  const candidates = await db.select({ id: users.id, name: users.name,
    maxOpenOrders: sql<number>`coalesce(${operationAgentSettings.maxOpenOrders}, 25)`,
    maxDailyOrders: sql<number>`coalesce(${operationAgentSettings.maxDailyOrders}, 50)`,
    assignedToday: sql<number>`(SELECT COUNT(*) FROM order_confirmation_assignments today_ca WHERE today_ca.assignee_id = ${users.id} AND date(today_ca.assigned_at, '+1 hour') = date('now', '+1 hour'))`,
    openOrders: sql<number>`(SELECT COUNT(*) FROM order_confirmation_assignments ca JOIN orders assigned_orders ON assigned_orders.id = ca.order_id WHERE ca.assignee_id = ${users.id} AND assigned_orders.status IN ('new','confirmed','unreachable'))`,
  }).from(users).leftJoin(operationAgentSettings, eq(operationAgentSettings.userId, users.id))
    .where(and(eq(users.role, "confirmer"), eq(users.status, "active"), sql`coalesce(${operationAgentSettings.autoAssignEnabled}, 1) = 1`))
    .orderBy(sql`(SELECT COUNT(*) FROM order_confirmation_assignments ca JOIN orders ao ON ao.id = ca.order_id WHERE ca.assignee_id = ${users.id} AND ao.status IN ('new','confirmed','unreachable')) ASC`, users.createdAt).all();
  return candidates.find((candidate) => candidate.openOrders < candidate.maxOpenOrders && candidate.assignedToday < candidate.maxDailyOrders) ?? null;
}

export async function createOrder(
  db: AppDb,
  orderData: typeof orders.$inferInsert,
  productsData: Array<typeof orderProducts.$inferInsert>,
  actor?: { id: string; name: string } | null,
) {
  const now = orderData.createdAt ?? new Date().toISOString();
  // A banned number never enters the confirmation queue. The order is still
  // recorded — the merchant wants the evidence and the eventual return stats —
  // but it is left unassigned so no confirmer spends a call on it, and the hit
  // is counted on the ban so its value stays visible.
  const blacklistHit = orderData.status === "new"
    ? await findActiveBlacklistEntry(db, { phone: orderData.phone ?? null })
    : null;
  const confirmer = !blacklistHit && orderData.status === "new" && (await isAutomaticConfirmationAssignmentEnabled(db))
    ? await chooseLeastLoadedConfirmer(db)
    : null;
  const statements: BatchStatement[] = [db.insert(orders).values(orderData)];
  if (confirmer) {
    statements.push(db.insert(orderConfirmationAssignments).values({
      orderId: orderData.id!, assigneeId: confirmer.id, assignedBy: actor?.id ?? null,
      assignedAt: now, updatedAt: now,
    }));
    statements.push(db.insert(operationTasks).values({
    id: crypto.randomUUID(), title: `Confirm order ${orderData.orderNumber}`,
    description: `Contact ${orderData.customerName} to confirm the order and delivery details.`, type: "confirmation", status: "open", priority: "normal",
    orderId: orderData.id!, customerId: orderData.customerId, assigneeId: confirmer.id, createdBy: actor?.id ?? null,
    dueAt: new Date(Date.parse(now) + 30 * 60 * 1000).toISOString(), createdAt: now, updatedAt: now,
    }));
  }

  if (productsData.length > 0) {
    statements.push(db.insert(orderProducts).values(productsData));
  }

  statements.push(
    db.insert(orderStatusHistory).values({
      id: crypto.randomUUID(),
      orderId: orderData.id!,
      status: orderData.status!,
      timestamp: orderData.createdAt!,
      by: null,
    }),
  );

  statements.push(
    db
      .update(customers)
      .set({
        totalOrders: sql`${customers.totalOrders} + 1`,
        totalSpent: sql`${customers.totalSpent} + ${orderData.price ?? 0}`,
        lastOrderAt: orderData.createdAt,
      })
      .where(eq(customers.id, orderData.customerId)),
  );

  for (const item of productsData) {
    const qty = item.quantity as number;

    const productRow = await db
      .select({ trackInventory: products.trackInventory })
      .from(products)
      .where(eq(products.id, item.productId))
      .get();

    if (!productRow?.trackInventory) continue;

    // Guarded deduction, same pattern as the storefront path: the movement's
    // qtyBefore/qtyAfter are subselects guarded by inventory >= qty. When
    // stock is insufficient (or a concurrent writer already took it), the
    // subselects return NULL, the movement insert violates NOT NULL, and the
    // ENTIRE batch rolls back — no oversell floor, no lost-update race.
    if (item.variantId) {
      statements.push(
        db.insert(stockMovements).values({
          id: crypto.randomUUID(),
          productId: item.productId,
          variantId: item.variantId,
          type: "ORDER_DEDUCTED",
          delta: -qty,
          qtyBefore: sql`(SELECT inventory FROM product_variants WHERE id = ${item.variantId} AND inventory >= ${qty})`,
          qtyAfter: sql`(SELECT inventory - ${qty} FROM product_variants WHERE id = ${item.variantId} AND inventory >= ${qty})`,
          reason: null,
          reference: orderData.id ?? null,
          createdBy: actor?.id ?? "system",
          createdByName: actor?.name ?? "النظام",
          createdAt: now,
        }),
      );
      statements.push(
        db
          .update(productVariants)
          .set({
            inventory: sql`${productVariants.inventory} - ${qty}`,
            updatedAt: now,
          })
          .where(
            and(
              eq(productVariants.id, item.variantId),
              sql`${productVariants.inventory} >= ${qty}`,
            ),
          ),
      );
    } else {
      statements.push(
        db.insert(stockMovements).values({
          id: crypto.randomUUID(),
          productId: item.productId,
          variantId: null,
          type: "ORDER_DEDUCTED",
          delta: -qty,
          qtyBefore: sql`(SELECT inventory FROM products WHERE id = ${item.productId} AND inventory >= ${qty})`,
          qtyAfter: sql`(SELECT inventory - ${qty} FROM products WHERE id = ${item.productId} AND inventory >= ${qty})`,
          reason: null,
          reference: orderData.id ?? null,
          createdBy: actor?.id ?? "system",
          createdByName: actor?.name ?? "النظام",
          createdAt: now,
        }),
      );
      statements.push(
        db
          .update(products)
          .set({
            inventory: sql`${products.inventory} - ${qty}`,
            updatedAt: now,
          })
          .where(
            and(
              eq(products.id, item.productId),
              sql`${products.inventory} >= ${qty}`,
            ),
          ),
      );
    }
  }

  // Atomic: order row, lines, history, customer stats, stock deduction, and
  // ledger commit together or not at all. Guarded deductions make the batch
  // fail (and roll back entirely) when stock is insufficient — no silent
  // floor-at-zero, no lost-update races.
  await db.batch(statements as [BatchStatement, ...BatchStatement[]]);

  // Counted only after the batch commits: an order that rolled back (insufficient
  // stock) never happened, so it must not inflate what the ban "saved".
  if (blacklistHit) await recordBlacklistHit(db, blacklistHit.id, now);

  return orderData.id;
}

export async function createStaffCommissionStages(db: AppDb, orderId: string, earnConfirmation = true) {
  const row = await db.select({ assigneeId: orderConfirmationAssignments.assigneeId, price: orders.price,
    followType: operationAgentSettings.commissionType, followValue: operationAgentSettings.commissionValue,
    confirmationType: operationAgentSettings.confirmationCommissionType, confirmationValue: operationAgentSettings.confirmationCommissionValue,
  }).from(orders).leftJoin(orderConfirmationAssignments, eq(orders.id, orderConfirmationAssignments.orderId))
    .leftJoin(operationAgentSettings, eq(orderConfirmationAssignments.assigneeId, operationAgentSettings.userId)).where(eq(orders.id, orderId)).get();
  if (!row?.assigneeId) return;
  const now = new Date().toISOString();
  const stages = [
    { category: "confirmation" as const, type: row.confirmationType, value: row.confirmationValue, status: earnConfirmation ? "earned" as const : "pending" as const },
    ...(earnConfirmation ? [{ category: "follow_up" as const, type: row.followType, value: row.followValue, status: "pending" as const }] : []),
  ];
  for (const stage of stages) {
    if (!stage.type || !stage.value || stage.value <= 0) continue;
    const amount = stage.type === "percentage" ? Math.round(row.price * stage.value) / 100 : stage.value;
    await db.insert(staffCommissions).values({ id: crypto.randomUUID(), orderId, userId: row.assigneeId,
      category: stage.category, amount, rateType: stage.type, rateValue: stage.value, status: stage.status,
      earnedAt: stage.status === "earned" ? now : null, createdAt: now, updatedAt: now,
    }).onConflictDoNothing({ target: [staffCommissions.orderId, staffCommissions.category] });
    if (stage.status === "pending") {
      await db.update(staffCommissions).set({ userId: row.assigneeId, amount, rateType: stage.type, rateValue: stage.value, updatedAt: now })
        .where(and(eq(staffCommissions.orderId, orderId), eq(staffCommissions.category, stage.category), eq(staffCommissions.status, "pending")));
    }
  }
  if (earnConfirmation) {
    await db.update(staffCommissions).set({ status: "earned", earnedAt: now, updatedAt: now })
      .where(and(eq(staffCommissions.orderId, orderId), eq(staffCommissions.category, "confirmation"), eq(staffCommissions.status, "pending")));
  }
}

export async function settleFollowUpCommission(db: AppDb, orderId: string, outcome: "delivered" | "reversed") {
  const now = new Date().toISOString();
  await db.update(staffCommissions).set(outcome === "delivered"
    ? { status: "earned", earnedAt: now, updatedAt: now }
    : { status: "reversed", reversedAt: now, updatedAt: now })
    .where(and(eq(staffCommissions.orderId, orderId), eq(staffCommissions.category, "follow_up"), eq(staffCommissions.status, "pending")));
}


export async function updateOrderStatus(
  db: AppDb,
  orderId: string,
  newStatus: OrderStatus,
  userId?: string,
  userName?: string,
) {
  const now = new Date().toISOString();

  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();

  const statements: BatchStatement[] = [
    db
      .update(orders)
      .set({
        status: newStatus,
        updatedAt: now,
        ...(newStatus === "delivered" ? { deliveryTime: now } : {}),
      })
      .where(eq(orders.id, orderId)),

    db.insert(orderStatusHistory).values({
      id: crypto.randomUUID(),
      orderId,
      status: newStatus,
      timestamp: now,
      by: userId ?? null,
    }),
  ];

  if (newStatus === "delivered" && order?.driverId) {
    statements.push(
      db
        .update(drivers)
        .set({
          totalDelivered: sql`${drivers.totalDelivered} + 1`,
          totalEarnings: sql`${drivers.totalEarnings} + ${order.driverFee ?? 0}`,
          pendingCash: sql`${drivers.pendingCash} + ${order.codAmount ?? 0}`,
          updatedAt: now,
        })
        .where(eq(drivers.id, order.driverId)),
    );
  }

  const terminalStatuses = ["cancelled", "returned"];
  const wasAlreadyTerminal = order ? terminalStatuses.includes(order.status) : false;

  if (!wasAlreadyTerminal && (newStatus === "cancelled" || newStatus === "returned")) {
    // Update customer totalSpent when order is cancelled/returned
    statements.push(
      db
        .update(customers)
        .set({
          totalSpent: sql`MAX(0, ${customers.totalSpent} - ${order?.price ?? 0})`,
        })
        .where(eq(customers.id, order?.customerId ?? "")),
    );

    const movementType =
      newStatus === "cancelled" ? "ORDER_CANCELLED" : "ORDER_RETURNED";

    const ordProductRows = await db
      .select({
        id: orderProducts.id,
        productId: orderProducts.productId,
        variantId: orderProducts.variantId,
        quantity: orderProducts.quantity,
        returnedQuantity: orderProducts.returnedQuantity,
      })
      .from(orderProducts)
      .where(eq(orderProducts.orderId, orderId))
      .all();

    for (const op of ordProductRows) {
      const remaining = op.quantity - (op.returnedQuantity ?? 0);
      if (remaining <= 0) continue;

      const productRow = await db
        .select({ trackInventory: products.trackInventory })
        .from(products)
        .where(eq(products.id, op.productId))
        .get();

      if (!productRow?.trackInventory) continue;

      if (op.variantId) {
        const variantRow = await db
          .select({ inventory: productVariants.inventory })
          .from(productVariants)
          .where(eq(productVariants.id, op.variantId))
          .get();

        const qtyBefore = variantRow?.inventory ?? 0;
        const qtyAfter = qtyBefore + remaining;

        statements.push(
          db
            .update(productVariants)
            .set({ inventory: qtyAfter, updatedAt: now })
            .where(eq(productVariants.id, op.variantId)),
        );

        statements.push(
          db.insert(stockMovements).values({
            id: crypto.randomUUID(),
            productId: op.productId,
            variantId: op.variantId,
            type: movementType,
            delta: remaining,
            qtyBefore,
            qtyAfter,
            reason: null,
            reference: orderId,
            createdBy: userId ?? "system",
            createdByName: userName ?? "النظام",
            createdAt: now,
          }),
        );
      } else {
        const productInventoryRow = await db
          .select({ inventory: products.inventory })
          .from(products)
          .where(eq(products.id, op.productId))
          .get();

        const qtyBefore = productInventoryRow?.inventory ?? 0;
        const qtyAfter = qtyBefore + remaining;

        statements.push(
          db
            .update(products)
            .set({ inventory: qtyAfter, updatedAt: now })
            .where(eq(products.id, op.productId)),
        );

        statements.push(
          db.insert(stockMovements).values({
            id: crypto.randomUUID(),
            productId: op.productId,
            variantId: null,
            type: movementType,
            delta: remaining,
            qtyBefore,
            qtyAfter,
            reason: null,
            reference: orderId,
            createdBy: userId ?? "system",
            createdByName: userName ?? "النظام",
            createdAt: now,
          }),
        );
      }

      statements.push(
        db
          .update(orderProducts)
          .set({ status: "returned", returnedQuantity: op.quantity })
          .where(eq(orderProducts.id, op.id)),
      );
    }
  }

  // Atomic: status, history, driver credit, customer stats, restock, and line
  // returns commit together or not at all. Without the batch, a mid-sequence
  // failure committed "cancelled" without the restock — and the
  // wasAlreadyTerminal guard then blocked every retry, permanently losing
  // the inventory.
  await db.batch(statements as [BatchStatement, ...BatchStatement[]]);

  // Commission state follows every status source (dashboard, shipment actions,
  // and carrier webhooks), not only the manual status endpoint.
  if (newStatus === "confirmed") await createStaffCommissionStages(db, orderId);
  if (newStatus === "delivered") await settleFollowUpCommission(db, orderId, "delivered");
  if (newStatus === "returned" || newStatus === "cancelled") await settleFollowUpCommission(db, orderId, "reversed");
  if (newStatus === "confirmed") {
    await db.update(operationTasks).set({ status: "completed", completedAt: now, updatedAt: now })
      .where(and(eq(operationTasks.orderId, orderId), eq(operationTasks.type, "confirmation"), sql`${operationTasks.status} IN ('open','in_progress')`));
  } else if (newStatus === "cancelled" || newStatus === "returned") {
    await db.update(operationTasks).set({ status: "cancelled", updatedAt: now })
      .where(and(eq(operationTasks.orderId, orderId), sql`${operationTasks.status} IN ('open','in_progress')`));
  }

  return true;
}

export async function setOrderProductReturn(
  db: AppDb,
  orderId: string,
  productLineId: string,
  newReturnedQty: number,
  userId?: string,
  userName?: string,
): Promise<{
  id: string;
  status: "fulfilled" | "partially_returned" | "returned";
  returnedQuantity: number;
  quantity: number;
}> {
  const now = new Date().toISOString();

  const line = await db
    .select()
    .from(orderProducts)
    .where(and(eq(orderProducts.id, productLineId), eq(orderProducts.orderId, orderId)))
    .get();

  if (!line) {
    throw new Error(`Order line ${productLineId} not found on order ${orderId}`);
  }

  if (newReturnedQty < 0 || newReturnedQty > line.quantity) {
    throw new Error(
      `returnedQuantity must be between 0 and ${line.quantity} (got ${newReturnedQty})`,
    );
  }

  const currentReturned = line.returnedQuantity ?? 0;
  const delta = newReturnedQty - currentReturned;

  if (delta !== 0) {
    const productRow = await db
      .select({ trackInventory: products.trackInventory })
      .from(products)
      .where(eq(products.id, line.productId))
      .get();

    if (productRow?.trackInventory) {
      if (line.variantId) {
        const variantRow = await db
          .select({ inventory: productVariants.inventory })
          .from(productVariants)
          .where(eq(productVariants.id, line.variantId))
          .get();

        const qtyBefore = variantRow?.inventory ?? 0;
        const qtyAfter = Math.max(0, qtyBefore + delta);

        await db
          .update(productVariants)
          .set({ inventory: qtyAfter, updatedAt: now })
          .where(eq(productVariants.id, line.variantId));

        await db
          .insert(stockMovements)
          .values({
            id: crypto.randomUUID(),
            productId: line.productId,
            variantId: line.variantId,
            type: "ORDER_RETURNED",
            delta,
            qtyBefore,
            qtyAfter,
            reason: null,
            reference: orderId,
            createdBy: userId ?? "system",
            createdByName: userName ?? "النظام",
            createdAt: now,
          })
          .catch((err) =>
            console.error("[stock] Failed to log ORDER_RETURNED movement:", err),
          );
      } else {
        const productInventoryRow = await db
          .select({ inventory: products.inventory })
          .from(products)
          .where(eq(products.id, line.productId))
          .get();

        const qtyBefore = productInventoryRow?.inventory ?? 0;
        const qtyAfter = Math.max(0, qtyBefore + delta);

        await db
          .update(products)
          .set({ inventory: qtyAfter, updatedAt: now })
          .where(eq(products.id, line.productId));

        await db
          .insert(stockMovements)
          .values({
            id: crypto.randomUUID(),
            productId: line.productId,
            variantId: null,
            type: "ORDER_RETURNED",
            delta,
            qtyBefore,
            qtyAfter,
            reason: null,
            reference: orderId,
            createdBy: userId ?? "system",
            createdByName: userName ?? "النظام",
            createdAt: now,
          })
          .catch((err) =>
            console.error("[stock] Failed to log ORDER_RETURNED movement:", err),
          );
      }
    }
  }

  const newStatus: "fulfilled" | "partially_returned" | "returned" =
    newReturnedQty === 0
      ? "fulfilled"
      : newReturnedQty === line.quantity
        ? "returned"
        : "partially_returned";

  await db
    .update(orderProducts)
    .set({ status: newStatus, returnedQuantity: newReturnedQty })
    .where(eq(orderProducts.id, productLineId));

  return {
    id: line.id,
    status: newStatus,
    returnedQuantity: newReturnedQty,
    quantity: line.quantity,
  };
}

export async function assignDriver(db: AppDb, orderId: string, driverId: string) {
  const now = new Date().toISOString();

  const order = await db
    .select({ wilayaId: orders.wilayaId, status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();

  let driverFee = 0;
  if (order?.wilayaId) {
    const comp = await db
      .select({ feePerDelivery: driverCompensations.feePerDelivery })
      .from(driverCompensations)
      .where(
        and(
          eq(driverCompensations.driverId, driverId),
          eq(driverCompensations.wilayaId, order.wilayaId),
        ),
      )
      .get();

    if (comp) {
      driverFee = comp.feePerDelivery;
    }
  }

  const preAssignmentStatuses = ["new", "preparing", "ready"];
  const shouldSetAssigned = preAssignmentStatuses.includes(order?.status ?? "");

  await db
    .update(orders)
    .set({
      driverId,
      driverFee,
      deliveryMethod: "driver",
      ...(shouldSetAssigned ? { status: "assigned" } : {}),
      updatedAt: now,
    })
    .where(eq(orders.id, orderId));

  return true;
}

export async function unassignDriver(db: AppDb, orderId: string) {
  const now = new Date().toISOString();

  const order = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();

  const shouldRollbackStatus = order?.status === "assigned";

  await db
    .update(orders)
    .set({
      driverId: null,
      driverFee: 0,
      deliveryMethod: "unassigned",
      ...(shouldRollbackStatus ? { status: "ready" } : {}),
      updatedAt: now,
    })
    .where(eq(orders.id, orderId));

  return true;
}

export async function assignCompany(db: AppDb, orderId: string, companyId: string) {
  await db
    .update(orders)
    .set({
      companyId,
      deliveryMethod: "company",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(orders.id, orderId));
}

export async function syncOrderAfterCarrierUpdate(
  db: AppDb,
  orderId: string,
  fields: { customerName?: string; phone?: string; price?: number },
) {
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (fields.customerName !== undefined) patch.customerName = fields.customerName;
  if (fields.phone !== undefined) patch.phone = fields.phone;
  if (fields.price !== undefined) {
    patch.price = fields.price;
    // The COD the driver is booked to collect must follow the carrier
    // amount — leaving codAmount stale made settlement and dashboards run
    // on the old number while the carrier collected the new one.
    patch.codAmount = sql`${fields.price} + ${orders.deliveryFee}`;
  }

  await db.update(orders).set(patch).where(eq(orders.id, orderId));
}

export async function updateOrderTracking(
  db: AppDb,
  orderId: string,
  trackingNumber: string,
  trackingUrl?: string,
  deliveryType?: "home" | "stop_desk",
) {
  await db
    .update(orders)
    .set({
      trackingNumber,
      trackingUrl: trackingUrl ?? null,
      // Dispatch-time delivery-type override: persisted only on successful
      // dispatch so the order records what the carrier actually accepted.
      ...(deliveryType !== undefined ? { deliveryType } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(orders.id, orderId));
}

export async function clearOrderTracking(db: AppDb, orderId: string) {
  await db
    .update(orders)
    .set({
      trackingNumber: null,
      trackingUrl: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(orders.id, orderId));
}

export async function deleteOrder(db: AppDb, orderId: string) {
  const now = new Date().toISOString();

  // Get order details first to update customer stats
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();

  // Get order products to restore inventory
  const orderProductsList = await db
    .select()
    .from(orderProducts)
    .where(eq(orderProducts.orderId, orderId))
    .all();

  const statements: BatchStatement[] = [];

  // Update customer stats BEFORE deleting the order.
  // totalOrders always drops (the order no longer exists). totalSpent is only
  // subtracted when the order was still counting as spend: cancelled/returned
  // orders already rolled their spend back at status-change time —
  // subtracting again would double-decrement (e.g. cancel + delete).
  if (order) {
    const spendAlreadyRolledBack =
      order.status === "cancelled" || order.status === "returned";

    statements.push(
      db
        .update(customers)
        .set({
          totalOrders: sql`MAX(0, ${customers.totalOrders} - 1)`,
          ...(spendAlreadyRolledBack
            ? {}
            : {
                totalSpent: sql`MAX(0, ${customers.totalSpent} - ${order.price ?? 0})`,
              }),
        })
        .where(eq(customers.id, order.customerId)),
    );
  }

  // Reverse driver credit for delivered orders whose money has NOT been
  // settled. Before this, deleting a delivered order left totalDelivered,
  // totalEarnings and pendingCash permanently inflated — and unsettleable
  // phantom cash (the order no longer appears in the pending list).
  // Orders already linked to a payment keep the driver counters alone:
  // the payment row is append-only history and must stay reconciled.
  if (order && order.driverId && order.status === "delivered" && order.codPaymentId === null) {
    statements.push(
      db
        .update(drivers)
        .set({
          totalDelivered: sql`MAX(0, ${drivers.totalDelivered} - 1)`,
          totalEarnings: sql`MAX(0, ${drivers.totalEarnings} - ${order.driverFee ?? 0})`,
          pendingCash: sql`MAX(0, ${drivers.pendingCash} - ${order.codAmount ?? 0})`,
          updatedAt: now,
        })
        .where(eq(drivers.id, order.driverId)),
    );
  }

  // Restore inventory for products that track inventory
  for (const op of orderProductsList) {
    const remaining = op.quantity - (op.returnedQuantity ?? 0);
    if (remaining <= 0) continue; // Already returned, no stock to restore

    const productRow = await db
      .select({ trackInventory: products.trackInventory })
      .from(products)
      .where(eq(products.id, op.productId))
      .get();

    if (!productRow?.trackInventory) continue; // Product doesn't track inventory

    if (op.variantId) {
      // Restore variant inventory
      const variantRow = await db
        .select({ inventory: productVariants.inventory })
        .from(productVariants)
        .where(eq(productVariants.id, op.variantId))
        .get();

      const qtyBefore = variantRow?.inventory ?? 0;
      const qtyAfter = qtyBefore + remaining;

      statements.push(
        db
          .update(productVariants)
          .set({ inventory: qtyAfter, updatedAt: now })
          .where(eq(productVariants.id, op.variantId)),
      );

      statements.push(
        db.insert(stockMovements).values({
          id: crypto.randomUUID(),
          productId: op.productId,
          variantId: op.variantId,
          type: "ORDER_CANCELLED",
          delta: remaining,
          qtyBefore,
          qtyAfter,
          reason: "Order deleted - inventory restored",
          reference: orderId,
          createdBy: "system",
          createdByName: "النظام",
          createdAt: now,
        }),
      );
    } else {
      // Restore product inventory
      const productInventoryRow = await db
        .select({ inventory: products.inventory })
        .from(products)
        .where(eq(products.id, op.productId))
        .get();

      const qtyBefore = productInventoryRow?.inventory ?? 0;
      const qtyAfter = qtyBefore + remaining;

      statements.push(
        db
          .update(products)
          .set({ inventory: qtyAfter, updatedAt: now })
          .where(eq(products.id, op.productId)),
      );

      statements.push(
        db.insert(stockMovements).values({
          id: crypto.randomUUID(),
          productId: op.productId,
          variantId: null,
          type: "ORDER_CANCELLED",
          delta: remaining,
          qtyBefore,
          qtyAfter,
          reason: "Order deleted - inventory restored",
          reference: orderId,
          createdBy: "system",
          createdByName: "النظام",
          createdAt: now,
        }),
      );
    }
  }

  // Delete related records. company_api_logs and webhook_events reference
  // orders(id) with ON DELETE no action — they must be removed explicitly or
  // the final orders delete fails the FOREIGN KEY constraint. Reviews and
  // order_status_history cascade at the database level.
  statements.push(
    db.delete(companyApiLogs).where(eq(companyApiLogs.orderId, orderId)),
    db.delete(webhookEvents).where(eq(webhookEvents.orderId, orderId)),
    db.delete(companyShipments).where(eq(companyShipments.orderId, orderId)),
    db.delete(orderProducts).where(eq(orderProducts.orderId, orderId)),
    db.delete(orders).where(eq(orders.id, orderId)),
  );

  // Atomic: stats, restock, and deletes commit together or not at all.
  // Without the batch, a mid-sequence failure left a gutted order behind
  // (lines deleted, stats decremented, inventory restocked) while the
  // order row itself survived.
  await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
}

// ─── Webhook Status Update ────────────────────────────────────────────────────

/**
 * Rank used to guard against webhook-driven status regressions.
 * A webhook event can only advance the order to a higher-ranked status.
 * Delivered, returned, and cancelled are all terminal (rank 6) — no further changes.
 */
const STATUS_RANK: Record<string, number> = {
  new: 0,
  confirmed: 1,
  unreachable: 1,
  preparing: 2,
  ready: 3,
  assigned: 4,
  dispatched: 4,
  out_for_delivery: 5,
  delivered: 6,
  returned: 6,
  cancelled: 6,
};

interface RestockLine {
  lineId: string;
  productId: string;
  variantId: string | null;
  remaining: number;
}

interface RestockResolved extends RestockLine {
  qtyBefore: number;
}

async function resolveRestockLines(
  db: AppDb,
  orderId: string,
): Promise<RestockLine[]> {
  const ordProductRows = await db
    .select({
      id: orderProducts.id,
      productId: orderProducts.productId,
      variantId: orderProducts.variantId,
      quantity: orderProducts.quantity,
      returnedQuantity: orderProducts.returnedQuantity,
    })
    .from(orderProducts)
    .where(eq(orderProducts.orderId, orderId))
    .all();

  const lines: RestockLine[] = [];
  for (const op of ordProductRows) {
    const remaining = op.quantity - (op.returnedQuantity ?? 0);
    if (remaining <= 0) continue;

    const productRow = await db
      .select({ trackInventory: products.trackInventory })
      .from(products)
      .where(eq(products.id, op.productId))
      .get();

    if (!productRow?.trackInventory) continue;

    lines.push({
      lineId: op.id,
      productId: op.productId,
      variantId: op.variantId,
      remaining,
    });
  }
  return lines;
}

async function readCurrentInventories(
  db: AppDb,
  lines: RestockLine[],
): Promise<RestockResolved[]> {
  const resolved: RestockResolved[] = [];
  for (const line of lines) {
    const row = await db
      .select({ inventory: line.variantId ? productVariants.inventory : products.inventory })
      .from(line.variantId ? productVariants : products)
      .where(eq(line.variantId ? productVariants.id : products.id, line.variantId ?? line.productId))
      .get();
    resolved.push({ ...line, qtyBefore: row?.inventory ?? 0 });
  }
  return resolved;
}

type BatchStatement = Parameters<AppDb["batch"]>[0][number];

function buildRestockStatements(
  db: AppDb,
  resolved: RestockResolved[],
  movementType: "ORDER_CANCELLED" | "ORDER_RETURNED",
  orderId: string,
  source: string,
  now: string,
): BatchStatement[] {
  const built: BatchStatement[] = [];

  for (const line of resolved) {
    const qtyAfter = line.qtyBefore + line.remaining;

    if (line.variantId) {
      built.push(
        db
          .update(productVariants)
          .set({ inventory: sql`${productVariants.inventory} + ${line.remaining}`, updatedAt: now })
          .where(eq(productVariants.id, line.variantId)),
      );
    } else {
      built.push(
        db
          .update(products)
          .set({ inventory: sql`${products.inventory} + ${line.remaining}`, updatedAt: now })
          .where(eq(products.id, line.productId)),
      );
    }

    built.push(
      db.insert(stockMovements).values({
        id: crypto.randomUUID(),
        productId: line.productId,
        variantId: line.variantId,
        type: movementType,
        delta: line.remaining,
        qtyBefore: line.qtyBefore,
        qtyAfter,
        reason: null,
        reference: orderId,
        createdBy: source,
        createdByName: source,
        createdAt: now,
      }),
    );

    built.push(
      db
        .update(orderProducts)
        .set({ status: "returned", returnedQuantity: sql`${orderProducts.quantity}` })
        .where(eq(orderProducts.id, line.lineId)),
    );
  }

  return built;
}

export async function updateOrderStatusWebhook(
  db: AppDb,
  orderId: string,
  newStatus: OrderStatus,
  source: string,
): Promise<{ updated: boolean }> {
  const now = new Date().toISOString();

  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();

  if (!order) return { updated: false };

  const currentRank = STATUS_RANK[order.status] ?? 0;
  const newRank = STATUS_RANK[newStatus] ?? 0;

  if (newRank <= currentRank) {
    return { updated: false };
  }

  const updateFields: Record<string, unknown> = {
    status: newStatus,
    updatedAt: now,
  };
  if (newStatus === "delivered") {
    updateFields.deliveryTime = now;
  }

  const statements: BatchStatement[] = [
    db.update(orders).set(updateFields).where(eq(orders.id, orderId)),
    db.insert(orderStatusHistory).values({
      id: crypto.randomUUID(),
      orderId,
      status: newStatus,
      timestamp: now,
      by: source,
    }),
  ];

  if (newStatus === "delivered" && order.driverId) {
    statements.push(
      db
        .update(drivers)
        .set({
          totalDelivered: sql`${drivers.totalDelivered} + 1`,
          totalEarnings: sql`${drivers.totalEarnings} + ${order.driverFee ?? 0}`,
          pendingCash: sql`${drivers.pendingCash} + ${order.codAmount ?? 0}`,
          updatedAt: now,
        })
        .where(eq(drivers.id, order.driverId)),
    );
  }

  if (newStatus === "cancelled" || newStatus === "returned") {
    statements.push(
      db
        .update(customers)
        .set({
          totalSpent: sql`MAX(0, ${customers.totalSpent} - ${order.price ?? 0})`,
        })
        .where(eq(customers.id, order.customerId)),
    );

    const movementType =
      newStatus === "cancelled" ? "ORDER_CANCELLED" : "ORDER_RETURNED";

    const lines = await resolveRestockLines(db, orderId);
    const resolved = await readCurrentInventories(db, lines);
    statements.push(...buildRestockStatements(db, resolved, movementType, orderId, source, now));
  }

  await db.batch(statements as [BatchStatement, ...BatchStatement[]]);

  return { updated: true };
}

export async function incrementDeliveryAttempts(
  db: AppDb,
  orderId: string,
): Promise<void> {
  await db
    .update(orders)
    .set({
      deliveryAttempts: sql`${orders.deliveryAttempts} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(orders.id, orderId));
}
