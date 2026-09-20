import { useState } from "react";
import { Pencil, Plus, Receipt, Trash2 } from "lucide-react";
import { Button, useConfirmDialog } from "@/components/ui";
import { useLocale, useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import type { ExpenseRecord } from "../../../../../cod-shared/queries/analytics";
import { EXPENSE_CATEGORIES } from "../../../../../cod-shared/db/schema";
import { useAsyncData } from "../hooks";
import { deleteExpense, getPnl, listExpenses } from "../api";
import { formatCompactMoney, formatNumber, formatPercent, type DateRange } from "../model";
import { ExpenseDialog } from "./ExpenseDialog";
import { WidgetFrame, type WidgetChrome } from "./WidgetFrame";

function Line({
  label,
  value,
  locale,
  kind = "cost",
  strong = false,
  hint,
}: {
  label: string;
  value: number;
  locale: string;
  kind?: "revenue" | "cost" | "total";
  strong?: boolean;
  hint?: string;
}) {
  const color =
    kind === "revenue"
      ? "text-[var(--status-delivered-text)]"
      : kind === "total"
        ? value >= 0
          ? "text-[var(--status-delivered-text)]"
          : "text-[var(--status-returned-text)]"
        : "text-foreground";
  return (
    <li className={`flex items-center justify-between gap-3 py-1.5 ${strong ? "border-t border-border/70 pt-2 font-bold" : ""}`}>
      <span className="min-w-0">
        <span className={`block truncate text-sm ${strong ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
        {hint && <span className="block text-[11px] text-muted-foreground/80">{hint}</span>}
      </span>
      <span className={`shrink-0 text-sm tabular-nums ${color} ${strong ? "text-base" : ""}`}>
        {kind === "cost" && value > 0 ? "− " : ""}
        {formatCompactMoney(Math.abs(value) * (kind === "total" ? Math.sign(value) || 1 : 1), locale)}
      </span>
    </li>
  );
}

export function PnlWidget({
  range,
  chrome,
  refreshKey,
  expensesVersion,
  onExpensesChanged,
}: {
  range: DateRange;
  chrome: WidgetChrome;
  refreshKey: number;
  expensesVersion: number;
  onExpensesChanged: () => void;
}) {
  const t = useT("dashboard");
  const common = useT("common");
  const locale = useLocale();
  const confirm = useConfirmDialog();
  const [editing, setEditing] = useState<ExpenseRecord | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showExpenses, setShowExpenses] = useState(false);
  const pnl = useAsyncData(() => getPnl(range), [range.from, range.to, range.tz, refreshKey, expensesVersion]);
  const expenses = useAsyncData(() => listExpenses(range), [range.from, range.to, range.tz, refreshKey, expensesVersion], showExpenses);
  const data = pnl.data;

  async function remove(record: ExpenseRecord) {
    const ok = await confirm({
      title: common("confirm_delete_title").replace("{name}", `${t(`expenses.categories.${record.category}`)} · ${record.date}`),
      description: common("delete_description"),
      confirmLabel: common("delete"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteExpense(record.id);
      notify.success(t("expenses.deleted"));
      onExpensesChanged();
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : common("error_occurred"));
    }
  }

  return (
    <WidgetFrame
      id="pnl"
      title={t("pnl.title")}
      subtitle={t("pnl.subtitle")}
      action={
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowExpenses((value) => !value)} aria-pressed={showExpenses}>
            <Receipt size={14} />
            {t("expenses.title")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus size={14} />
            {t("expenses.add")}
          </Button>
        </div>
      }
      chrome={chrome}
      loading={pnl.loading}
      skeleton={pnl.loading && !data}
      error={pnl.error}
      onRetry={pnl.reload}
    >
      {data && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <ul>
              <Line label={t("pnl.revenue_delivered")} value={data.revenueDelivered} locale={locale} kind="revenue" hint={`${formatNumber(data.deliveredOrders, locale)} ${t("pnl.delivered_orders")}`} />
              <Line label={t("pnl.delivery_fees")} value={data.deliveryFeesCollected} locale={locale} kind="revenue" />
              <Line
                label={t("pnl.cogs")}
                value={data.cogs}
                locale={locale}
                hint={data.unitsWithoutCostPrice > 0 ? t("pnl.missing_cost").replace("{count}", formatNumber(data.productsWithoutCostPrice, locale)) : undefined}
              />
              <Line label={t("pnl.driver_fees")} value={data.driverFees} locale={locale} />
              <Line label={t("pnl.gross_profit")} value={data.grossProfit} locale={locale} kind="total" strong />
              <Line label={t("pnl.commissions")} value={data.commissions} locale={locale} />
              {EXPENSE_CATEGORIES.map((category) =>
                data.expenses[category] > 0 ? (
                  <Line key={category} label={t(`expenses.categories.${category}`)} value={data.expenses[category]} locale={locale} />
                ) : null,
              )}
              <Line label={t("pnl.net_profit")} value={data.netProfit} locale={locale} kind="total" strong hint={`${t("pnl.net_margin")}: ${formatPercent(data.netMargin, locale)}`} />
            </ul>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-muted/40 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("pnl.profit_per_order")}</p>
                <p className="text-base font-bold tabular-nums">{data.profitPerDeliveredOrder == null ? "—" : formatCompactMoney(data.profitPerDeliveredOrder, locale)}</p>
              </div>
              <div className="rounded-lg bg-muted/40 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("pnl.revenue_lost_returns")}</p>
                <p className="text-base font-bold tabular-nums text-[var(--status-returned-text)]">
                  {formatCompactMoney(data.revenueLostReturns, locale)}
                  <span className="ms-1 text-[11px] font-normal text-muted-foreground">({formatNumber(data.returnedOrders, locale)})</span>
                </p>
              </div>
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("pnl.cost_breakdown")}</h3>
            <CostBars data={data} locale={locale} t={t} />
            {showExpenses && (
              <div className="mt-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("expenses.title")}</h3>
                {expenses.error ? (
                  <p className="text-xs text-destructive">{expenses.error.message}</p>
                ) : !expenses.data ? (
                  <p className="text-xs text-muted-foreground">{t("expenses.loading")}</p>
                ) : expenses.data.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("expenses.empty")}</p>
                ) : (
                  <ul className="max-h-64 divide-y divide-border/70 overflow-y-auto rounded-lg border border-border/70">
                    {expenses.data.map((record) => (
                      <li key={record.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="w-20 shrink-0 text-xs tabular-nums text-muted-foreground" dir="ltr">
                          {record.date}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {t(`expenses.categories.${record.category}`)}
                          {record.platform ? ` · ${t(`expenses.platforms.${record.platform}`)}` : ""}
                          {record.landingPageName ? ` · ${record.landingPageName}` : ""}
                          {record.note ? <span className="text-muted-foreground"> — {record.note}</span> : null}
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums">{formatCompactMoney(record.amount, locale)}</span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={t("expenses.edit")}
                          onClick={() => {
                            setEditing(record);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" aria-label={common("delete")} onClick={() => void remove(record)}>
                          <Trash2 size={14} className="text-destructive" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <ExpenseDialog
        open={dialogOpen}
        expense={editing}
        defaultCategory="other"
        onClose={() => setDialogOpen(false)}
        onSaved={() => onExpensesChanged()}
      />
    </WidgetFrame>
  );
}

function CostBars({
  data,
  locale,
  t,
}: {
  data: NonNullable<ReturnType<typeof useAsyncData<Awaited<ReturnType<typeof getPnl>>>>["data"]>;
  locale: string;
  t: (key: string) => string;
}) {
  const rows = [
    { key: "cogs", label: t("pnl.cogs"), value: data.cogs, color: "#8b5cf6" },
    { key: "driver_fees", label: t("pnl.driver_fees"), value: data.driverFees, color: "#0d9488" },
    { key: "commissions", label: t("pnl.commissions"), value: data.commissions, color: "#2563eb" },
    ...EXPENSE_CATEGORIES.map((category, index) => ({
      key: category,
      label: t(`expenses.categories.${category}`),
      value: data.expenses[category],
      color: ["#dc2626", "#d97706", "#f59e0b", "#6b7280", "#a855f7", "#9ca3af"][index % 6],
    })),
  ].filter((row) => row.value > 0);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total === 0) return <p className="text-xs text-muted-foreground">{t("pnl.no_costs")}</p>;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {rows.map((row) => (
          <span key={row.key} title={`${row.label}: ${formatCompactMoney(row.value, locale)}`} style={{ width: `${(row.value / total) * 100}%`, background: row.color }} />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span className="size-2 shrink-0 rounded-full" style={{ background: row.color }} />
              <span className="truncate">{row.label}</span>
            </span>
            <span className="shrink-0 tabular-nums text-foreground">
              {formatPercent((row.value / total) * 100, locale, 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
