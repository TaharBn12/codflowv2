import type { ReactNode } from "react";
import {
  AlarmClock,
  CheckSquare,
  ClipboardList,
  Coins,
  MessageSquare,
  PackageCheck,
  PhoneCall,
  PhoneMissed,
  RotateCcw,
  ShieldCheck,
  Truck,
  Wallet,
} from "lucide-react";
import { useLocale, useT } from "@/i18n/react";
import { useIdentity } from "@/features/auth/components/RequireAuth";
import { useAsyncData } from "../hooks";
import { getTodayBoard } from "../api";
import { formatCompactMoney, formatNumber, startOfLocalDay } from "../model";
import { WidgetFrame, type WidgetChrome } from "./WidgetFrame";

function Tile({
  href,
  icon,
  label,
  value,
  tone = "neutral",
  urgent = false,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  value: string;
  tone?: "neutral" | "critical" | "warning" | "success" | "info";
  urgent?: boolean;
}) {
  const tones = {
    neutral: "border-border/70 bg-muted/40 text-muted-foreground",
    critical: "border-[var(--status-returned-border)] bg-[var(--status-returned-bg)] text-[var(--status-returned-text)]",
    warning: "border-[var(--status-preparing-border)] bg-[var(--status-preparing-bg)] text-[var(--status-preparing-text)]",
    success: "border-[var(--status-delivered-border)] bg-[var(--status-delivered-bg)] text-[var(--status-delivered-text)]",
    info: "border-[var(--status-ready-border)] bg-[var(--status-ready-bg)] text-[var(--status-ready-text)]",
  };
  return (
    <a
      href={href}
      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/60 ${
        urgent ? "border-[var(--status-returned-border)]" : "border-border/70"
      }`}
    >
      <span className={`grid size-9 shrink-0 place-items-center rounded-lg border ${tones[tone]}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="block text-xl font-bold leading-tight tabular-nums text-foreground">{value}</span>
      </span>
    </a>
  );
}

export function TodayBoardWidget({ chrome, refreshKey }: { chrome: WidgetChrome; refreshKey: number }) {
  const t = useT("dashboard");
  const locale = useLocale();
  const identity = useIdentity();
  const startOfDay = startOfLocalDay(new Date()).toISOString();
  const state = useAsyncData(() => getTodayBoard(startOfDay), [startOfDay, refreshKey]);
  const data = state.data;
  const isAdmin = identity?.role === "admin";
  const n = (value: number) => formatNumber(value, locale);

  return (
    <WidgetFrame
      id="today"
      title={t("today.title")}
      subtitle={t("today.subtitle")}
      chrome={chrome}
      loading={state.loading}
      skeleton={state.loading && !data}
      error={state.error}
      onRetry={state.reload}
    >
      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Tile href="/orders?status=new" icon={<PhoneCall size={16} />} label={t("today.to_confirm")} value={n(data.toConfirm)} tone={data.toConfirm > 0 ? "warning" : "neutral"} />
            <Tile href="/orders?status=unreachable" icon={<PhoneMissed size={16} />} label={t("today.to_retry")} value={n(data.toRetry)} tone={data.toRetry > 0 ? "warning" : "neutral"} />
            <Tile href="/orders?status=confirmed" icon={<ClipboardList size={16} />} label={t("today.to_prepare")} value={n(data.toPrepare)} tone="info" />
            <Tile href="/orders?status=ready" icon={<PackageCheck size={16} />} label={t("today.to_ship")} value={n(data.toShip)} tone="info" />
            <Tile href="/orders?status=out_for_delivery" icon={<Truck size={16} />} label={t("today.in_transit")} value={n(data.inTransit)} />
            <Tile
              href="/orders?status=out_for_delivery"
              icon={<AlarmClock size={16} />}
              label={t("today.late_shipments")}
              value={n(data.lateShipments)}
              tone={data.lateShipments > 0 ? "critical" : "neutral"}
              urgent={data.lateShipments > 0}
            />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Mini label={t("today.orders_today")} value={n(data.ordersToday)} />
            <Mini label={t("today.delivered_today")} value={n(data.deliveredToday)} icon={<PackageCheck size={12} />} />
            <Mini label={t("today.returned_today")} value={n(data.returnedToday)} icon={<RotateCcw size={12} />} />
            <Mini label={t("today.revenue_today")} value={formatCompactMoney(data.revenueDeliveredToday, locale)} icon={<Coins size={12} />} />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile href="/operations" icon={<CheckSquare size={16} />} label={t("today.my_open_tasks")} value={n(data.myOpenTasks)} tone={data.myOverdueTasks > 0 ? "critical" : "neutral"} urgent={data.myOverdueTasks > 0} />
            <Tile href="/operations" icon={<AlarmClock size={16} />} label={t("today.overdue_tasks")} value={n(data.myOverdueTasks)} tone={data.myOverdueTasks > 0 ? "critical" : "neutral"} />
            {isAdmin && (
              <Tile href="/settings" icon={<ShieldCheck size={16} />} label={t("today.pending_approvals")} value={n(data.pendingApprovals)} tone={data.pendingApprovals > 0 ? "warning" : "neutral"} />
            )}
            {isAdmin ? (
              <Tile href="/delivery" icon={<Wallet size={16} />} label={t("today.drivers_cash")} value={n(data.driversPendingCash)} tone={data.driversPendingCash > 0 ? "warning" : "neutral"} />
            ) : (
              <Tile href="/support" icon={<MessageSquare size={16} />} label={t("today.open_conversations")} value={n(data.openConversations)} />
            )}
          </div>
        </div>
      )}
    </WidgetFrame>
  );
}

function Mini({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="text-base font-bold tabular-nums text-foreground">{value}</p>
    </div>
  );
}
