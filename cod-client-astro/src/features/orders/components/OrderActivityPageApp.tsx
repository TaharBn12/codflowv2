import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  ArrowRightLeft,
  Bot,
  Building2,
  ClipboardList,
  History,
  MessageCircle,
  PackagePlus,
  Phone,
  RefreshCw,
  StickyNote,
  Truck,
  UserCog,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { DashboardChrome } from "@/components/layout/chrome";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Select,
  StatCard,
} from "@/components/ui";
import {
  RequireAuth,
  canScope,
  useIdentity,
} from "@/features/auth/components/RequireAuth";
import { useLocale, useT } from "@/i18n/react";
import { getOrderActivity } from "@/features/orders/api";
import { algeriaDayKey, groupByAlgeriaDay } from "@/features/orders/model";
import { OrderStatusBadge } from "@/features/orders/components/OrderStatusBadge";
import {
  ContactOutcomeBadge,
  formatContactTime,
} from "@/features/orders/components/OrderContactCard";
import type {
  OrderActivityData,
  OrderActivityEntry,
  OrderActivityKind,
} from "@/features/orders/types";

type Filter = "all" | Exclude<OrderActivityKind, "created">;
const FILTERS: Filter[] = ["all", "contact", "status", "note", "event"];

const ACTION_ICONS: Record<string, LucideIcon> = {
  "order.created": PackagePlus,
  "order.status_changed": ArrowRightLeft,
  "order.note_added": StickyNote,
  "order.driver_assigned": Truck,
  "order.dispatched": Building2,
  "order.shipment_validated": Building2,
  "order.update_shipment": Building2,
  "order.cancel_shipment": Building2,
  "order.ask_return": Building2,
  "order.confirm_return_reception": Building2,
  "order.carrier_remark": Building2,
  "order.carrier_synced": RefreshCw,
  "order.confirmer_assigned": UserCog,
};

const KIND_TONES: Record<OrderActivityKind, string> = {
  created: "border-brand/25 bg-brand/10 text-brand",
  status: "border-[var(--status-confirmed-border)] bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-text)]",
  contact: "border-[var(--status-preparing-border)] bg-[var(--status-preparing-bg)] text-[var(--status-preparing-text)]",
  note: "border-[var(--status-ready-border)] bg-[var(--status-ready-bg)] text-[var(--status-ready-text)]",
  event: "border-border/80 bg-muted/60 text-muted-foreground",
};

function entryIcon(entry: OrderActivityEntry): LucideIcon {
  if (entry.kind === "contact") return entry.channel === "call" ? Phone : MessageCircle;
  if (entry.source?.startsWith("webhook:")) return Zap;
  if (entry.source === "ai-agent") return Bot;
  if (entry.action === "order.driver_assigned" && entry.metadata?.driverId === null) return Truck;
  return ACTION_ICONS[entry.action] ?? History;
}

function entryActionKey(entry: OrderActivityEntry): string {
  const action =
    entry.action === "order.driver_assigned" && entry.metadata?.driverId === null
      ? "order.driver_unassigned"
      : entry.action;
  return action.replace(/\./g, "_");
}

function actionLabel(t: (key: string) => string, key: string): string {
  const label = t(`activity.actions.${key}`);
  return label.startsWith("activity.actions.") ? t("activity.actions.order_event") : label;
}

function sourceKey(source: string | null): string | null {
  if (!source) return null;
  if (source.startsWith("webhook:")) return "webhook";
  if (source.startsWith("carrier-sync:")) return "carrier_sync";
  if (source.startsWith("ecotrack-reconcile:")) return "reconcile";
  if (source === "ai-agent") return "ai_agent";
  return null;
}

