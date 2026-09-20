import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Granularity } from "../../../../../cod-shared/queries/analytics";
import { useLocale, useT } from "@/i18n/react";
import { EmptyState } from "@/components/ui";
import { BarChart3 } from "lucide-react";
import { useAsyncData } from "../hooks";
import { getTimeseries } from "../api";
import { formatCompactMoney, formatNumber, type DateRange } from "../model";
import { WidgetFrame, type WidgetChrome } from "./WidgetFrame";

export const CHART_COLORS = {
  orders: "#8b5cf6",
  confirmed: "#2563eb",
  delivered: "#0d9488",
  returned: "#dc2626",
  cancelled: "#9ca3af",
  revenue: "#d97706",
  spend: "#dc2626",
  grid: "rgba(128,128,128,0.18)",
  axis: "#8a8f98",
};

type Mode = "orders" | "revenue";

const GRANULARITIES: Granularity[] = ["day", "week", "month"];

function formatPeriod(period: string, granularity: Granularity, locale: string): string {
  const intl = locale === "ar" ? "ar-DZ" : `${locale}-DZ`;
  if (granularity === "month") {
    const [year, month] = period.split("-").map(Number);
    return new Intl.DateTimeFormat(intl, { month: "short", year: "2-digit" }).format(new Date(year, month - 1, 1));
  }
  const [year, month, day] = period.split("-").map(Number);
  return new Intl.DateTimeFormat(intl, { day: "numeric", month: "short" }).format(new Date(year, month - 1, day));
}

export function TimeseriesChart({
  range,
  granularity,
  onGranularityChange,
  chrome,
  refreshKey,
}: {
  range: DateRange;
  granularity: Granularity;
  onGranularityChange: (value: Granularity) => void;
  chrome: WidgetChrome;
  refreshKey: number;
}) {
  const t = useT("dashboard");
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>("orders");
  const state = useAsyncData(
    () => getTimeseries(range, granularity),
    [range.from, range.to, range.tz, granularity, refreshKey],
  );
  const data = useMemo(
    () => (state.data ?? []).map((point) => ({ ...point, label: formatPeriod(point.period, granularity, locale) })),
    [state.data, granularity, locale],
  );
  const hasData = data.some((point) => point.orders > 0 || point.revenueDelivered > 0);

  const action = (
    <div className="flex items-center gap-1.5">
      <div role="tablist" aria-label={t("timeseries.mode")} className="flex rounded-lg border border-border/80 bg-muted/40 p-0.5">
        {(["orders", "revenue"] as Mode[]).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
              mode === value ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(`timeseries.mode_${value}`)}
          </button>
        ))}
      </div>
      <div role="tablist" aria-label={t("timeseries.granularity")} className="flex rounded-lg border border-border/80 bg-muted/40 p-0.5">
        {GRANULARITIES.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={granularity === value}
            onClick={() => onGranularityChange(value)}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
              granularity === value ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(`timeseries.${value}`)}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <WidgetFrame
      id="timeseries"
      title={t("timeseries.title")}
      subtitle={t("timeseries.subtitle")}
      action={action}
      chrome={chrome}
      loading={state.loading}
      skeleton={state.loading && !state.data}
      error={state.error}
      onRetry={state.reload}
    >
      {!hasData ? (
        <EmptyState compact icon={<BarChart3 size={20} />} title={t("empty.no_data")} />
      ) : (
        <div dir="ltr" className="h-[320px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: CHART_COLORS.axis }} tickLine={false} axisLine={false} minTickGap={16} />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 11, fill: CHART_COLORS.axis }}
                tickLine={false}
                axisLine={false}
                width={mode === "revenue" ? 64 : 36}
                tickFormatter={(value: number) =>
                  mode === "revenue" ? formatCompactMoney(value, locale).replace(" DA", "") : formatNumber(value, locale)
                }
              />
              <Tooltip
                cursor={{ fill: "rgba(128,128,128,0.08)" }}
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  fontSize: 12,
                  color: "var(--popover-foreground)",
                }}
                formatter={(value, name) => {
                  const numeric = typeof value === "number" ? value : Number(value ?? 0);
                  return [mode === "revenue" ? formatCompactMoney(numeric, locale) : formatNumber(numeric, locale), String(name)];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {mode === "orders" ? (
                <>
                  <Bar yAxisId="left" dataKey="orders" name={t("timeseries.orders")} fill={CHART_COLORS.orders} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Bar yAxisId="left" dataKey="delivered" name={t("timeseries.delivered")} fill={CHART_COLORS.delivered} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Bar yAxisId="left" dataKey="returned" name={t("timeseries.returned")} fill={CHART_COLORS.returned} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Line yAxisId="left" type="monotone" dataKey="confirmed" name={t("timeseries.confirmed")} stroke={CHART_COLORS.confirmed} strokeWidth={2} dot={false} />
                </>
              ) : (
                <>
                  <Bar yAxisId="left" dataKey="revenueDelivered" name={t("timeseries.revenue_delivered")} fill={CHART_COLORS.delivered} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Bar yAxisId="left" dataKey="revenuePending" name={t("timeseries.revenue_pending")} fill={CHART_COLORS.revenue} radius={[4, 4, 0, 0]} maxBarSize={28} />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </WidgetFrame>
  );
}
