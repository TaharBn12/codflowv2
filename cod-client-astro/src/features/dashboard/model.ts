import type { DashboardLayout, OrderStatusStat } from "../../../../cod-shared/queries/analytics";
import type { OrderStatus } from "@/features/orders/types";

export const DASHBOARD_STATUSES: OrderStatus[] = [
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

export function fillStatusStats(stats: OrderStatusStat[]): Array<{ status: OrderStatus; count: number }> {
  const counts = new Map(stats.map((stat) => [stat.status, stat.count]));
  return DASHBOARD_STATUSES.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

// ─── Date ranges ──────────────────────────────────────────────────────────────

/** Half-open ISO range `[from, to)` plus the client UTC offset in minutes. */
export interface DateRange {
  from: string;
  to: string;
  /** Minutes east of UTC (Algeria = 60). Lets the server bucket by local day. */
  tz: number;
  preset: RangePreset;
}

export type RangePreset = "today" | "yesterday" | "7d" | "30d" | "90d" | "this_month" | "last_month" | "custom";

export const RANGE_PRESETS: RangePreset[] = ["today", "yesterday", "7d", "30d", "90d", "this_month", "last_month", "custom"];

/** Client offset in minutes east of UTC (JS returns the opposite sign). */
export function tzOffsetMinutes(now = new Date()): number {
  return -now.getTimezoneOffset();
}

/** Local midnight for the given local date, as a Date. */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function resolveRange(preset: RangePreset, now = new Date(), custom?: { from: string; to: string }): DateRange {
  const tz = tzOffsetMinutes(now);
  const today = startOfLocalDay(now);
  const tomorrow = addDays(today, 1);
  let from: Date;
  let to: Date;
  switch (preset) {
    case "today":
      from = today;
      to = tomorrow;
      break;
    case "yesterday":
      from = addDays(today, -1);
      to = today;
      break;
    case "7d":
      from = addDays(today, -6);
      to = tomorrow;
      break;
    case "90d":
      from = addDays(today, -89);
      to = tomorrow;
      break;
    case "this_month":
      from = new Date(today.getFullYear(), today.getMonth(), 1);
      to = tomorrow;
      break;
    case "last_month":
      from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      to = new Date(today.getFullYear(), today.getMonth(), 1);
      break;
    case "custom": {
      const customFrom = custom?.from ? new Date(`${custom.from}T00:00:00`) : addDays(today, -29);
      const customTo = custom?.to ? addDays(new Date(`${custom.to}T00:00:00`), 1) : tomorrow;
      from = Number.isNaN(customFrom.getTime()) ? addDays(today, -29) : customFrom;
      to = Number.isNaN(customTo.getTime()) || customTo <= from ? addDays(from, 1) : customTo;
      break;
    }
    case "30d":
    default:
      from = addDays(today, -29);
      to = tomorrow;
  }
  return { from: from.toISOString(), to: to.toISOString(), tz, preset };
}

/** Days covered by the range (rounded). */
export function rangeDays(range: Pick<DateRange, "from" | "to">): number {
  return Math.max(1, Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000));
}

/** Pick a sensible default bucket for the range length. */
export function defaultGranularity(range: Pick<DateRange, "from" | "to">): "day" | "week" | "month" {
  const days = rangeDays(range);
  if (days > 180) return "month";
  if (days > 60) return "week";
  return "day";
}

export function toLocalDateInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ─── Deltas & formatting ──────────────────────────────────────────────────────

export interface Delta {
  /** Percentage change vs previous, null when the previous value is 0/absent. */
  percent: number | null;
  direction: "up" | "down" | "flat";
}

export function deltaOf(current: number | null | undefined, previous: number | null | undefined): Delta {
  if (current == null || previous == null || previous === 0) {
    return { percent: null, direction: current && current > 0 ? "up" : "flat" };
  }
  const percent = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  return { percent, direction: percent > 0 ? "up" : percent < 0 ? "down" : "flat" };
}

/** Point change for rates already expressed in percent (e.g. 62.5 → 65.0 = +2.5 pts). */
export function pointsDelta(current: number | null, previous: number | null): Delta {
  if (current == null || previous == null) return { percent: null, direction: "flat" };
  const diff = Math.round((current - previous) * 10) / 10;
  return { percent: diff, direction: diff > 0 ? "up" : diff < 0 ? "down" : "flat" };
}

export function formatPercent(value: number | null | undefined, locale: string, digits = 1): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${new Intl.NumberFormat(locale === "ar" ? "ar-DZ" : `${locale}-DZ`, {
    maximumFractionDigits: digits,
  }).format(value)}%`;
}

export function formatCompactMoney(value: number, locale: string): string {
  const formatter = new Intl.NumberFormat(locale === "ar" ? "ar-DZ" : `${locale}-DZ`, {
    notation: Math.abs(value) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(value) >= 100_000 ? 1 : 0,
  });
  return `${formatter.format(value)} DA`;
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-DZ" : `${locale}-DZ`).format(value);
}

// ─── Widgets & layout ─────────────────────────────────────────────────────────

export type WidgetId =
  | "kpis"
  | "today"
  | "alerts"
  | "timeseries"
  | "wilayas"
  | "products"
  | "carriers"
  | "roas"
  | "pnl"
  | "status_breakdown"
  | "recent_orders";

export interface WidgetDefinition {
  id: WidgetId;
  /** Full-width rows vs half-width cards on large screens. */
  span: "full" | "half";
  /** Extra scope required beyond dashboard:view. */
  scope?: string;
}

export const LAYOUT_VERSION = 1;

export const WIDGETS: WidgetDefinition[] = [
  { id: "kpis", span: "full" },
  { id: "today", span: "half" },
  { id: "alerts", span: "half" },
  { id: "timeseries", span: "full" },
  { id: "wilayas", span: "full" },
  { id: "products", span: "half" },
  { id: "carriers", span: "half" },
  { id: "roas", span: "full", scope: "analytics:finance" },
  { id: "pnl", span: "full", scope: "analytics:finance" },
  { id: "status_breakdown", span: "half" },
  { id: "recent_orders", span: "half", scope: "orders:read" },
];

export type LayoutEntry = { id: WidgetId; hidden: boolean };

/** Merge a saved layout with the catalogue: unknown ids dropped, new ids appended. */
export function mergeLayout(saved: DashboardLayout | null | undefined): LayoutEntry[] {
  const known = new Set(WIDGETS.map((widget) => widget.id));
  const entries: LayoutEntry[] = [];
  const seen = new Set<string>();
  for (const entry of saved?.widgets ?? []) {
    if (!known.has(entry.id as WidgetId) || seen.has(entry.id)) continue;
    entries.push({ id: entry.id as WidgetId, hidden: Boolean(entry.hidden) });
    seen.add(entry.id);
  }
  for (const widget of WIDGETS) {
    if (!seen.has(widget.id)) entries.push({ id: widget.id, hidden: false });
  }
  return entries;
}

export function defaultLayout(): LayoutEntry[] {
  return WIDGETS.map((widget) => ({ id: widget.id, hidden: false }));
}

export function moveWidget(entries: LayoutEntry[], from: number, to: number): LayoutEntry[] {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return entries;
  const next = entries.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function toggleWidget(entries: LayoutEntry[], id: WidgetId): LayoutEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, hidden: !entry.hidden } : entry));
}

export function layoutsEqual(a: LayoutEntry[], b: LayoutEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.id === b[index].id && entry.hidden === b[index].hidden);
}

export type HeatMetric = "orders" | "deliveryRate" | "returnRate" | "revenueDelivered";

/** 0..1 intensity for a metric value against the observed max. */
export function heatIntensity(value: number | null, max: number): number {
  if (value == null || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}
