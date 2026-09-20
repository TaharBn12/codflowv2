import { useMemo, useState } from "react";
import { Package } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { useLocale, useT } from "@/i18n/react";
import type { ProductStat } from "../../../../../cod-shared/queries/analytics";
import { useAsyncData } from "../hooks";
import { getProductStats } from "../api";
import { formatCompactMoney, formatNumber, formatPercent, type DateRange } from "../model";
import { WidgetFrame, type WidgetChrome } from "./WidgetFrame";

type View = "best" | "worst" | "profit";

function rank(rows: ProductStat[], view: View): ProductStat[] {
  const list = rows.filter((row) => row.orders > 0);
  switch (view) {
    case "worst":
      // Worst = highest return rate among products with enough outcomes.
      return list
        .filter((row) => row.deliveredOrders + row.returnedOrders >= 3)
        .sort((a, b) => (b.returnRate ?? 0) - (a.returnRate ?? 0) || b.returnedOrders - a.returnedOrders)
        .slice(0, 8);
    case "profit":
      return list
        .filter((row) => row.hasCostPrice)
        .sort((a, b) => (b.grossProfit ?? 0) - (a.grossProfit ?? 0))
        .slice(0, 8);
    default:
      return list.sort((a, b) => b.revenueDelivered - a.revenueDelivered || b.orders - a.orders).slice(0, 8);
  }
}

export function ProductsWidget({ range, chrome, refreshKey }: { range: DateRange; chrome: WidgetChrome; refreshKey: number }) {
  const t = useT("dashboard");
  const locale = useLocale();
  const [view, setView] = useState<View>("best");
  const state = useAsyncData(() => getProductStats(range, 200), [range.from, range.to, range.tz, refreshKey]);
  const rows = useMemo(() => rank(state.data ?? [], view), [state.data, view]);
  const max = rows.reduce(
    (value, row) => Math.max(value, view === "worst" ? row.returnRate ?? 0 : view === "profit" ? row.grossProfit ?? 0 : row.revenueDelivered),
    0,
  );
  const withoutCost = (state.data ?? []).filter((row) => !row.hasCostPrice && row.orders > 0).length;

  const action = (
    <div role="tablist" aria-label={t("products.view")} className="flex rounded-lg border border-border/80 bg-muted/40 p-0.5">
      {(["best", "worst", "profit"] as View[]).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={view === value}
          onClick={() => setView(value)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            view === value ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t(`products.view_${value}`)}
        </button>
      ))}
    </div>
  );

  return (
    <WidgetFrame
      id="products"
      title={t("products.title")}
      subtitle={t("products.subtitle")}
      action={action}
      chrome={chrome}
      loading={state.loading}
      skeleton={state.loading && !state.data}
      error={state.error}
      onRetry={state.reload}
      flush
    >
      {rows.length === 0 ? (
        <EmptyState
          compact
          icon={<Package size={20} />}
          title={view === "profit" && withoutCost > 0 ? t("products.no_cost_price") : t("empty.no_data")}
        />
      ) : (
        <ul className="divide-y divide-border/70">
          {rows.map((row, index) => {
            const primary =
              view === "worst"
                ? formatPercent(row.returnRate, locale)
                : view === "profit"
                  ? formatCompactMoney(row.grossProfit ?? 0, locale)
                  : formatCompactMoney(row.revenueDelivered, locale);
            const width = Math.round(
              ((view === "worst" ? row.returnRate ?? 0 : view === "profit" ? row.grossProfit ?? 0 : row.revenueDelivered) / (max || 1)) * 100,
            );
            return (
              <li key={row.productId} className="px-4 py-2.5 sm:px-5">
                <a href={`/products/${row.productId}`} className="group flex items-center gap-3">
                  <span className="w-5 shrink-0 text-center text-xs font-bold tabular-nums text-muted-foreground">{index + 1}</span>
                  {row.image ? (
                    <img src={row.image} alt="" loading="lazy" className="size-9 shrink-0 rounded-md border border-border/70 object-cover" />
                  ) : (
                    <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border/70 bg-muted text-muted-foreground">
                      <Package size={15} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-semibold text-foreground group-hover:text-link">{row.name}</span>
                      <span
                        className={`shrink-0 text-sm font-bold tabular-nums ${
                          view === "worst" ? "text-[var(--status-returned-text)]" : "text-foreground"
                        }`}
                      >
                        {primary}
                      </span>
                    </span>
                    <span className="mt-1 flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className={`block h-full rounded-full ${view === "worst" ? "bg-[var(--status-returned-text)]" : "bg-brand"}`}
                          style={{ width: `${Math.max(4, width)}%` }}
                        />
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {formatNumber(row.orders, locale)} {t("products.orders")} · {formatNumber(row.deliveredOrders, locale)} {t("products.delivered")}
                        {view !== "worst" && ` · ${t("products.return_rate")} ${formatPercent(row.returnRate, locale)}`}
                        {view === "profit" && ` · ${t("products.cogs")} ${formatCompactMoney(row.cogs, locale)}`}
                      </span>
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
          {view === "profit" && withoutCost > 0 && (
            <li className="px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
              {t("products.missing_cost_price").replace("{count}", formatNumber(withoutCost, locale))}
            </li>
          )}
        </ul>
      )}
    </WidgetFrame>
  );
}
