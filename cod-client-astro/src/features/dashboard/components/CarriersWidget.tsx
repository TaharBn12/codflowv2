import { Truck, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState } from "@/components/ui";
import { useLocale, useT } from "@/i18n/react";
import { useAsyncData } from "../hooks";
import { getCarrierStats } from "../api";
import { formatCompactMoney, formatNumber, formatPercent, type DateRange } from "../model";
import { CHART_COLORS } from "./TimeseriesChart";
import { WidgetFrame, type WidgetChrome } from "./WidgetFrame";

export function CarriersWidget({ range, chrome, refreshKey }: { range: DateRange; chrome: WidgetChrome; refreshKey: number }) {
  const t = useT("dashboard");
  const locale = useLocale();
  const state = useAsyncData(() => getCarrierStats(range), [range.from, range.to, range.tz, refreshKey]);
  const rows = (state.data ?? []).filter((row) => row.orders > 0);
  const chart = rows.slice(0, 8).map((row) => ({
    name: row.kind === "drivers" ? t("carriers.in_house") : (locale === "ar" ? row.nameAr ?? row.name : row.name),
    deliveryRate: row.deliveryRate ?? 0,
    returnRate: row.returnRate ?? 0,
  }));

  return (
    <WidgetFrame
      id="carriers"
      title={t("carriers.title")}
      subtitle={t("carriers.subtitle")}
      chrome={chrome}
      loading={state.loading}
      skeleton={state.loading && !state.data}
      error={state.error}
      onRetry={state.reload}
      flush
    >
      {rows.length === 0 ? (
        <EmptyState compact icon={<Truck size={20} />} title={t("empty.no_data")} />
      ) : (
        <div>
          <div dir="ltr" className="h-[200px] w-full px-2 pt-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: -12 }} barGap={2}>
                <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: CHART_COLORS.axis }} tickLine={false} axisLine={false} interval={0} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: CHART_COLORS.axis }} tickLine={false} axisLine={false} unit="%" />
                <Tooltip
                  cursor={{ fill: "rgba(128,128,128,0.08)" }}
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    fontSize: 12,
                    color: "var(--popover-foreground)",
                  }}
                  formatter={(value, name) => [formatPercent(typeof value === "number" ? value : Number(value ?? 0), locale), String(name)]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="deliveryRate" name={t("carriers.delivery_rate")} fill={CHART_COLORS.delivered} radius={[4, 4, 0, 0]} maxBarSize={26} />
                <Bar dataKey="returnRate" name={t("carriers.return_rate")} fill={CHART_COLORS.returned} radius={[4, 4, 0, 0]} maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-border/70 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2 text-start font-semibold sm:px-5">{t("carriers.carrier")}</th>
                  <th className="px-2 py-2 text-end font-semibold">{t("carriers.orders")}</th>
                  <th className="px-2 py-2 text-end font-semibold">{t("carriers.delivery_rate")}</th>
                  <th className="px-2 py-2 text-end font-semibold">{t("carriers.return_rate")}</th>
                  <th className="px-2 py-2 text-end font-semibold">{t("carriers.avg_days")}</th>
                  <th className="px-4 py-2 text-end font-semibold sm:px-5">{t("carriers.revenue")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className="px-4 py-2 sm:px-5">
                      <span className="flex items-center gap-2">
                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                          {row.kind === "drivers" ? <Users size={14} /> : <Truck size={14} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-foreground">
                            {row.kind === "drivers" ? t("carriers.in_house") : (locale === "ar" ? row.nameAr ?? row.name : row.name)}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {formatNumber(row.inTransit, locale)} {t("carriers.in_transit")}
                            {row.avgAttempts != null && ` · ${t("carriers.attempts")} ${row.avgAttempts}`}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums">{formatNumber(row.orders, locale)}</td>
                    <td className="px-2 py-2 text-end font-semibold tabular-nums text-[var(--status-delivered-text)]">
                      {formatPercent(row.deliveryRate, locale)}
                    </td>
                    <td className="px-2 py-2 text-end font-semibold tabular-nums text-[var(--status-returned-text)]">
                      {formatPercent(row.returnRate, locale)}
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums">{row.avgDeliveryDays == null ? "—" : row.avgDeliveryDays}</td>
                    <td className="px-4 py-2 text-end tabular-nums sm:px-5">{formatCompactMoney(row.revenueDelivered, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </WidgetFrame>
  );
}
