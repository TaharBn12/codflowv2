/**
 * Customer lookup for the bot (`/customer`, customer search).
 * Read-only: shows the same reliability picture a confirmer needs before
 * calling back a returner.
 */

import { desc, eq, like, or, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { customers, orders, wilayas } from "@/db/schema";
import { normalizePhoneQuery } from "./order-queries";

export interface CustomerRow {
  id: string;
  name: string;
  phone: string;
  wilayaName: string | null;
  wilayaNameAr: string | null;
  totalOrders: number;
  totalSpent: number;
  createdAt: string;
  lastOrderAt: string | null;
}

const columns = {
  id: customers.id,
  name: customers.name,
  phone: customers.phone,
  wilayaName: wilayas.name,
  wilayaNameAr: wilayas.nameAr,
  totalOrders: customers.totalOrders,
  totalSpent: customers.totalSpent,
  createdAt: customers.createdAt,
  lastOrderAt: customers.lastOrderAt,
};

export async function searchCustomers(db: AppDb, query: string, limit = 5): Promise<CustomerRow[]> {
  const term = query.trim();
  if (!term) return [];
  const digits = normalizePhoneQuery(term);
  const conditions = [like(customers.name, `%${term.replace(/[%_]/g, "")}%`)];
  if (digits.length >= 6) conditions.push(like(customers.phone, `%${digits.slice(-9)}%`));
  return db
    .select(columns)
    .from(customers)
    .leftJoin(wilayas, eq(wilayas.id, customers.wilayaId))
    .where(or(...conditions))
    .orderBy(desc(customers.lastOrderAt), desc(customers.createdAt))
    .limit(Math.max(1, Math.min(limit, 10)))
    .all();
}

export interface CustomerDetail {
  customer: CustomerRow & { address: string | null };
  stats: { delivered: number; returned: number; cancelled: number; inProgress: number };
  recentOrders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    price: number;
    createdAt: string;
  }>;
}

export async function getCustomerDetail(db: AppDb, customerId: string): Promise<CustomerDetail | null> {
  const customer = await db
    .select({ ...columns, address: customers.address })
    .from(customers)
    .leftJoin(wilayas, eq(wilayas.id, customers.wilayaId))
    .where(eq(customers.id, customerId))
    .get();
  if (!customer) return null;
  const [statsRow, recentOrders] = await Promise.all([
    db
      .select({
        delivered: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'delivered' THEN 1 ELSE 0 END), 0)`,
        returned: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'returned' THEN 1 ELSE 0 END), 0)`,
        cancelled: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'cancelled' THEN 1 ELSE 0 END), 0)`,
        inProgress: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} IN ('new','confirmed','unreachable','preparing','ready','assigned','dispatched','out_for_delivery') THEN 1 ELSE 0 END), 0)`,
      })
      .from(orders)
      .where(eq(orders.customerId, customerId))
      .get(),
    db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        price: orders.price,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(eq(orders.customerId, customerId))
      .orderBy(desc(orders.createdAt))
      .limit(5)
      .all(),
  ]);
  return {
    customer,
    stats: {
      delivered: Number(statsRow?.delivered ?? 0),
      returned: Number(statsRow?.returned ?? 0),
      cancelled: Number(statsRow?.cancelled ?? 0),
      inProgress: Number(statsRow?.inProgress ?? 0),
    },
    recentOrders,
  };
}
