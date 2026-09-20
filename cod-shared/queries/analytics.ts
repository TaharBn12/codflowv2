/**
 * Analytics Queries
 *
 * Optimized read-only queries for dashboard and reporting endpoints.
 * Each function performs a small number of efficient DB round-trips — no
 * client-side aggregation of raw orders.
 *
 * Conventions
 * - Periods are half-open ISO instants: `from <= created_at < to`.
 * - Metrics are **cohort based**: an order belongs to the period it was
 *   placed in, and its current status decides which bucket it counts toward.
 *   This is the standard way COD teams read confirmation / delivery / return
 *   rates ("of the orders we received this week, how many got delivered?").
 * - `tzOffsetMinutes` shifts calendar bucketing (day / week / month) to the
 *   store's local time (Algeria = +60).
 * - `confirmerId` restricts every order-based metric to the orders assigned
 *   to that confirmer (their personal dashboard).
 */

import { eq, sql } from "drizzle-orm";
import type { AppDb } from "../db/client";
import {
  businessExpenses,
  dashboardLayouts,
  dashboardReportConfig,
  orders,
  type ExpenseCategory,
  type OrderStatus,
} from "../db/schema";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface OrderStatusStat {
  status: OrderStatus;
  count: number;
}

export interface AnalyticsRange {
  /** ISO instant, inclusive */
  from: string;
  /** ISO instant, exclusive */
  to: string;
}

export type Granularity = "day" | "week" | "month";

// ─── Status groups (constant SQL fragments — never user input) ────────────────

const CONFIRMED_PLUS = sql.raw(
  "('confirmed','preparing','ready','assigned','dispatched','out_for_delivery','delivered','returned')",
);
const IN_PROGRESS = sql.raw(
  "('new','confirmed','unreachable','preparing','ready','assigned','dispatched','out_for_delivery')",
);
const IN_TRANSIT = sql.raw("('assigned','dispatched','out_for_delivery')");

function confirmerScope(confirmerId?: string, alias = "orders") {
  if (!confirmerId) return sql``;
  return sql` AND EXISTS (SELECT 1 FROM order_confirmation_assignments ca WHERE ca.order_id = ${sql.raw(alias)}.id AND ca.assignee_id = ${confirmerId})`;
}

