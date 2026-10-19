/**
 * Read queries for the bot's order browser.
 *
 * Pages are keyset-free (small page size, newest first) and always scoped by a
 * whitelisted status filter — no SQL fragments built from user input.
 */

import { and, desc, eq, or, like, sql, inArray } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  orders,
  orderProducts,
  customers,
  drivers,
  deliveryCompanies,
  wilayas,
  orderStatusHistory,
  type OrderStatus,
} from "@/db/schema";
import type { OrderFilter } from "./callbacks";

export const BOT_PAGE_SIZE = 8;

const ACTIVE_STATUSES: OrderStatus[] = [
  "new",
  "confirmed",
  "unreachable",
  "preparing",
  "ready",
  "assigned",
  "dispatched",
  "out_for_delivery",
];

const KNOWN_STATUSES: OrderStatus[] = [
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
];

export interface BotOrderRow {
  id: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  status: OrderStatus;
  price: number;
  deliveryFee: number;
  codAmount: number;
  createdAt: string;
  wilayaId: number | null;
  wilayaName: string | null;
  wilayaNameAr: string | null;
}

function statusCondition(filter: OrderFilter) {
  if (filter === "all") return undefined;
  if (filter === "active") return inArray(orders.status, ACTIVE_STATUSES);
  if (KNOWN_STATUSES.includes(filter as OrderStatus)) return eq(orders.status, filter as OrderStatus);
  return undefined;
}

const orderColumns = {
  id: orders.id,
  orderNumber: orders.orderNumber,
  customerName: orders.customerName,
  phone: orders.phone,
  status: orders.status,
  price: orders.price,
  deliveryFee: orders.deliveryFee,
  codAmount: orders.codAmount,
  createdAt: orders.createdAt,
  wilayaId: orders.wilayaId,
  wilayaName: wilayas.name,
  wilayaNameAr: wilayas.nameAr,
};

export async function listOrders(
  db: AppDb,
  options: { filter: OrderFilter; page?: number; pageSize?: number },
): Promise<BotOrderRow[]> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? BOT_PAGE_SIZE, 20));
  const page = Math.max(0, options.page ?? 0);
  const condition = statusCondition(options.filter);
  const query = db
    .select(orderColumns)
    .from(orders)
    .leftJoin(wilayas, eq(wilayas.id, orders.wilayaId))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(pageSize)
    .offset(page * pageSize);
  if (condition) return query.where(condition).all();
  return query.all();
}

export async function countOrders(db: AppDb, filter: OrderFilter): Promise<number> {
  const condition = statusCondition(filter);
  const query = db.select({ count: sql<number>`count(*)` }).from(orders);
  const row = condition ? await query.where(condition).get() : await query.get();
  return Number(row?.count ?? 0);
}

export async function orderCountsByStatus(db: AppDb): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: orders.status, count: sql<number>`count(*)` })
    .from(orders)
    .groupBy(orders.status)
    .all();
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = Number(row.count);
  counts.all = Object.values(counts).reduce((sum, value) => sum + value, 0);
  counts.active = ACTIVE_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  return counts;
}

/** Digits-only phone matcher that tolerates +213 / 0 prefixes and spacing. */
export function normalizePhoneQuery(input: string): string {
  // Order numbers and names also contain digits — only treat letter-free input
  // as a phone so `ORD-20261019-0042` never matches by phone.
  if (/[a-zA-Z\u0600-\u06FF]/.test(input)) return "";
  const digits = input.replace(/[^\d]/g, "");
  if (digits.startsWith("213")) return `0${digits.slice(3)}`;
  return digits;
}

export async function findOrdersByQuery(
  db: AppDb,
  input: string,
  limit = 6,
): Promise<BotOrderRow[]> {
  const term = input.trim();
  if (!term) return [];
  const digits = normalizePhoneQuery(term);
  const conditions = [like(orders.orderNumber, `%${term.replace(/[%_]/g, "")}%`)];
  if (digits.length >= 6) conditions.push(like(orders.phone, `%${digits.slice(-9)}%`));
  if (term.length >= 3) conditions.push(like(orders.customerName, `%${term.replace(/[%_]/g, "")}%`));
  return db
    .select(orderColumns)
    .from(orders)
    .leftJoin(wilayas, eq(wilayas.id, orders.wilayaId))
    .where(or(...conditions))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(Math.max(1, Math.min(limit, 10)))
    .all();
}

