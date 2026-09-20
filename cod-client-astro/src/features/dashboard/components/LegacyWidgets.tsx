import { BarChart3 } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { OrderStatusBadge } from "@/features/orders/components/OrderStatusBadge";
import { listOrders } from "@/features/orders/api";
import { formatMoney, orderTotal } from "@/features/orders/model";
import type { OrderStatus } from "@/features/orders/types";
import { useLocale, useT } from "@/i18n/react";
import { useAsyncData } from "../hooks";
import { getDashboardStats } from "../api";
import { fillStatusStats } from "../model";
import { WidgetFrame, type WidgetChrome } from "./WidgetFrame";

const STATUS_TONE: Record<OrderStatus, string> = {
  new: "bg-[var(--status-new-text)]",
  confirmed: "bg-[var(--status-confirmed-text)]",
  unreachable: "bg-[var(--status-preparing-text)]",
  preparing: "bg-[var(--status-preparing-text)]",
  ready: "bg-[var(--status-ready-text)]",
  assigned: "bg-[var(--status-assigned-text)]",
  dispatched: "bg-[var(--status-dispatched-text)]",
  out_for_delivery: "bg-[var(--status-out-text)]",
  delivered: "bg-[var(--status-delivered-text)]",
  returned: "bg-[var(--status-returned-text)]",
  cancelled: "bg-[var(--status-cancelled-text)]",
};

function relativeTime(value: string, tCommon: (key: string) => string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return tCommon("time.moments_ago");
  if (minutes < 60) return tCommon("time.minutes_ago").replace("{count}", String(minutes));
  const hours = Math.round(minutes / 60);
  if (hours < 24) return tCommon("time.hours_ago").replace("{count}", String(hours));
  const days = Math.round(hours / 24);
  return tCommon("time.days_ago").replace("{count}", String(days));
}

/** All-time order counts per lifecycle status (the original dashboard card). */
export function StatusBreakdownWidget({ chrome, refreshKey }: { chrome: WidgetChrome; refreshKey: number }) {
  const t = useT("dashboard");
  const common = useT("common");
  const locale = useLocale();
  const state = useAsyncData(() => getDashboardStats(), [refreshKey]);
  const rows = fillStatusStats(state.data ?? []);
  const total = rows.reduce((sum, row) => sum + row.count, 0);

  return (
    <WidgetFrame
      id="status_breakdown"
      title={t("status_breakdown.title")}
      subtitle={t("status_breakdown.subtitle")}
      chrome={chrome}
      loading={state.loading}
      skeleton={state.loading && !state.data}
      error={state.error}
      onRetry={state.reload}
      flush
    >
      {total === 0 ? (
        <EmptyState compact icon={<BarChart3 size={20} />} title={t("recent_orders.empty")} />
      ) : (
        <div className="divide-y divide-border">
          {rows.map(({ status, count }) => {
            const percentage = Math.round((count / total) * 100);
            return (
              <a
                key={status}
                href={`/orders?status=${status}`}
                className="grid gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50 sm:grid-cols-[160px_minmax(0,1fr)_64px] sm:items-center sm:px-5"
              >
                <div className="flex items-center justify-between gap-3 sm:justify-start">
                  <OrderStatusBadge status={status} />
                  <span className="text-sm font-bold tabular-nums text-foreground sm:hidden">{count.toLocaleString(locale)}</span>
                </div>
                <div className="flex items-center gap-3">
                  <div
                    className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={common(`statuses.${status}`)}
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={count}
                  >
                    <div className={`h-full rounded-full ${STATUS_TONE[status]}`} style={{ width: `${percentage}%` }} />
                  </div>
                  <span className="w-10 text-end text-xs font-semibold tabular-nums text-muted-foreground">{percentage}%</span>
                </div>
                <span className="hidden text-end text-sm font-bold tabular-nums text-foreground sm:block">{count.toLocaleString(locale)}</span>
              </a>
            );
          })}
        </div>
      )}
    </WidgetFrame>
  );
}

export function RecentOrdersWidget({ chrome, refreshKey }: { chrome: WidgetChrome; refreshKey: number }) {
  const t = useT("dashboard");
  const common = useT("common");
  const locale = useLocale();
  const state = useAsyncData(() => listOrders({ limit: 6 }).then((response) => response.data), [refreshKey]);
  const recent = state.data ?? [];

  return (
    <WidgetFrame
      id="recent_orders"
      title={t("recent_orders.title")}
      subtitle={t("recent_orders.subtitle")}
      action={
        <a href="/orders" className="text-xs font-semibold text-link hover:underline">
          {t("recent_orders.view_all")}
        </a>
      }
      chrome={chrome}
      loading={state.loading}
      skeleton={state.loading && !state.data}
      error={state.error}
      onRetry={state.reload}
      flush
    >
      {recent.length === 0 ? (
        <EmptyState compact icon={<BarChart3 size={20} />} title={t("recent_orders.empty")} />
      ) : (
        <ul className="divide-y divide-border">
          {recent.map((order) => (
            <li key={order.id}>
              <a href={`/orders/${order.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50 sm:px-5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-link">{order.orderNumber}</span>
                  <span className="block truncate text-xs text-muted-foreground">{order.customerName}</span>
                </span>
                <OrderStatusBadge status={order.status} />
                <span className="w-24 shrink-0 text-end text-sm font-bold tabular-nums text-foreground">{formatMoney(orderTotal(order), locale)}</span>
                <span className="hidden w-24 shrink-0 text-end text-xs text-muted-foreground sm:block">{relativeTime(order.createdAt, common)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}
