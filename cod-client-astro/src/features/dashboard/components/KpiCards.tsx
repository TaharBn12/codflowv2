import type { ReactNode } from "react";
import {
  BadgePercent,
  BarChart3,
  CheckCircle2,
  Coins,
  Hourglass,
  RotateCcw,
  ShoppingBag,
  Truck,
} from "lucide-react";
import { useLocale, useT } from "@/i18n/react";
import { useAsyncData } from "../hooks";
import { getOverview } from "../api";
import { deltaOf, formatCompactMoney, formatNumber, formatPercent, pointsDelta, type DateRange, type Delta } from "../model";
import { WidgetFrame, type WidgetChrome } from "./WidgetFrame";

const TONES = {
  neutral: "border-border/60 bg-muted/60 text-muted-foreground",
  brand: "border-brand/25 bg-brand/10 text-brand",
  success: "border-[var(--status-delivered-border)] bg-[var(--status-delivered-bg)] text-[var(--status-delivered-text)]",
  warning: "border-[var(--status-preparing-border)] bg-[var(--status-preparing-bg)] text-[var(--status-preparing-text)]",
  critical: "border-[var(--status-returned-border)] bg-[var(--status-returned-bg)] text-[var(--status-returned-text)]",
  info: "border-[var(--status-ready-border)] bg-[var(--status-ready-bg)] text-[var(--status-ready-text)]",
} as const;

export function DeltaBadge({
  delta,
  unit = "%",
  invert = false,
  label,
}: {
  delta: Delta;
  /** "%" for relative change, "pts" for percentage-point change. */
  unit?: "%" | "pts";
  /** When true an increase is bad (e.g. return rate). */
  invert?: boolean;
  label: string;
}) {
  const t = useT("dashboard");
  if (delta.percent == null) {
    return <span className="text-[11px] text-muted-foreground">{t("kpis.no_previous")}</span>;
  }
  const good = delta.direction === "flat" ? null : (delta.direction === "up") !== invert;
  const color =
    good == null ? "text-muted-foreground" : good ? "text-[var(--status-delivered-text)]" : "text-[var(--status-returned-text)]";
  const arrow = delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "•";
  const value = `${Math.abs(delta.percent)}${unit === "pts" ? ` ${t("kpis.pts")}` : "%"}`;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold tabular-nums ${color}`} title={label}>
      <span aria-hidden="true">{arrow}</span>
      {value}
      <span className="font-normal text-muted-foreground">{label}</span>
    </span>
  );
}

function KpiCard({
  label,
  value,
  icon,
  tone,
  delta,
  hint,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  tone: keyof typeof TONES;
  delta: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
      <span className={`grid size-10 shrink-0 place-items-center rounded-lg border shadow-2xs ${TONES[tone]}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" title={hint}>
          {label}
        </p>
        <p className="mt-1 text-2xl font-bold leading-none tabular-nums tracking-tight text-foreground">{value}</p>
        <div className="mt-1.5 truncate">{delta}</div>
      </div>
    </div>
  );
}

export function KpiCards({ range, chrome, refreshKey }: { range: DateRange; chrome: WidgetChrome; refreshKey: number }) {
  const t = useT("dashboard");
  const locale = useLocale();
  const state = useAsyncData(() => getOverview(range), [range.from, range.to, range.tz, refreshKey]);
  const data = state.data;
  const vs = t("kpis.vs_previous");

  return (
    <WidgetFrame
      id="kpis"
      title={t("kpis.title")}
      subtitle={t("kpis.subtitle")}
      chrome={chrome}
      loading={state.loading}
      skeleton={state.loading && !data}
      error={state.error}
      onRetry={state.reload}
    >
      {data && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label={t("kpis.total_orders")}
            value={formatNumber(data.current.totalOrders, locale)}
            icon={<ShoppingBag size={20} />}
            tone="brand"
            delta={<DeltaBadge delta={deltaOf(data.current.totalOrders, data.previous.totalOrders)} label={vs} />}
          />
          <KpiCard
            label={t("kpis.confirmation_rate")}
            value={formatPercent(data.current.confirmationRate, locale)}
            icon={<CheckCircle2 size={20} />}
            tone="info"
            hint={t("kpis.confirmation_rate_hint")}
            delta={
              <DeltaBadge delta={pointsDelta(data.current.confirmationRate, data.previous.confirmationRate)} unit="pts" label={vs} />
            }
          />
          <KpiCard
            label={t("kpis.delivery_rate")}
            value={formatPercent(data.current.deliveryRate, locale)}
            icon={<Truck size={20} />}
            tone="success"
            hint={t("kpis.delivery_rate_hint")}
            delta={<DeltaBadge delta={pointsDelta(data.current.deliveryRate, data.previous.deliveryRate)} unit="pts" label={vs} />}
          />
          <KpiCard
            label={t("kpis.return_rate")}
            value={formatPercent(data.current.returnRate, locale)}
            icon={<RotateCcw size={20} />}
            tone="critical"
            hint={t("kpis.return_rate_hint")}
            delta={<DeltaBadge delta={pointsDelta(data.current.returnRate, data.previous.returnRate)} unit="pts" invert label={vs} />}
          />
          <KpiCard
            label={t("kpis.revenue_delivered")}
            value={formatCompactMoney(data.current.revenueDelivered, locale)}
            icon={<Coins size={20} />}
            tone="success"
            hint={t("kpis.revenue_delivered_hint")}
            delta={<DeltaBadge delta={deltaOf(data.current.revenueDelivered, data.previous.revenueDelivered)} label={vs} />}
          />
          <KpiCard
            label={t("kpis.revenue_pending")}
            value={formatCompactMoney(data.current.revenuePending, locale)}
            icon={<Hourglass size={20} />}
            tone="warning"
            hint={t("kpis.revenue_pending_hint")}
            delta={<DeltaBadge delta={deltaOf(data.current.revenuePending, data.previous.revenuePending)} label={vs} />}
          />
          <KpiCard
            label={t("kpis.aov")}
            value={formatCompactMoney(data.current.avgOrderValue, locale)}
            icon={<BadgePercent size={20} />}
            tone="neutral"
            hint={t("kpis.aov_hint")}
            delta={<DeltaBadge delta={deltaOf(data.current.avgOrderValue, data.previous.avgOrderValue)} label={vs} />}
          />
          <KpiCard
            label={t("kpis.in_transit")}
            value={formatNumber(data.current.inTransit, locale)}
            icon={<BarChart3 size={20} />}
            tone="neutral"
            hint={t("kpis.in_transit_hint")}
            delta={
              <span className="text-[11px] text-muted-foreground">
                {t("kpis.pending_confirmation")}: <strong className="tabular-nums">{formatNumber(data.current.pendingConfirmation, locale)}</strong>
              </span>
            }
          />
        </div>
      )}
    </WidgetFrame>
  );
}