export interface BotOrderDetail {
  order: BotOrderRow & {
    address: string | null;
    city: string | null;
    notes: string | null;
    deliveryType: "home" | "stop_desk";
    deliveryMethod: "unassigned" | "driver" | "company";
    trackingNumber: string | null;
    trackingUrl: string | null;
    driverId: string | null;
    companyId: string | null;
    updatedAt: string;
    customerId: string;
  };
  driverName: string | null;
  companyName: string | null;
  products: Array<{ name: string; variant: string | null; quantity: number; lineTotal: number }>;
  customer: { totalOrders: number; deliveredOrders: number; returnedOrders: number };
  history: Array<{ status: string; timestamp: string }>;
}

export async function getOrderDetail(db: AppDb, orderId: string): Promise<BotOrderDetail | null> {
  const order = await db
    .select({
      ...orderColumns,
      address: orders.address,
      city: orders.city,
      notes: orders.notes,
      deliveryType: orders.deliveryType,
      deliveryMethod: orders.deliveryMethod,
      trackingNumber: orders.trackingNumber,
      trackingUrl: orders.trackingUrl,
      driverId: orders.driverId,
      companyId: orders.companyId,
      updatedAt: orders.updatedAt,
      customerId: orders.customerId,
    })
    .from(orders)
    .leftJoin(wilayas, eq(wilayas.id, orders.wilayaId))
    .where(eq(orders.id, orderId))
    .get();
  if (!order) return null;

  const [products, driver, company, customer, history] = await Promise.all([
    db
      .select({
        name: orderProducts.productName,
        variant: orderProducts.variantLabel,
        quantity: orderProducts.quantity,
        lineTotal: orderProducts.lineTotal,
      })
      .from(orderProducts)
      .where(eq(orderProducts.orderId, orderId))
      .all(),
    order.driverId
      ? db
          .select({ firstName: drivers.firstName, lastName: drivers.lastName })
          .from(drivers)
          .where(eq(drivers.id, order.driverId))
          .get()
      : Promise.resolve(undefined),
    order.companyId
      ? db
          .select({ name: deliveryCompanies.name })
          .from(deliveryCompanies)
          .where(eq(deliveryCompanies.id, order.companyId))
          .get()
      : Promise.resolve(undefined),
    (async () => {
      const row = await db
        .select({ totalOrders: customers.totalOrders })
        .from(customers)
        .where(eq(customers.id, order.customerId))
        .get();
      if (!row) return { totalOrders: 0, deliveredOrders: 0, returnedOrders: 0 };
      const stats = await db
        .select({
          delivered: sql<number>`COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0)`,
          returned: sql<number>`COALESCE(SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END), 0)`,
        })
        .from(orders)
        .where(eq(orders.customerId, order.customerId))
        .get();
      return {
        totalOrders: Number(row.totalOrders ?? 0),
        deliveredOrders: Number(stats?.delivered ?? 0),
        returnedOrders: Number(stats?.returned ?? 0),
      };
    })(),
    db
      .select({ status: orderStatusHistory.status, timestamp: orderStatusHistory.timestamp })
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(desc(orderStatusHistory.timestamp))
      .limit(3)
      .all(),
  ]);

  return {
    order,
    driverName: driver ? [driver.firstName, driver.lastName].filter(Boolean).join(" ") : null,
    companyName: company?.name ?? null,
    products,
    customer,
    history,
  };
}

export async function findOrderByReference(db: AppDb, reference: string): Promise<BotOrderDetail | null> {
  const trimmed = reference.trim();
  if (!trimmed) return null;
  const direct = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, trimmed))
    .get();
  if (direct) return getOrderDetail(db, direct.id);

  const byNumber = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.orderNumber, trimmed.toUpperCase()))
    .get();
  if (byNumber) return getOrderDetail(db, byNumber.id);

  const matches = await findOrdersByQuery(db, trimmed, 1);
  return matches[0] ? getOrderDetail(db, matches[0].id) : null;
}

export async function listStatusesForFilters(db: AppDb) {
  return orderCountsByStatus(db);
}

export { ACTIVE_STATUSES };
