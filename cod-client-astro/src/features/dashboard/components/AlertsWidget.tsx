import { useState } from "react";
import { AlertTriangle, Bell, ChevronDown, ChevronUp, Info, ShieldAlert } from "lucide-react";
import { Badge, EmptyState } from "@/components/ui";
import { useLocale, useT } from "@/i18n/react";
import type { DashboardAlert } from "../../../../../cod-shared/queries/analytics";
import { useAsyncData } from "../hooks";
import { getAlerts } from "../api";
import { formatCompactMoney, formatNumber } from "../model";
import { WidgetFrame, type WidgetChrome } from "./WidgetFrame";

const SEVERITY_STYLE = {
  critical: {
    icon: ShieldAlert,
    ring: "border-[var(--status-returned-border)] bg-[var(--status-returned-bg)] text-[var(--status-returned-text)]",
    tone: "critical" as const,
  },
  warning: {
    icon: AlertTriangle,
    ring: "border-[var(--status-preparing-border)] bg-[var(--status-preparing-bg)] text-[var(--status-preparing-text)]",
    tone: "warning" as const,
  },
  info: {
    icon: Info,
    ring: "border-[var(--status-ready-border)] bg-[var(--status-ready-bg)] text-[var(--status-ready-text)]",
    tone: "info" as const,
  },
};

function AlertRow({ alert }: { alert: DashboardAlert }) {
  const t = useT("dashboard");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const style = SEVERITY_STYLE[alert.severity];
  const Icon = style.icon;
  const title = t(`alerts.items.${alert.id}.title`).replace("{count}", formatNumber(alert.count, locale));
  const hint = t(`alerts.items.${alert.id}.hint`);
  const hasItems = Boolean(alert.items?.length);

  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex items-start gap-3">
        <span className={`grid size-8 shrink-0 place-items-center rounded-lg border ${style.ring}`}>
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a href={alert.href} className="text-sm font-semibold text-foreground hover:text-link hover:underline">
              {title}
            </a>
            <Badge tone={style.tone} size="sm">
              {t(`alerts.severity.${alert.severity}`)}
            </Badge>
            {alert.amount != null && (
              <span className="text-xs font-semibold tabular-nums text-muted-foreground">{formatCompactMoney(alert.amount, locale)}</span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
          {hasItems && (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-link hover:underline"
            >
              {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {open ? t("alerts.hide_details") : t("alerts.show_details")}
            </button>
          )}
          {open && hasItems && (
            <ul className="mt-2 space-y-1 rounded-lg border border-border/70 bg-muted/30 p-2 text-xs">
              {alert.items!.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-foreground">{item.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {alert.id === "driver_cash" ? formatCompactMoney(item.value, locale) : formatNumber(item.value, locale)}
                    {item.extra ? ` · ${item.extra}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

export function AlertsWidget({ chrome, refreshKey }: { chrome: WidgetChrome; refreshKey: number }) {
  const t = useT("dashboard");
  const state = useAsyncData(() => getAlerts(), [refreshKey]);
  const alerts = state.data ?? [];
  const critical = alerts.filter((alert) => alert.severity === "critical").length;

  return (
    <WidgetFrame
      id="alerts"
      title={t("alerts.title")}
      subtitle={t("alerts.subtitle")}
      action={
        alerts.length > 0 ? (
          <Badge tone={critical > 0 ? "critical" : "warning"} dot>
            {alerts.length}
          </Badge>
        ) : undefined
      }
      chrome={chrome}
      loading={state.loading}
      skeleton={state.loading && !state.data}
      error={state.error}
      onRetry={state.reload}
      flush
    >
      {alerts.length === 0 ? (
        <EmptyState compact icon={<Bell size={20} />} title={t("alerts.empty_title")} description={t("alerts.empty_description")} />
      ) : (
        <ul className="max-h-[420px] divide-y divide-border/70 overflow-y-auto">
          {alerts.map((alert) => (
            <AlertRow key={alert.id} alert={alert} />
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}
