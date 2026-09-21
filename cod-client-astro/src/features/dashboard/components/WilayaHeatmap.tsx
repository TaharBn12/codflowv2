import { useMemo, useState } from "react";
import { Map as MapIcon } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { useLocale, useT } from "@/i18n/react";
import type { WilayaStat } from "../../../../../cod-shared/queries/analytics";
import { useAsyncData } from "../hooks";
import { getWilayaStats } from "../api";
import {
  formatCompactMoney,
  formatNumber,
  formatPercent,
  heatIntensity,
  WILAYA_GRID,
  WILAYA_TILES,
  type DateRange,
  type HeatMetric,
} from "../model";
import { WidgetFrame, type WidgetChrome } from "./WidgetFrame";

const METRICS: HeatMetric[] = ["orders", "deliveryRate", "returnRate", "revenueDelivered"];

/** Purple ramp for volume metrics, green for delivery rate, red for returns. */
function tileColor(metric: HeatMetric, intensity: number): string {
  if (intensity <= 0) return "rgba(128,128,128,0.10)";
  const alpha = 0.18 + intensity * 0.72;
  switch (metric) {
    case "deliveryRate":
      return `rgba(13,148,136,${alpha})`;
    case "returnRate":
      return `rgba(220,38,38,${alpha})`;
    default:
      return `rgba(109,40,217,${alpha})`;
  }
}

function metricValue(stat: WilayaStat | undefined, metric: HeatMetric): number | null {
  if (!stat) return null;
  return stat[metric];
}