function carrierName(source: string | null): string | null {
  if (!source) return null;
  const code = source.split(":")[1];
  if (!code) return null;
  return code
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function metaString(entry: OrderActivityEntry, key: string): string | null {
  const value = entry.metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

function metaNumber(entry: OrderActivityEntry, key: string): number | null {
  const value = entry.metadata?.[key];
  return typeof value === "number" ? value : null;
}

function ActivityRow({ entry }: { entry: OrderActivityEntry }) {
  const t = useT("orders");
  const locale = useLocale();
  const Icon = entryIcon(entry);
  const source = sourceKey(entry.source);
  const carrier = carrierName(entry.source);
  const actor = entry.actorName
    ? entry.actorName
    : source
      ? `${t(`activity.sources.${source}`)}${carrier && source !== "ai_agent" ? ` · ${carrier}` : ""}`
      : t("activity.system");
  const role = entry.actorRole ? t(`activity.roles.${entry.actorRole}`) : null;
  const attemptOfDay = metaNumber(entry, "attemptOfDay");
  const dailyLimit = metaNumber(entry, "dailyLimit");
  const assigneeName = metaString(entry, "assigneeName");
  const driverName = metaString(entry, "driverName") ?? metaString(entry, "previousDriverName");
  const tracking = metaString(entry, "trackingNumber");
  const companyName = metaString(entry, "companyName");

  return (
    <li className="relative flex gap-3 ps-1">
      <span
        className={`relative z-10 mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border shadow-2xs ${KIND_TONES[entry.kind]}`}
        aria-hidden="true"
      >
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1 pb-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-sm font-bold text-foreground">{actionLabel(t, entryActionKey(entry))}</p>
          {entry.kind === "contact" && entry.channel && entry.outcome && (
            <ContactOutcomeBadge channel={entry.channel} outcome={entry.outcome} />
          )}
          {entry.kind === "status" && entry.toStatus && (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {entry.fromStatus && <OrderStatusBadge status={entry.fromStatus} />}
              {entry.fromStatus && (
                <ArrowRight size={12} className="text-muted-foreground rtl:rotate-180" aria-hidden="true" />
              )}
              <OrderStatusBadge status={entry.toStatus} webhook={entry.source?.startsWith("webhook:")} />
            </span>
          )}
          {entry.kind === "created" && entry.toStatus && <OrderStatusBadge status={entry.toStatus} />}
        </div>

        <p className="mt-0.5 text-xs text-muted-foreground">
          <time dateTime={entry.createdAt}>{formatContactTime(entry.createdAt, locale)}</time>
          {" · "}
          <span className="font-semibold text-foreground/80">{actor}</span>
          {role && <span> · {role}</span>}
        </p>

        {attemptOfDay !== null && dailyLimit !== null && (
          <p className="mt-1.5 text-xs font-semibold text-[var(--status-preparing-text)]">
            {t("activity.attempt_of_day").replace("{n}", String(attemptOfDay)).replace("{limit}", String(dailyLimit))}
          </p>
        )}
        {entry.kind === "status" && entry.metadata?.reason === "contact_attempt" && (
          <p className="mt-1.5 text-xs text-muted-foreground">{t("activity.reason_contact")}</p>
        )}
        {entry.action === "order.confirmer_assigned" && assigneeName && (
          <p className="mt-1.5 text-xs text-foreground/80">
            {(entry.metadata?.mode === "auto" ? t("activity.assignment_auto") : t("activity.assignment_manual")).replace("{name}", assigneeName)}
          </p>
        )}
        {entry.action === "order.driver_assigned" && driverName && (
          <p className="mt-1.5 text-xs text-foreground/80">{t("activity.driver_named").replace("{name}", driverName)}</p>
        )}
        {(companyName || tracking) && entry.kind === "event" && (
          <p className="mt-1.5 text-xs text-foreground/80" dir="auto">
            {[companyName, tracking ? t("activity.tracking").replace("{tracking}", tracking) : null].filter(Boolean).join(" · ")}
          </p>
        )}
        {entry.callbackAt && (
          <p className="mt-1.5 text-xs font-semibold text-[var(--status-ready-text)]">
            {t("activity.callback_for").replace("{time}", formatContactTime(entry.callbackAt, locale))}
          </p>
        )}
        {entry.note && (
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-sm text-foreground" dir="auto">
            {entry.note}
          </p>
        )}
      </div>
    </li>
  );
}

function OrderActivity({ orderId }: { orderId: string }) {
  const t = useT("orders");
  const common = useT("common");
  const auth = useT("auth");
  const locale = useLocale();
  const identity = useIdentity();
  const [data, setData] = useState<OrderActivityData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setError(null);
    setRefreshing(true);
    try {
      setData(await getOrderActivity(orderId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, [orderId]);

  const visible = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.entries;
    return data.entries.filter((entry) => entry.kind === filter);
  }, [data, filter]);

  const groups = useMemo(() => groupByAlgeriaDay(visible), [visible]);
  const todayKey = algeriaDayKey(new Date().toISOString());
  const yesterdayKey = algeriaDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  function dayLabel(day: string) {
    if (day === todayKey) return t("activity.today");
    if (day === yesterdayKey) return t("activity.yesterday");
    const date = new Date(`${day}T12:00:00Z`);
    return new Intl.DateTimeFormat(locale === "ar" ? "ar-DZ" : `${locale}-DZ`, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(date);
  }

  if (!canScope(identity, "orders:read")) {
    return (
      <Alert role="alert" tone="critical">
        {auth("no_access")}
      </Alert>
    );
  }

  if (error && !data) {
    return (
      <Alert role="alert" tone="critical">
        <AlertCircle size={18} className="shrink-0" />
        <span className="flex-1">
          {t("activity.load_error")}
          {error ? ` — ${error}` : ""}
        </span>
        <Button type="button" variant="ghost" onClick={() => void load()}>
          {common("retry")}
        </Button>
      </Alert>
    );
  }

  if (!data) {
    return (
      <div role="status" aria-busy="true" className="space-y-3">
        <div className="h-20 animate-pulse rounded-xl bg-muted" />
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
        <div className="h-96 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  const { order, summary } = data;
  const orderHref = `/orders/${encodeURIComponent(order.id)}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${t("activity.title")} · ${order.orderNumber}`}
        subtitle={`${order.customerName} · ${order.phone}`}
        backHref={orderHref}
        backLabel={t("activity.back_to_order")}
        actions={
          <div className="flex items-center gap-2">
            <OrderStatusBadge status={order.status} />
            <Button type="button" variant="secondary" size="sm" onClick={() => void load()} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
              {t("activity.refresh")}
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t("activity.stats.calls")} value={summary.totalCalls} icon={<Phone size={18} />} tone="warning" />
        <StatCard label={t("activity.stats.messages")} value={summary.totalMessages} icon={<MessageCircle size={18} />} tone="brand" />
        <StatCard
          label={t("activity.stats.unanswered_today")}
          value={`${summary.unansweredToday}/${summary.dailyLimit}`}
          icon={<ClipboardList size={18} />}
          tone={summary.limitReached ? "critical" : "neutral"}
        />
        <StatCard
          label={t("activity.stats.confirmer")}
          value={<span className="text-base">{order.confirmationAssigneeName ?? t("activity.unassigned")}</span>}
          icon={<UserCog size={18} />}
          tone="success"
        />
      </div>

      <Card
        title={t("activity.title")}
        subtitle={t("activity.entries_count").replace("{count}", String(visible.length))}
        action={
          <Select
            aria-label={t("activity.filter_label")}
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value as Filter)}
            wrapperClassName="w-48"
          >
            {FILTERS.map((value) => (
              <option key={value} value={value}>
                {t(`activity.filters.${value}`)}
              </option>
            ))}
          </Select>
        }
      >
        {error && (
          <Alert role="alert" tone="critical" className="mb-4">
            <AlertCircle size={18} className="shrink-0" />
            <span>{error}</span>
          </Alert>
        )}
        {groups.length === 0 ? (
          <EmptyState icon={<History size={22} />} title={t("activity.empty")} compact />
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.day} aria-label={dayLabel(group.day)}>
                <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {dayLabel(group.day)}
                </h3>
                <ol className="relative before:absolute before:inset-y-2 before:start-[22px] before:w-px before:bg-border">
                  {group.items.map((entry) => (
                    <ActivityRow key={entry.id} entry={entry} />
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export default function OrderActivityPageApp({ orderId }: { orderId: string }) {
  return (
    <RequireAuth>
      <DashboardChrome currentPath={`/orders/${orderId}/activity`}>
        <OrderActivity orderId={orderId} />
      </DashboardChrome>
    </RequireAuth>
  );
}