function tzModifier(tzOffsetMinutes: number) {
  const minutes = Number.isFinite(tzOffsetMinutes) ? Math.trunc(tzOffsetMinutes) : 0;
  const clamped = Math.max(-840, Math.min(840, minutes));
  return sql.raw(`'${clamped >= 0 ? "+" : "-"}${Math.abs(clamped)} minutes'`);
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Store-local calendar day (YYYY-MM-DD) of an ISO instant. */
export function localDate(iso: string, tzOffsetMinutes: number): string {
  const shifted = new Date(new Date(iso).getTime() + tzOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

// ─── Status breakdown (legacy dashboard cards) ───────────────────────────────

/**
 * Returns the count of orders grouped by status in a single query.
 * Only statuses that have at least one order are returned.
 * The caller is responsible for filling in zeros for absent statuses.
 */
export async function getOrderStatusStats(
  db: AppDb,
  confirmerId?: string,
): Promise<OrderStatusStat[]> {
  const rows = await db
    .select({
      status: orders.status,
      count: sql<number>`count(*)`,
    })
    .from(orders)
    .where(
      confirmerId
        ? sql`EXISTS (SELECT 1 FROM order_confirmation_assignments ca WHERE ca.order_id = ${orders.id} AND ca.assignee_id = ${confirmerId})`
        : undefined,
    )
    .groupBy(orders.status)
    .all();

  return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
}

// ─── Overview KPIs ────────────────────────────────────────────────────────────

export interface OverviewTotals {
  totalOrders: number;
  confirmedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  cancelledOrders: number;
  pendingConfirmation: number;
  inTransit: number;
  revenueDelivered: number;
  deliveryFeesDelivered: number;
  revenuePending: number;
  revenueLostReturns: number;
  avgOrderValue: number;
  confirmationRate: number | null;
  deliveryRate: number | null;
  returnRate: number | null;
  cancellationRate: number | null;
}

export interface OverviewResult {
  range: AnalyticsRange;
  previousRange: AnalyticsRange;
  current: OverviewTotals;
  previous: OverviewTotals;
}

interface OverviewRow {
  total_orders: number;
  confirmed_orders: number;
  delivered_orders: number;
  returned_orders: number;
  cancelled_orders: number;
  pending_confirmation: number;
  in_transit: number;
  revenue_delivered: number;
  delivery_fees_delivered: number;
  revenue_pending: number;
  revenue_lost_returns: number;
  avg_order_value: number | null;
}

function toTotals(row: OverviewRow | undefined): OverviewTotals {
  const total = num(row?.total_orders);
  const confirmed = num(row?.confirmed_orders);
  const delivered = num(row?.delivered_orders);
  const returned = num(row?.returned_orders);
  const cancelled = num(row?.cancelled_orders);
  return {
    totalOrders: total,
    confirmedOrders: confirmed,
    deliveredOrders: delivered,
    returnedOrders: returned,
    cancelledOrders: cancelled,
    pendingConfirmation: num(row?.pending_confirmation),
    inTransit: num(row?.in_transit),
    revenueDelivered: num(row?.revenue_delivered),
    deliveryFeesDelivered: num(row?.delivery_fees_delivered),
    revenuePending: num(row?.revenue_pending),
    revenueLostReturns: num(row?.revenue_lost_returns),
    avgOrderValue: Math.round(num(row?.avg_order_value)),
    confirmationRate: rate(confirmed, total),
    deliveryRate: rate(delivered, delivered + returned),
    returnRate: rate(returned, delivered + returned),
    cancellationRate: rate(cancelled, total),
  };
}

async function overviewRow(db: AppDb, range: AnalyticsRange, confirmerId?: string) {
  return db.get<OverviewRow>(sql`
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(status IN ${CONFIRMED_PLUS}), 0) AS confirmed_orders,
      COALESCE(SUM(status = 'delivered'), 0) AS delivered_orders,
      COALESCE(SUM(status = 'returned'), 0) AS returned_orders,
      COALESCE(SUM(status = 'cancelled'), 0) AS cancelled_orders,
      COALESCE(SUM(status IN ('new','unreachable')), 0) AS pending_confirmation,
      COALESCE(SUM(status IN ${IN_TRANSIT}), 0) AS in_transit,
      COALESCE(SUM(CASE WHEN status = 'delivered' THEN price ELSE 0 END), 0) AS revenue_delivered,
      COALESCE(SUM(CASE WHEN status = 'delivered' THEN delivery_fee ELSE 0 END), 0) AS delivery_fees_delivered,
      COALESCE(SUM(CASE WHEN status IN ${IN_PROGRESS} THEN price ELSE 0 END), 0) AS revenue_pending,
      COALESCE(SUM(CASE WHEN status = 'returned' THEN price ELSE 0 END), 0) AS revenue_lost_returns,
      AVG(CASE WHEN status <> 'cancelled' THEN price END) AS avg_order_value
    FROM orders
    WHERE created_at >= ${range.from} AND created_at < ${range.to}${confirmerScope(confirmerId)}
  `);
}

export function previousRange(range: AnalyticsRange): AnalyticsRange {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  const length = Math.max(to - from, 60_000);
  return {
    from: new Date(from - length).toISOString(),
    to: new Date(from).toISOString(),
  };
}

export async function getAnalyticsOverview(
  db: AppDb,
  range: AnalyticsRange,
  confirmerId?: string,
): Promise<OverviewResult> {
  const prev = previousRange(range);
  const [current, previous] = await Promise.all([
    overviewRow(db, range, confirmerId),
    overviewRow(db, prev, confirmerId),
  ]);
  return {
    range,
    previousRange: prev,
    current: toTotals(current),
    previous: toTotals(previous),
  };
}

// ─── Time series ──────────────────────────────────────────────────────────────

export interface TimeseriesPoint {
  period: string;
  orders: number;
  confirmed: number;
  delivered: number;
  returned: number;
  cancelled: number;
  revenueDelivered: number;
  revenuePending: number;
}

function bucketExpression(granularity: Granularity, tz: ReturnType<typeof tzModifier>) {
  switch (granularity) {
    case "week":
      return sql`date(created_at, ${tz}, '-6 days', 'weekday 1')`;
    case "month":
      return sql`strftime('%Y-%m', created_at, ${tz})`;
    default:
      return sql`strftime('%Y-%m-%d', created_at, ${tz})`;
  }
}

/** Every bucket key between from/to (store-local), so charts never have holes. */
export function bucketKeys(range: AnalyticsRange, granularity: Granularity, tzOffsetMinutes: number): string[] {
  const shift = tzOffsetMinutes * 60_000;
  const start = new Date(new Date(range.from).getTime() + shift);
  const end = new Date(new Date(range.to).getTime() + shift - 1);
  const keys: string[] = [];
  if (granularity === "month") {
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cursor <= end && keys.length < 400) {
      keys.push(cursor.toISOString().slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return keys;
  }
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  if (granularity === "week") {
    const day = cursor.getUTCDay();
    cursor.setUTCDate(cursor.getUTCDate() - ((day + 6) % 7));
  }
  const step = granularity === "week" ? 7 : 1;
  while (cursor <= end && keys.length < 1000) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + step);
  }
  return keys;
}

export async function getAnalyticsTimeseries(
  db: AppDb,
  range: AnalyticsRange,
  granularity: Granularity,
  tzOffsetMinutes: number,
  confirmerId?: string,
): Promise<TimeseriesPoint[]> {
  const tz = tzModifier(tzOffsetMinutes);
  const bucket = bucketExpression(granularity, tz);
  const rows = await db.all<{
    period: string;
    orders: number;
    confirmed: number;
    delivered: number;
    returned: number;
    cancelled: number;
    revenue_delivered: number;
    revenue_pending: number;
  }>(sql`
    SELECT
      ${bucket} AS period,
      COUNT(*) AS orders,
      COALESCE(SUM(status IN ${CONFIRMED_PLUS}), 0) AS confirmed,
      COALESCE(SUM(status = 'delivered'), 0) AS delivered,
      COALESCE(SUM(status = 'returned'), 0) AS returned,
      COALESCE(SUM(status = 'cancelled'), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN status = 'delivered' THEN price ELSE 0 END), 0) AS revenue_delivered,
      COALESCE(SUM(CASE WHEN status IN ${IN_PROGRESS} THEN price ELSE 0 END), 0) AS revenue_pending
    FROM orders
    WHERE created_at >= ${range.from} AND created_at < ${range.to}${confirmerScope(confirmerId)}
    GROUP BY period
    ORDER BY period
  `);

  const byPeriod = new Map(rows.map((row) => [String(row.period), row]));
  return bucketKeys(range, granularity, tzOffsetMinutes).map((period) => {
    const row = byPeriod.get(period);
    return {
      period,
      orders: num(row?.orders),
      confirmed: num(row?.confirmed),
      delivered: num(row?.delivered),
      returned: num(row?.returned),
      cancelled: num(row?.cancelled),
      revenueDelivered: num(row?.revenue_delivered),
      revenuePending: num(row?.revenue_pending),
    };
  });
}

// ─── Wilaya heatmap ───────────────────────────────────────────────────────────

export interface WilayaStat {
  wilayaId: number | null;
  name: string | null;
  nameAr: string | null;
  orders: number;
  delivered: number;
  returned: number;
  cancelled: number;
  inProgress: number;
  revenueDelivered: number;
  deliveryRate: number | null;
  returnRate: number | null;
}

export async function getWilayaAnalytics(
  db: AppDb,
  range: AnalyticsRange,
  confirmerId?: string,
): Promise<WilayaStat[]> {
  const rows = await db.all<{
    wilaya_id: number | null;
    name: string | null;
    name_ar: string | null;
    orders: number;
    delivered: number;
    returned: number;
    cancelled: number;
    in_progress: number;
    revenue_delivered: number;
  }>(sql`
    SELECT
      o.wilaya_id,
      w.name,
      w.name_ar,
      COUNT(*) AS orders,
      COALESCE(SUM(o.status = 'delivered'), 0) AS delivered,
      COALESCE(SUM(o.status = 'returned'), 0) AS returned,
      COALESCE(SUM(o.status = 'cancelled'), 0) AS cancelled,
      COALESCE(SUM(o.status IN ${IN_PROGRESS}), 0) AS in_progress,
      COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.price ELSE 0 END), 0) AS revenue_delivered
    FROM orders o
    LEFT JOIN wilayas w ON w.id = o.wilaya_id
    WHERE o.created_at >= ${range.from} AND o.created_at < ${range.to}${confirmerScope(confirmerId, "o")}
    GROUP BY o.wilaya_id
    ORDER BY orders DESC
  `);

  return rows.map((row) => {
    const delivered = num(row.delivered);
    const returned = num(row.returned);
    return {
      wilayaId: row.wilaya_id == null ? null : Number(row.wilaya_id),
      name: row.name,
      nameAr: row.name_ar,
      orders: num(row.orders),
      delivered,
      returned,
      cancelled: num(row.cancelled),
      inProgress: num(row.in_progress),
      revenueDelivered: num(row.revenue_delivered),
      deliveryRate: rate(delivered, delivered + returned),
      returnRate: rate(returned, delivered + returned),
    };
  });
}

// ─── Product performance ──────────────────────────────────────────────────────

export interface ProductStat {
  productId: string;
  name: string;
  image: string | null;
  orders: number;
  deliveredOrders: number;
  returnedOrders: number;
  unitsDelivered: number;
  unitsReturned: number;
  revenueDelivered: number;
  cogs: number;
  grossProfit: number | null;
  hasCostPrice: boolean;
  deliveryRate: number | null;
  returnRate: number | null;
}

export async function getProductAnalytics(
  db: AppDb,
  range: AnalyticsRange,
  limit = 100,
  confirmerId?: string,
): Promise<ProductStat[]> {
  const rows = await db.all<{
    product_id: string;
    name: string;
    image: string | null;
    orders: number;
    delivered_orders: number;
    returned_orders: number;
    units_delivered: number;
    units_returned: number;
    revenue_delivered: number;
    cogs: number;
    cost_price: number | null;
  }>(sql`
    SELECT
      op.product_id,
      COALESCE(p.name, MAX(op.product_name)) AS name,
      (SELECT COALESCE(pi.src_sm, pi.src) FROM product_images pi WHERE pi.product_id = op.product_id ORDER BY pi.position ASC LIMIT 1) AS image,
      COUNT(DISTINCT op.order_id) AS orders,
      COUNT(DISTINCT CASE WHEN o.status = 'delivered' THEN op.order_id END) AS delivered_orders,
      COUNT(DISTINCT CASE WHEN o.status = 'returned' THEN op.order_id END) AS returned_orders,
      COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN op.quantity - op.returned_quantity ELSE 0 END), 0) AS units_delivered,
      COALESCE(SUM(CASE WHEN o.status = 'returned' THEN op.quantity WHEN o.status = 'delivered' THEN op.returned_quantity ELSE 0 END), 0) AS units_returned,
      COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN op.price_per_unit * (op.quantity - op.returned_quantity) ELSE 0 END), 0) AS revenue_delivered,
      COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN COALESCE(p.cost_price, 0) * (op.quantity - op.returned_quantity) ELSE 0 END), 0) AS cogs,
      p.cost_price
    FROM order_products op
    JOIN orders o ON o.id = op.order_id
    LEFT JOIN products p ON p.id = op.product_id
    WHERE o.created_at >= ${range.from} AND o.created_at < ${range.to}${confirmerScope(confirmerId, "o")}
    GROUP BY op.product_id
    ORDER BY orders DESC
    LIMIT ${Math.max(1, Math.min(500, limit))}
  `);

  return rows.map((row) => {
    const delivered = num(row.delivered_orders);
    const returned = num(row.returned_orders);
    const revenue = num(row.revenue_delivered);
    const cogs = num(row.cogs);
    const hasCostPrice = row.cost_price != null;
    return {
      productId: row.product_id,
      name: row.name,
      image: row.image,
      orders: num(row.orders),
      deliveredOrders: delivered,
      returnedOrders: returned,
      unitsDelivered: num(row.units_delivered),
      unitsReturned: num(row.units_returned),
      revenueDelivered: revenue,
      cogs,
      grossProfit: hasCostPrice ? revenue - cogs : null,
      hasCostPrice,
      deliveryRate: rate(delivered, delivered + returned),
      returnRate: rate(returned, delivered + returned),
    };
  });
}

// ─── Carrier / driver performance ─────────────────────────────────────────────

export interface CarrierStat {
  key: string;
  kind: "company" | "drivers";
  companyId: string | null;
  name: string;
  nameAr: string | null;
  code: string | null;
  orders: number;
  inTransit: number;
  delivered: number;
  returned: number;
  revenueDelivered: number;
  avgDeliveryDays: number | null;
  avgAttempts: number | null;
  deliveryRate: number | null;
  returnRate: number | null;
}

export async function getCarrierAnalytics(
  db: AppDb,
  range: AnalyticsRange,
  wilayaId?: number,
): Promise<CarrierStat[]> {
  const wilayaFilter = wilayaId ? sql` AND o.wilaya_id = ${wilayaId}` : sql``;
  const rows = await db.all<{
    delivery_method: string;
    company_id: string | null;
    name: string | null;
    name_ar: string | null;
    code: string | null;
    orders: number;
    in_transit: number;
    delivered: number;
    returned: number;
    revenue_delivered: number;
    avg_delivery_days: number | null;
    avg_attempts: number | null;
  }>(sql`
    SELECT
      o.delivery_method,
      o.company_id,
      c.name,
      c.name_ar,
      c.code,
      COUNT(*) AS orders,
      COALESCE(SUM(o.status IN ${IN_TRANSIT}), 0) AS in_transit,
      COALESCE(SUM(o.status = 'delivered'), 0) AS delivered,
      COALESCE(SUM(o.status = 'returned'), 0) AS returned,
      COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.price ELSE 0 END), 0) AS revenue_delivered,
      AVG(CASE WHEN o.status = 'delivered' AND o.delivery_time IS NOT NULL AND o.assigned_at IS NOT NULL
               THEN julianday(o.delivery_time) - julianday(o.assigned_at) END) AS avg_delivery_days,
      AVG(CASE WHEN o.status IN ('delivered','returned') THEN o.delivery_attempts END) AS avg_attempts
    FROM orders o
    LEFT JOIN delivery_companies c ON c.id = o.company_id
    WHERE o.created_at >= ${range.from} AND o.created_at < ${range.to}
      AND o.delivery_method <> 'unassigned'${wilayaFilter}
    GROUP BY o.delivery_method, o.company_id
    ORDER BY orders DESC
  `);

  return rows.map((row) => {
    const delivered = num(row.delivered);
    const returned = num(row.returned);
    const kind = row.delivery_method === "driver" ? "drivers" : "company";
    return {
      key: kind === "drivers" ? "drivers" : `company:${row.company_id ?? "unknown"}`,
      kind,
      companyId: row.company_id,
      name: kind === "drivers" ? "drivers" : (row.name ?? row.company_id ?? "unknown"),
      nameAr: row.name_ar,
      code: row.code,
      orders: num(row.orders),
      inTransit: num(row.in_transit),
      delivered,
      returned,
      revenueDelivered: num(row.revenue_delivered),
      avgDeliveryDays: row.avg_delivery_days == null ? null : Math.round(num(row.avg_delivery_days) * 10) / 10,
      avgAttempts: row.avg_attempts == null ? null : Math.round(num(row.avg_attempts) * 10) / 10,
      deliveryRate: rate(delivered, delivered + returned),
      returnRate: rate(returned, delivered + returned),
    };
  });
}

// ─── Smart alerts ─────────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "warning" | "info";

export interface DashboardAlert {
  id: string;
  severity: AlertSeverity;
  count: number;
  amount?: number;
  href: string;
  items?: Array<{ id: string; label: string; value: number; extra?: string | null }>;
}

const ALERT_UNCONFIRMED_HOURS = 24;
const ALERT_OUT_FOR_DELIVERY_DAYS = 5;
const ALERT_DISPATCHED_DAYS = 7;
const ALERT_CONFIRMED_NOT_SHIPPED_HOURS = 48;
const ALERT_STOCK_RUNWAY_DAYS = 7;
const ALERT_DRIVER_CASH_WARNING = 20_000;
const ALERT_DRIVER_CASH_CRITICAL = 50_000;

function isoMinus(now: Date, ms: number) {
  return new Date(now.getTime() - ms).toISOString();
}

export async function getDashboardAlerts(
  db: AppDb,
  now = new Date(),
  confirmerId?: string,
): Promise<DashboardAlert[]> {
  const nowIso = now.toISOString();
  const hour = 3_600_000;
  const day = 24 * hour;

  const [orderRow, stockRows, runwayRows, driverRows, webhookRows, opsRow] = await Promise.all([
    db.get<{
      unconfirmed: number;
      unreachable: number;
      stuck_out: number;
      stuck_dispatched: number;
      confirmed_not_shipped: number;
    }>(sql`
      SELECT
        COALESCE(SUM(status = 'new' AND created_at < ${isoMinus(now, ALERT_UNCONFIRMED_HOURS * hour)}), 0) AS unconfirmed,
        COALESCE(SUM(status = 'unreachable'), 0) AS unreachable,
        COALESCE(SUM(status = 'out_for_delivery' AND updated_at < ${isoMinus(now, ALERT_OUT_FOR_DELIVERY_DAYS * day)}), 0) AS stuck_out,
        COALESCE(SUM(status = 'dispatched' AND updated_at < ${isoMinus(now, ALERT_DISPATCHED_DAYS * day)}), 0) AS stuck_dispatched,
        COALESCE(SUM(status IN ('confirmed','preparing','ready') AND updated_at < ${isoMinus(now, ALERT_CONFIRMED_NOT_SHIPPED_HOURS * hour)}), 0) AS confirmed_not_shipped
      FROM orders
      WHERE status IN ${IN_PROGRESS}${confirmerScope(confirmerId)}
    `),
    confirmerId
      ? Promise.resolve([] as Array<{ product_id: string; variant_id: string | null; name: string; inventory: number; threshold: number }>)
      : db.all<{ product_id: string; variant_id: string | null; name: string; inventory: number; threshold: number }>(sql`
      SELECT p.id AS product_id, NULL AS variant_id, p.name AS name, p.inventory AS inventory, p.low_stock_threshold AS threshold
      FROM products p
      WHERE p.track_inventory = 1 AND p.status = 'ACTIVE' AND p.low_stock_threshold > 0 AND p.inventory <= p.low_stock_threshold
        AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)
      UNION ALL
      SELECT p.id, v.id, p.name || ' — ' || v.sku, v.inventory, v.low_stock_threshold
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      WHERE p.track_inventory = 1 AND p.status = 'ACTIVE' AND v.active = 1 AND v.low_stock_threshold > 0 AND v.inventory <= v.low_stock_threshold
      ORDER BY inventory ASC
      LIMIT 50
    `),
    confirmerId
      ? Promise.resolve([] as Array<{ product_id: string; name: string; inventory: number; sold_14d: number }>)
      : db.all<{ product_id: string; name: string; inventory: number; sold_14d: number }>(sql`
      SELECT
        p.id AS product_id,
        p.name AS name,
        CASE WHEN EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)
             THEN (SELECT COALESCE(SUM(v.inventory), 0) FROM product_variants v WHERE v.product_id = p.id)
             ELSE p.inventory END AS inventory,
        COALESCE((
          SELECT SUM(op.quantity) FROM order_products op JOIN orders o ON o.id = op.order_id
          WHERE op.product_id = p.id AND o.status <> 'cancelled' AND o.created_at >= ${isoMinus(now, 14 * day)}
        ), 0) AS sold_14d
      FROM products p
      WHERE p.track_inventory = 1 AND p.status = 'ACTIVE'
    `),
    confirmerId
      ? Promise.resolve([] as Array<{ id: string; name: string; pending_cash: number }>)
      : db.all<{ id: string; name: string; pending_cash: number }>(sql`
      SELECT id, first_name || ' ' || last_name AS name, pending_cash
      FROM drivers
      WHERE pending_cash > 0
      ORDER BY pending_cash DESC
      LIMIT 5
    `),
    confirmerId
      ? Promise.resolve([] as Array<{ provider: string; errors_24h: number; last_at: string | null }>)
      : db.all<{ provider: string; errors_24h: number; last_at: string | null }>(sql`
      SELECT provider,
        COALESCE(SUM(result = 'error' AND created_at >= ${isoMinus(now, day)}), 0) AS errors_24h,
        MAX(created_at) AS last_at
      FROM webhook_events
      GROUP BY provider
    `),
    db.get<{
      overdue_tasks: number;
      pending_approvals: number;
      abandoned_24h: number;
      open_support: number;
      unread_support: number;
      overdue_tickets: number;
    }>(sql`
      SELECT
        (SELECT COUNT(*) FROM operation_tasks t WHERE t.status IN ('open','in_progress') AND t.due_at IS NOT NULL AND t.due_at < ${nowIso}${confirmerId ? sql` AND t.assignee_id = ${confirmerId}` : sql``}) AS overdue_tasks,
        (SELECT COUNT(*) FROM admin_approval_requests r WHERE r.status = 'pending' AND r.expires_at > ${nowIso}) AS pending_approvals,
        (SELECT COUNT(*) FROM abandoned_orders a WHERE a.status = 'abandoned' AND a.created_at >= ${isoMinus(now, day)}) AS abandoned_24h,
        (SELECT COUNT(*) FROM support_conversations s WHERE s.status IN ('open','pending')) AS open_support,
        (SELECT COALESCE(SUM(s.unread_count), 0) FROM support_conversations s WHERE s.status IN ('open','pending')) AS unread_support,
        (SELECT COUNT(*) FROM support_tickets k WHERE k.status NOT IN ('resolved','closed') AND k.due_at IS NOT NULL AND k.due_at < ${nowIso}) AS overdue_tickets
    `),
  ]);

  const alerts: DashboardAlert[] = [];
  const push = (alert: DashboardAlert) => {
    if (alert.count > 0) alerts.push(alert);
  };

  push({ id: "unconfirmed_orders", severity: "critical", count: num(orderRow?.unconfirmed), href: "/orders?status=new" });
  push({ id: "unreachable_orders", severity: "warning", count: num(orderRow?.unreachable), href: "/orders?status=unreachable" });
  push({ id: "stuck_out_for_delivery", severity: "critical", count: num(orderRow?.stuck_out), href: "/orders?status=out_for_delivery" });
  push({ id: "stuck_dispatched", severity: "warning", count: num(orderRow?.stuck_dispatched), href: "/orders?status=dispatched" });
  push({ id: "confirmed_not_shipped", severity: "warning", count: num(orderRow?.confirmed_not_shipped), href: "/orders?status=confirmed" });

  if (stockRows.length) {
    const outOfStock = stockRows.filter((row) => num(row.inventory) <= 0);
    push({
      id: "low_stock",
      severity: outOfStock.length ? "critical" : "warning",
      count: stockRows.length,
      href: "/products/stock",
      items: stockRows.slice(0, 5).map((row) => ({
        id: row.variant_id ?? row.product_id,
        label: row.name,
        value: num(row.inventory),
      })),
    });
  }

  const runway = runwayRows
    .map((row) => {
      const velocity = num(row.sold_14d) / 14;
      const inventory = num(row.inventory);
      const days = velocity > 0 ? inventory / velocity : Number.POSITIVE_INFINITY;
      return { ...row, inventory, velocity, days };
    })
    .filter((row) => row.velocity > 0 && row.inventory > 0 && row.days <= ALERT_STOCK_RUNWAY_DAYS)
    .sort((a, b) => a.days - b.days);
  if (runway.length) {
    push({
      id: "stock_runway",
      severity: runway.some((row) => row.days <= 3) ? "critical" : "warning",
      count: runway.length,
      href: "/products/stock",
      items: runway.slice(0, 5).map((row) => ({
        id: row.product_id,
        label: row.name,
        value: Math.max(1, Math.round(row.days)),
        extra: String(row.inventory),
      })),
    });
  }

  if (driverRows.length) {
    const total = driverRows.reduce((sum, row) => sum + num(row.pending_cash), 0);
    const max = Math.max(...driverRows.map((row) => num(row.pending_cash)));
    push({
      id: "driver_cash",
      severity: max >= ALERT_DRIVER_CASH_CRITICAL ? "critical" : max >= ALERT_DRIVER_CASH_WARNING ? "warning" : "info",
      count: driverRows.length,
      amount: total,
      href: "/delivery/drivers",
      items: driverRows.map((row) => ({ id: row.id, label: row.name, value: num(row.pending_cash) })),
    });
  }

  const webhookProblems = webhookRows.filter((row) => num(row.errors_24h) > 0);
  if (webhookProblems.length) {
    push({
      id: "webhook_errors",
      severity: "warning",
      count: webhookProblems.reduce((sum, row) => sum + num(row.errors_24h), 0),
      href: "/delivery/companies",
      items: webhookProblems.map((row) => ({ id: row.provider, label: row.provider, value: num(row.errors_24h), extra: row.last_at })),
    });
  }

  push({ id: "overdue_tasks", severity: "warning", count: num(opsRow?.overdue_tasks), href: "/operations" });
  if (!confirmerId) {
    push({ id: "pending_approvals", severity: "info", count: num(opsRow?.pending_approvals), href: "/settings" });
    push({ id: "overdue_tickets", severity: "warning", count: num(opsRow?.overdue_tickets), href: "/support" });
    push({ id: "unread_support", severity: "info", count: num(opsRow?.unread_support), href: "/support" });
  }
  push({ id: "abandoned_24h", severity: "info", count: num(opsRow?.abandoned_24h), href: "/orders/abandoned" });

  const weight: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => weight[a.severity] - weight[b.severity]);
}

// ─── Today board ──────────────────────────────────────────────────────────────

export interface TodayBoard {
  toConfirm: number;
  toRetry: number;
  toPrepare: number;
  toShip: number;
  inTransit: number;
  lateShipments: number;
  ordersToday: number;
  deliveredToday: number;
  revenueDeliveredToday: number;
  returnedToday: number;
  cancelledToday: number;
  myOpenTasks: number;
  myOverdueTasks: number;
  pendingApprovals: number;
  openConversations: number;
  driversPendingCash: number;
}

export async function getTodayBoard(
  db: AppDb,
  startOfDayIso: string,
  actor: { id: string; role: string },
  now = new Date(),
): Promise<TodayBoard> {
  const confirmerId = actor.role === "confirmer" ? actor.id : undefined;
  const nowIso = now.toISOString();
  const day = 24 * 3_600_000;
  const [queue, today, mine, ops] = await Promise.all([
    db.get<{ to_confirm: number; to_retry: number; to_prepare: number; to_ship: number; in_transit: number; late: number }>(sql`
      SELECT
        COALESCE(SUM(status = 'new'), 0) AS to_confirm,
        COALESCE(SUM(status = 'unreachable'), 0) AS to_retry,
        COALESCE(SUM(status = 'confirmed'), 0) AS to_prepare,
        COALESCE(SUM(status IN ('preparing','ready')), 0) AS to_ship,
        COALESCE(SUM(status IN ${IN_TRANSIT}), 0) AS in_transit,
        COALESCE(SUM((status = 'out_for_delivery' AND updated_at < ${isoMinus(now, ALERT_OUT_FOR_DELIVERY_DAYS * day)})
                  OR (status = 'dispatched' AND updated_at < ${isoMinus(now, ALERT_DISPATCHED_DAYS * day)})), 0) AS late
      FROM orders
      WHERE status IN ${IN_PROGRESS}${confirmerScope(confirmerId)}
    `),
    db.get<{ orders_today: number; delivered_today: number; revenue_today: number; returned_today: number; cancelled_today: number }>(sql`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE created_at >= ${startOfDayIso}${confirmerScope(confirmerId)}) AS orders_today,
        (SELECT COUNT(*) FROM orders WHERE status = 'delivered' AND COALESCE(delivery_time, updated_at) >= ${startOfDayIso}${confirmerScope(confirmerId)}) AS delivered_today,
        (SELECT COALESCE(SUM(price), 0) FROM orders WHERE status = 'delivered' AND COALESCE(delivery_time, updated_at) >= ${startOfDayIso}${confirmerScope(confirmerId)}) AS revenue_today,
        (SELECT COUNT(*) FROM orders WHERE status = 'returned' AND updated_at >= ${startOfDayIso}${confirmerScope(confirmerId)}) AS returned_today,
        (SELECT COUNT(*) FROM orders WHERE status = 'cancelled' AND updated_at >= ${startOfDayIso}${confirmerScope(confirmerId)}) AS cancelled_today
    `),
    db.get<{ open_tasks: number; overdue_tasks: number }>(sql`
      SELECT
        COALESCE(SUM(status IN ('open','in_progress')), 0) AS open_tasks,
        COALESCE(SUM(status IN ('open','in_progress') AND due_at IS NOT NULL AND due_at < ${nowIso}), 0) AS overdue_tasks
      FROM operation_tasks
      WHERE assignee_id = ${actor.id}
    `),
    db.get<{ pending_approvals: number; open_conversations: number; drivers_cash: number }>(sql`
      SELECT
        (SELECT COUNT(*) FROM admin_approval_requests WHERE status = 'pending' AND expires_at > ${nowIso}) AS pending_approvals,
        (SELECT COUNT(*) FROM support_conversations WHERE status IN ('open','pending')) AS open_conversations,
        (SELECT COALESCE(SUM(pending_cash), 0) FROM drivers) AS drivers_cash
    `),
  ]);

  return {
    toConfirm: num(queue?.to_confirm),
    toRetry: num(queue?.to_retry),
    toPrepare: num(queue?.to_prepare),
    toShip: num(queue?.to_ship),
    inTransit: num(queue?.in_transit),
    lateShipments: num(queue?.late),
    ordersToday: num(today?.orders_today),
    deliveredToday: num(today?.delivered_today),
    revenueDeliveredToday: num(today?.revenue_today),
    returnedToday: num(today?.returned_today),
    cancelledToday: num(today?.cancelled_today),
    myOpenTasks: num(mine?.open_tasks),
    myOverdueTasks: num(mine?.overdue_tasks),
    pendingApprovals: confirmerId ? 0 : num(ops?.pending_approvals),
    openConversations: confirmerId ? 0 : num(ops?.open_conversations),
    driversPendingCash: confirmerId ? 0 : num(ops?.drivers_cash),
  };
}

// ─── Expenses ─────────────────────────────────────────────────────────────────

export interface ExpenseRecord {
  id: string;
  date: string;
  category: ExpenseCategory;
  platform: string | null;
  amount: number;
  currency: string;
  landingPageId: string | null;
  landingPageName: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseInput {
  date: string;
  category: ExpenseCategory;
  platform?: string | null;
  amount: number;
  landingPageId?: string | null;
  note?: string | null;
}

export async function listExpenses(
  db: AppDb,
  filters: { fromDate: string; toDate: string; category?: ExpenseCategory; landingPageId?: string; limit?: number },
): Promise<ExpenseRecord[]> {
  const rows = await db.all<{
    id: string; date: string; category: ExpenseCategory; platform: string | null; amount: number; currency: string;
    landing_page_id: string | null; landing_page_name: string | null; note: string | null; created_by: string | null;
    created_at: string; updated_at: string;
  }>(sql`
    SELECT e.id, e.date, e.category, e.platform, e.amount, e.currency, e.landing_page_id,
           lp.name AS landing_page_name, e.note, e.created_by, e.created_at, e.updated_at
    FROM business_expenses e
    LEFT JOIN landing_pages lp ON lp.id = e.landing_page_id
    WHERE e.date >= ${filters.fromDate} AND e.date <= ${filters.toDate}
      ${filters.category ? sql`AND e.category = ${filters.category}` : sql``}
      ${filters.landingPageId ? sql`AND e.landing_page_id = ${filters.landingPageId}` : sql``}
    ORDER BY e.date DESC, e.created_at DESC
    LIMIT ${Math.max(1, Math.min(1000, filters.limit ?? 200))}
  `);
  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    category: row.category,
    platform: row.platform,
    amount: num(row.amount),
    currency: row.currency,
    landingPageId: row.landing_page_id,
    landingPageName: row.landing_page_name,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getExpense(db: AppDb, id: string) {
  return db.select().from(businessExpenses).where(eq(businessExpenses.id, id)).get();
}

export async function createExpense(db: AppDb, input: ExpenseInput, createdBy: string | null) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.insert(businessExpenses).values({
    id,
    date: input.date,
    category: input.category,
    platform: input.category === "ads" ? (input.platform ?? "other") : (input.platform ?? null),
    amount: input.amount,
    currency: "DZD",
    landingPageId: input.landingPageId ?? null,
    note: input.note ?? null,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function updateExpense(db: AppDb, id: string, input: Partial<ExpenseInput>) {
  const now = new Date().toISOString();
  await db
    .update(businessExpenses)
    .set({
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.landingPageId !== undefined ? { landingPageId: input.landingPageId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      updatedAt: now,
    })
    .where(eq(businessExpenses.id, id));
}

export async function deleteExpense(db: AppDb, id: string) {
  await db.delete(businessExpenses).where(eq(businessExpenses.id, id));
}

// ─── Profit & Loss ────────────────────────────────────────────────────────────

export interface ProfitAndLoss {
  revenueDelivered: number;
  deliveryFeesCollected: number;
  cogs: number;
  driverFees: number;
  commissions: number;
  expenses: Record<ExpenseCategory, number>;
  totalExpenses: number;
  grossProfit: number;
  netProfit: number;
  netMargin: number | null;
  deliveredOrders: number;
  returnedOrders: number;
  revenueLostReturns: number;
  profitPerDeliveredOrder: number | null;
  unitsWithoutCostPrice: number;
  productsWithoutCostPrice: number;
}

export async function getProfitAndLoss(
  db: AppDb,
  range: AnalyticsRange,
  tzOffsetMinutes: number,
): Promise<ProfitAndLoss> {
  const fromDate = localDate(range.from, tzOffsetMinutes);
  const toDate = localDate(new Date(new Date(range.to).getTime() - 1).toISOString(), tzOffsetMinutes);

  const [orderRow, cogsRow, commissionRow, expenseRows] = await Promise.all([
    db.get<{ revenue: number; fees: number; driver_fees: number; delivered: number; returned: number; lost: number }>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN price ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN delivery_fee ELSE 0 END), 0) AS fees,
        COALESCE(SUM(CASE WHEN status = 'delivered' AND delivery_method = 'driver' THEN driver_fee ELSE 0 END), 0) AS driver_fees,
        COALESCE(SUM(status = 'delivered'), 0) AS delivered,
        COALESCE(SUM(status = 'returned'), 0) AS returned,
        COALESCE(SUM(CASE WHEN status = 'returned' THEN price ELSE 0 END), 0) AS lost
      FROM orders
      WHERE created_at >= ${range.from} AND created_at < ${range.to}
    `),
    db.get<{ cogs: number; units_without_cost: number; products_without_cost: number }>(sql`
      SELECT
        COALESCE(SUM(COALESCE(p.cost_price, 0) * (op.quantity - op.returned_quantity)), 0) AS cogs,
        COALESCE(SUM(CASE WHEN p.cost_price IS NULL THEN op.quantity - op.returned_quantity ELSE 0 END), 0) AS units_without_cost,
        COUNT(DISTINCT CASE WHEN p.cost_price IS NULL THEN op.product_id END) AS products_without_cost
      FROM order_products op
      JOIN orders o ON o.id = op.order_id
      LEFT JOIN products p ON p.id = op.product_id
      WHERE o.status = 'delivered' AND o.created_at >= ${range.from} AND o.created_at < ${range.to}
    `),
    db.get<{ commissions: number }>(sql`
      SELECT COALESCE(SUM(e.amount), 0) AS commissions
      FROM staff_commission_events e
      JOIN orders o ON o.id = e.order_id
      WHERE e.status IN ('earned','paid') AND o.created_at >= ${range.from} AND o.created_at < ${range.to}
    `),
    db.all<{ category: ExpenseCategory; total: number }>(sql`
      SELECT category, COALESCE(SUM(amount), 0) AS total
      FROM business_expenses
      WHERE date >= ${fromDate} AND date <= ${toDate}
      GROUP BY category
    `),
  ]);

  const expenses: Record<ExpenseCategory, number> = { ads: 0, carrier: 0, packaging: 0, salaries: 0, rent: 0, other: 0 };
  for (const row of expenseRows) expenses[row.category] = num(row.total);
  const totalExpenses = Object.values(expenses).reduce((sum, value) => sum + value, 0);

  const revenue = num(orderRow?.revenue);
  const fees = num(orderRow?.fees);
  const cogs = num(cogsRow?.cogs);
  const driverFees = num(orderRow?.driver_fees);
  const commissions = num(commissionRow?.commissions);
  const delivered = num(orderRow?.delivered);
  const grossProfit = revenue + fees - cogs - driverFees;
  const netProfit = grossProfit - commissions - totalExpenses;

  return {
    revenueDelivered: revenue,
    deliveryFeesCollected: fees,
    cogs,
    driverFees,
    commissions,
    expenses,
    totalExpenses,
    grossProfit,
    netProfit,
    netMargin: revenue ? Math.round((netProfit / revenue) * 1000) / 10 : null,
    deliveredOrders: delivered,
    returnedOrders: num(orderRow?.returned),
    revenueLostReturns: num(orderRow?.lost),
    profitPerDeliveredOrder: delivered ? Math.round(netProfit / delivered) : null,
    unitsWithoutCostPrice: num(cogsRow?.units_without_cost),
    productsWithoutCostPrice: num(cogsRow?.products_without_cost),
  };
}

// ─── ROAS ─────────────────────────────────────────────────────────────────────

export interface RoasResult {
  spend: number;
  spendByPlatform: Array<{ platform: string; amount: number }>;
  orders: number;
  confirmedOrders: number;
  deliveredOrders: number;
  revenueDelivered: number;
  revenuePending: number;
  roas: number | null;
  costPerOrder: number | null;
  costPerConfirmedOrder: number | null;
  costPerDeliveredOrder: number | null;
  daily: Array<{ date: string; spend: number; orders: number; delivered: number; revenueDelivered: number }>;
  landingPages: Array<{
    landingPageId: string | null;
    name: string | null;
    spend: number;
    orders: number;
    deliveredOrders: number;
    revenueDelivered: number;
    roas: number | null;
    costPerDeliveredOrder: number | null;
  }>;
}

export async function getRoas(
  db: AppDb,
  range: AnalyticsRange,
  tzOffsetMinutes: number,
  landingPageId?: string,
): Promise<RoasResult> {
  const fromDate = localDate(range.from, tzOffsetMinutes);
  const toDate = localDate(new Date(new Date(range.to).getTime() - 1).toISOString(), tzOffsetMinutes);
  const tz = tzModifier(tzOffsetMinutes);
  const lpOrderFilter = landingPageId ? sql` AND landing_page_id = ${landingPageId}` : sql``;
  const lpSpendFilter = landingPageId ? sql` AND landing_page_id = ${landingPageId}` : sql``;

  const [spendRows, spendDaily, orderTotals, orderDaily, lpSpend, lpOrders] = await Promise.all([
    db.all<{ platform: string | null; amount: number }>(sql`
      SELECT COALESCE(platform, 'other') AS platform, COALESCE(SUM(amount), 0) AS amount
      FROM business_expenses
      WHERE category = 'ads' AND date >= ${fromDate} AND date <= ${toDate}${lpSpendFilter}
      GROUP BY COALESCE(platform, 'other')
      ORDER BY amount DESC
    `),
    db.all<{ date: string; amount: number }>(sql`
      SELECT date, COALESCE(SUM(amount), 0) AS amount
      FROM business_expenses
      WHERE category = 'ads' AND date >= ${fromDate} AND date <= ${toDate}${lpSpendFilter}
      GROUP BY date
    `),
    db.get<{ orders: number; confirmed: number; delivered: number; revenue: number; pending: number }>(sql`
      SELECT
        COUNT(*) AS orders,
        COALESCE(SUM(status IN ${CONFIRMED_PLUS}), 0) AS confirmed,
        COALESCE(SUM(status = 'delivered'), 0) AS delivered,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN price ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN status IN ${IN_PROGRESS} THEN price ELSE 0 END), 0) AS pending
      FROM orders
      WHERE created_at >= ${range.from} AND created_at < ${range.to}${lpOrderFilter}
    `),
    db.all<{ date: string; orders: number; delivered: number; revenue: number }>(sql`
      SELECT strftime('%Y-%m-%d', created_at, ${tz}) AS date,
        COUNT(*) AS orders,
        COALESCE(SUM(status = 'delivered'), 0) AS delivered,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN price ELSE 0 END), 0) AS revenue
      FROM orders
      WHERE created_at >= ${range.from} AND created_at < ${range.to}${lpOrderFilter}
      GROUP BY date
    `),
    db.all<{ landing_page_id: string | null; name: string | null; amount: number }>(sql`
      SELECT e.landing_page_id, lp.name, COALESCE(SUM(e.amount), 0) AS amount
      FROM business_expenses e
      LEFT JOIN landing_pages lp ON lp.id = e.landing_page_id
      WHERE e.category = 'ads' AND e.date >= ${fromDate} AND e.date <= ${toDate}
      GROUP BY e.landing_page_id
    `),
    db.all<{ landing_page_id: string | null; name: string | null; orders: number; delivered: number; revenue: number }>(sql`
      SELECT o.landing_page_id, lp.name,
        COUNT(*) AS orders,
        COALESCE(SUM(o.status = 'delivered'), 0) AS delivered,
        COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.price ELSE 0 END), 0) AS revenue
      FROM orders o
      LEFT JOIN landing_pages lp ON lp.id = o.landing_page_id
      WHERE o.created_at >= ${range.from} AND o.created_at < ${range.to}
      GROUP BY o.landing_page_id
    `),
  ]);

  const spend = spendRows.reduce((sum, row) => sum + num(row.amount), 0);
  const ordersCount = num(orderTotals?.orders);
  const confirmed = num(orderTotals?.confirmed);
  const delivered = num(orderTotals?.delivered);
  const revenue = num(orderTotals?.revenue);

  const spendByDate = new Map(spendDaily.map((row) => [row.date, num(row.amount)]));
  const ordersByDate = new Map(orderDaily.map((row) => [row.date, row]));
  const daily = bucketKeys(range, "day", tzOffsetMinutes).map((date) => {
    const row = ordersByDate.get(date);
    return {
      date,
      spend: spendByDate.get(date) ?? 0,
      orders: num(row?.orders),
      delivered: num(row?.delivered),
      revenueDelivered: num(row?.revenue),
    };
  });

  const lpMap = new Map<string, RoasResult["landingPages"][number]>();
  const lpKey = (id: string | null) => id ?? "__none__";
  for (const row of lpSpend) {
    lpMap.set(lpKey(row.landing_page_id), {
      landingPageId: row.landing_page_id,
      name: row.name,
      spend: num(row.amount),
      orders: 0,
      deliveredOrders: 0,
      revenueDelivered: 0,
      roas: null,
      costPerDeliveredOrder: null,
    });
  }
  for (const row of lpOrders) {
    const key = lpKey(row.landing_page_id);
    const entry = lpMap.get(key) ?? {
      landingPageId: row.landing_page_id,
      name: row.name,
      spend: 0,
      orders: 0,
      deliveredOrders: 0,
      revenueDelivered: 0,
      roas: null,
      costPerDeliveredOrder: null,
    };
    entry.orders = num(row.orders);
    entry.deliveredOrders = num(row.delivered);
    entry.revenueDelivered = num(row.revenue);
    entry.name = entry.name ?? row.name;
    lpMap.set(key, entry);
  }
  const landingPages = [...lpMap.values()]
    .map((entry) => ({
      ...entry,
      roas: entry.spend ? Math.round((entry.revenueDelivered / entry.spend) * 100) / 100 : null,
      costPerDeliveredOrder: entry.deliveredOrders && entry.spend ? Math.round(entry.spend / entry.deliveredOrders) : null,
    }))
    .sort((a, b) => b.spend - a.spend || b.revenueDelivered - a.revenueDelivered);

  return {
    spend,
    spendByPlatform: spendRows.map((row) => ({ platform: row.platform ?? "other", amount: num(row.amount) })),
    orders: ordersCount,
    confirmedOrders: confirmed,
    deliveredOrders: delivered,
    revenueDelivered: revenue,
    revenuePending: num(orderTotals?.pending),
    roas: spend ? Math.round((revenue / spend) * 100) / 100 : null,
    costPerOrder: spend && ordersCount ? Math.round(spend / ordersCount) : null,
    costPerConfirmedOrder: spend && confirmed ? Math.round(spend / confirmed) : null,
    costPerDeliveredOrder: spend && delivered ? Math.round(spend / delivered) : null,
    daily,
    landingPages,
  };
}

// ─── Dashboard layout ─────────────────────────────────────────────────────────

export interface DashboardLayout {
  version: number;
  widgets: Array<{ id: string; hidden: boolean }>;
}

export async function getDashboardLayout(db: AppDb, userId: string): Promise<DashboardLayout | null> {
  const row = await db.select().from(dashboardLayouts).where(eq(dashboardLayouts.userId, userId)).get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.layout) as DashboardLayout;
    if (!parsed || !Array.isArray(parsed.widgets)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveDashboardLayout(db: AppDb, userId: string, layout: DashboardLayout) {
  const now = new Date().toISOString();
  await db
    .insert(dashboardLayouts)
    .values({ userId, layout: JSON.stringify(layout), updatedAt: now })
    .onConflictDoUpdate({ target: dashboardLayouts.userId, set: { layout: JSON.stringify(layout), updatedAt: now } });
}

// ─── Daily report config ──────────────────────────────────────────────────────

export interface ReportConfig {
  enabled: boolean;
  sendHour: number;
  timezone: string;
  telegramEnabled: boolean;
  emailEnabled: boolean;
  emailRecipients: string[];
  lastSentOn: string | null;
}

export const DEFAULT_REPORT_CONFIG: ReportConfig = {
  enabled: false,
  sendHour: 20,
  timezone: "Africa/Algiers",
  telegramEnabled: true,
  emailEnabled: false,
  emailRecipients: [],
  lastSentOn: null,
};

export async function getReportConfig(db: AppDb): Promise<ReportConfig> {
  const row = await db.select().from(dashboardReportConfig).where(eq(dashboardReportConfig.id, "default")).get();
  if (!row) return DEFAULT_REPORT_CONFIG;
  let recipients: string[] = [];
  try {
    const parsed = JSON.parse(row.emailRecipients);
    if (Array.isArray(parsed)) recipients = parsed.filter((value): value is string => typeof value === "string");
  } catch {}
  return {
    enabled: Boolean(row.enabled),
    sendHour: row.sendHour,
    timezone: row.timezone,
    telegramEnabled: Boolean(row.telegramEnabled),
    emailEnabled: Boolean(row.emailEnabled),
    emailRecipients: recipients,
    lastSentOn: row.lastSentOn,
  };
}

export async function saveReportConfig(
  db: AppDb,
  input: Omit<ReportConfig, "lastSentOn">,
  updatedBy: string | null,
) {
  const now = new Date().toISOString();
  const values = {
    enabled: input.enabled,
    sendHour: input.sendHour,
    timezone: input.timezone,
    telegramEnabled: input.telegramEnabled,
    emailEnabled: input.emailEnabled,
    emailRecipients: JSON.stringify(input.emailRecipients),
    updatedBy,
    updatedAt: now,
  };
  await db
    .insert(dashboardReportConfig)
    .values({ id: "default", ...values, createdAt: now })
    .onConflictDoUpdate({ target: dashboardReportConfig.id, set: values });
}

export async function markReportSent(db: AppDb, localDay: string) {
  const now = new Date().toISOString();
  await db
    .insert(dashboardReportConfig)
    .values({ id: "default", lastSentOn: localDay, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: dashboardReportConfig.id, set: { lastSentOn: localDay, updatedAt: now } });
}