export function WilayaHeatmap({ range, chrome, refreshKey }: { range: DateRange; chrome: WidgetChrome; refreshKey: number }) {
  const t = useT("dashboard");
  const locale = useLocale();
  const [metric, setMetric] = useState<HeatMetric>("orders");
  const [selected, setSelected] = useState<number | null>(null);
  const state = useAsyncData(() => getWilayaStats(range), [range.from, range.to, range.tz, refreshKey]);

  const byId = useMemo(() => new Map((state.data ?? []).filter((row) => row.wilayaId != null).map((row) => [row.wilayaId as number, row])), [state.data]);
  const max = useMemo(() => {
    let value = 0;
    for (const stat of byId.values()) value = Math.max(value, metricValue(stat, metric) ?? 0);
    return value;
  }, [byId, metric]);
  const total = useMemo(() => (state.data ?? []).reduce((sum, row) => sum + row.orders, 0), [state.data]);
  const ranked = useMemo(() => {
    const rows = [...byId.values()].filter((row) => row.orders > 0);
    rows.sort((a, b) => (metricValue(b, metric) ?? -1) - (metricValue(a, metric) ?? -1));
    return rows.slice(0, 8);
  }, [byId, metric]);
  const unknown = (state.data ?? []).find((row) => row.wilayaId == null);
  const selectedStat = selected != null ? byId.get(selected) : undefined;

  function format(value: number | null): string {
    if (value == null) return "—";
    if (metric === "revenueDelivered") return formatCompactMoney(value, locale);
    if (metric === "orders") return formatNumber(value, locale);
    return formatPercent(value, locale);
  }

  function nameOf(stat: WilayaStat | undefined, id: number) {
    return (locale === "ar" ? stat?.nameAr : stat?.name) ?? stat?.name ?? String(id);
  }

  const action = (
    <div role="tablist" aria-label={t("wilayas.metric")} className="flex flex-wrap rounded-lg border border-border/80 bg-muted/40 p-0.5">
      {METRICS.map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={metric === value}
          onClick={() => setMetric(value)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            metric === value ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t(`wilayas.metric_${value}`)}
        </button>
      ))}
    </div>
  );

  return (
    <WidgetFrame
      id="wilayas"
      title={t("wilayas.title")}
      subtitle={t("wilayas.subtitle")}
      action={action}
      chrome={chrome}
      loading={state.loading}
      skeleton={state.loading && !state.data}
      error={state.error}
      onRetry={state.reload}
    >
      {total === 0 ? (
        <EmptyState compact icon={<MapIcon size={20} />} title={t("empty.no_data")} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div>
            <div
              dir="ltr"
              role="img"
              aria-label={t("wilayas.map_label")}
              className="grid gap-1"
              style={{
                gridTemplateColumns: `repeat(${WILAYA_GRID.cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${WILAYA_GRID.rows}, minmax(0, 1fr))`,
              }}
            >
              {WILAYA_TILES.map((tile) => {
                const stat = byId.get(tile.id);
                const value = metricValue(stat, metric);
                const intensity = heatIntensity(value, max);
                const isSelected = selected === tile.id;
                return (
                  <button
                    key={tile.id}
                    type="button"
                    onClick={() => setSelected(isSelected ? null : tile.id)}
                    onMouseEnter={() => setSelected(tile.id)}
                    title={`${tile.id} ${nameOf(stat, tile.id)} — ${format(value)}`}
                    aria-label={`${nameOf(stat, tile.id)}: ${format(value)}`}
                    aria-pressed={isSelected}
                    className={`flex aspect-square min-w-0 items-center justify-center rounded-md text-[10px] font-bold tabular-nums transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isSelected ? "ring-2 ring-foreground/60" : ""
                    } ${intensity > 0.55 ? "text-white" : "text-foreground/80"}`}
                    style={{ gridColumn: tile.col + 1, gridRow: tile.row + 1, background: tileColor(metric, intensity) }}
                  >
                    {tile.id}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span>{t("wilayas.legend_low")}</span>
              <div className="flex h-2 flex-1 overflow-hidden rounded-full">
                {[0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1].map((step) => (
                  <span key={step} className="flex-1" style={{ background: tileColor(metric, step) }} />
                ))}
              </div>
              <span>{t("wilayas.legend_high")}: {format(max)}</span>
            </div>
            {selectedStat ? (
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-xs sm:grid-cols-4">
                <div className="col-span-2 sm:col-span-4">
                  <span className="font-bold text-foreground">{selectedStat.wilayaId} — {nameOf(selectedStat, selectedStat.wilayaId ?? 0)}</span>
                </div>
                <Stat label={t("wilayas.metric_orders")} value={formatNumber(selectedStat.orders, locale)} />
                <Stat label={t("wilayas.metric_deliveryRate")} value={formatPercent(selectedStat.deliveryRate, locale)} />
                <Stat label={t("wilayas.metric_returnRate")} value={formatPercent(selectedStat.returnRate, locale)} />
                <Stat label={t("wilayas.metric_revenueDelivered")} value={formatCompactMoney(selectedStat.revenueDelivered, locale)} />
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">{t("wilayas.hover_hint")}</p>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("wilayas.top_by")} {t(`wilayas.metric_${metric}`)}
            </h3>
            <ol className="divide-y divide-border/70">
              {ranked.map((row) => {
                const value = metricValue(row, metric);
                const width = Math.round(heatIntensity(value, max) * 100);
                return (
                  <li key={row.wilayaId} className="py-2">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <a href={`/orders?wilaya=${encodeURIComponent(row.name ?? "")}`} className="min-w-0 truncate font-medium text-foreground hover:text-link hover:underline">
                        <span className="me-1.5 text-xs tabular-nums text-muted-foreground">{row.wilayaId}</span>
                        {nameOf(row, row.wilayaId ?? 0)}
                      </a>
                      <span className="shrink-0 text-sm font-bold tabular-nums">{format(value)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full" style={{ width: `${width}%`, background: tileColor(metric, 1) }} />
                      </div>
                      <span className="tabular-nums">
                        {formatNumber(row.orders, locale)} · {formatPercent(row.deliveryRate, locale)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
            {unknown && unknown.orders > 0 && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                {t("wilayas.unknown").replace("{count}", formatNumber(unknown.orders, locale))}
              </p>
            )}
          </div>
        </div>
      )}
    </WidgetFrame>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-bold tabular-nums text-foreground">{value}</p>
    </div>
  );
}
