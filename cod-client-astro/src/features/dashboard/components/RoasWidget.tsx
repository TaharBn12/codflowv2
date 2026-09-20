import { useEffect, useMemo, useState } from "react";
import { Megaphone, Plus } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button, EmptyState } from "@/components/ui";
import { useLocale, useT } from "@/i18n/react";
import { canScope, useIdentity } from "@/features/auth/components/RequireAuth";
import { listLandingPages } from "@/features/landing-pages/api";
import { useAsyncData } from "../hooks";
import { getRoas } from "../api";
import { formatCompactMoney, formatNumber, type DateRange } from "../model";
import { ExpenseDialog } from "./ExpenseDialog";
import { CHART_COLORS } from "./TimeseriesChart";
import { WidgetFrame, type WidgetChrome } from "./WidgetFrame";

function formatDay(date: string, locale: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-DZ" : `${locale}-DZ`, { day: "numeric", month: "short" }).format(
    new Date(year, month - 1, day),
  );
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "bad" }) {
  const color = tone === "good" ? "text-[var(--status-delivered-text)]" : tone === "bad" ? "text-[var(--status-returned-text)]" : "text-foreground";
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-bold leading-tight tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

export function RoasWidget({
  range,
  chrome,
  refreshKey,
  onExpensesChanged,
}: {
  range: DateRange;
  chrome: WidgetChrome;
  refreshKey: number;
  onExpensesChanged: () => void;
}) {
  const t = useT("dashboard");
  const locale = useLocale();
  const identity = useIdentity();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [landingPages, setLandingPages] = useState<Array<{ id: string; name: string }>>([]);
  const state = useAsyncData(() => getRoas(range), [range.from, range.to, range.tz, refreshKey]);
  const data = state.data;

  useEffect(() => {
    if (!canScope(identity, "landing_pages:read")) return;
    listLandingPages()
      .then((pages) => setLandingPages(pages.map((page) => ({ id: page.id, name: page.name }))))
      .catch(() => setLandingPages([]));
  }, [identity?.role]);

  const chart = useMemo(
    () => (data?.daily ?? []).map((row) => ({ ...row, label: formatDay(row.date, locale) })),
    [data, locale],
  );
  const hasSpend = (data?.spend ?? 0) > 0;
  const roasTone = data?.roas == null ? "neutral" : data.roas >= 3 ? "good" : data.roas < 1.5 ? "bad" : "neutral";

  return (
    <WidgetFrame
      id="roas"
      title={t("roas.title")}
      subtitle={t("roas.subtitle")}
      action={
        <Button type="button" size="sm" variant="secondary" onClick={() => setDialogOpen(true)}>
          <Plus size={14} />
          {t("roas.add_spend")}
        </Button>
      }
      chrome={chrome}
      loading={state.loading}
      skeleton={state.loading && !data}
      error={state.error}
      onRetry={state.reload}
    >
      {data && (
        <div className="space-y-4">
          {!hasSpend ? (
            <EmptyState
              compact
              icon={<Megaphone size={20} />}
              title={t("roas.empty_title")}
              description={t("roas.empty_description")}
              action={
                <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
                  <Plus size={14} />
                  {t("roas.add_spend")}
                </Button>
              }
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
                <Metric label={t("roas.spend")} value={formatCompactMoney(data.spend, locale)} />
                <Metric label={t("roas.revenue_delivered")} value={formatCompactMoney(data.revenueDelivered, locale)} tone="good" />
                <Metric label={t("roas.roas")} value={data.roas == null ? "—" : `${data.roas}×`} tone={roasTone} />
                <Metric label={t("roas.cost_per_order")} value={data.costPerOrder == null ? "—" : formatCompactMoney(data.costPerOrder, locale)} />
                <Metric label={t("roas.cost_per_confirmed")} value={data.costPerConfirmedOrder == null ? "—" : formatCompactMoney(data.costPerConfirmedOrder, locale)} />
                <Metric label={t("roas.cost_per_delivered")} value={data.costPerDeliveredOrder == null ? "—" : formatCompactMoney(data.costPerDeliveredOrder, locale)} />
              </div>
              <div dir="ltr" className="h-[240px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: CHART_COLORS.axis }} tickLine={false} axisLine={false} minTickGap={16} />
                    <YAxis
                      yAxisId="money"
                      tick={{ fontSize: 11, fill: CHART_COLORS.axis }}
                      tickLine={false}
                      axisLine={false}
                      width={64}
                      tickFormatter={(value: number) => formatCompactMoney(value, locale).replace(" DA", "")}
                    />
                    <YAxis yAxisId="count" orientation="right" tick={{ fontSize: 11, fill: CHART_COLORS.axis }} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
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
                        const isCount = name === t("roas.orders") || name === t("roas.delivered");
                        return [isCount ? formatNumber(numeric, locale) : formatCompactMoney(numeric, locale), String(name)];
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar yAxisId="money" dataKey="spend" name={t("roas.spend")} fill={CHART_COLORS.spend} radius={[4, 4, 0, 0]} maxBarSize={22} />
                    <Bar yAxisId="money" dataKey="revenueDelivered" name={t("roas.revenue_delivered")} fill={CHART_COLORS.delivered} radius={[4, 4, 0, 0]} maxBarSize={22} />
                    <Line yAxisId="count" type="monotone" dataKey="orders" name={t("roas.orders")} stroke={CHART_COLORS.orders} strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("roas.by_platform")}</h3>
                  <ul className="space-y-1.5 text-sm">
                    {data.spendByPlatform.map((row) => (
                      <li key={row.platform} className="flex items-center justify-between gap-3">
                        <span className="text-foreground">{t(`expenses.platforms.${row.platform}`)}</span>
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full bg-[var(--status-returned-text)]" style={{ width: `${Math.round((row.amount / (data.spend || 1)) * 100)}%` }} />
                          </span>
                          <span className="w-24 text-end font-semibold tabular-nums">{formatCompactMoney(row.amount, locale)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                {data.landingPages.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("roas.by_landing_page")}</h3>
                    <ul className="space-y-1.5 text-sm">
                      {data.landingPages.slice(0, 6).map((row) => (
                        <li key={row.landingPageId ?? "none"} className="flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate text-foreground">{row.name ?? t("roas.unattributed")}</span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {formatCompactMoney(row.spend, locale)} → {formatCompactMoney(row.revenueDelivered, locale)}
                            <strong className="ms-2 text-foreground">{row.roas == null ? "—" : `${row.roas}×`}</strong>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
      <ExpenseDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        defaultCategory="ads"
        landingPages={landingPages}
        onSaved={() => {
          state.reload();
          onExpensesChanged();
        }}
      />
    </WidgetFrame>
  );
}
