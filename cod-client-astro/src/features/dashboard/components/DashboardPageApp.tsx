import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, LayoutGrid, Plus, RefreshCw, RotateCcw, X } from "lucide-react";
import { canScope, RequireAuth, useIdentity } from "@/features/auth/components/RequireAuth";
import { DashboardChrome } from "@/components/layout/chrome";
import { Alert, Button, DropdownItem, DropdownMenu, LinkButton, PageHeader } from "@/components/ui";
import { useLocale, useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import type { Granularity } from "../../../../../cod-shared/queries/analytics";
import { downloadReport, getLayout, saveLayout, type ExportReport } from "../api";
import {
  defaultGranularity,
  defaultLayout,
  layoutsEqual,
  LAYOUT_VERSION,
  mergeLayout,
  moveWidget,
  rangeDays,
  resolveRange,
  toggleWidget,
  WIDGETS,
  type DateRange,
  type LayoutEntry,
  type WidgetId,
} from "../model";
import { AlertsWidget } from "./AlertsWidget";
import { CarriersWidget } from "./CarriersWidget";
import { KpiCards } from "./KpiCards";
import { RecentOrdersWidget, StatusBreakdownWidget } from "./LegacyWidgets";
import { PnlWidget } from "./PnlWidget";
import { ProductsWidget } from "./ProductsWidget";
import { RangePicker } from "./RangePicker";
import { RoasWidget } from "./RoasWidget";
import { TimeseriesChart } from "./TimeseriesChart";
import { TodayBoardWidget } from "./TodayBoard";
import { WilayaHeatmap } from "./WilayaHeatmap";
import type { WidgetChrome } from "./WidgetFrame";

const STORAGE_KEY = "codflow:dashboard:range";

function initialRange(): DateRange {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { preset?: DateRange["preset"]; from?: string; to?: string };
        if (parsed.preset && parsed.preset !== "custom") return resolveRange(parsed.preset);
        if (parsed.preset === "custom" && parsed.from && parsed.to) {
          return resolveRange("custom", new Date(), { from: parsed.from, to: parsed.to });
        }
      }
    } catch {}
  }
  return resolveRange("30d");
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DashboardOverview() {
  const identity = useIdentity();
  const t = useT("dashboard");
  const auth = useT("auth");
  const locale = useLocale();
  const [range, setRange] = useState<DateRange>(initialRange);
  const [granularity, setGranularity] = useState<Granularity>(() => defaultGranularity(range));
  const [refreshKey, setRefreshKey] = useState(0);
  const [expensesVersion, setExpensesVersion] = useState(0);
  const [layout, setLayout] = useState<LayoutEntry[]>(defaultLayout);
  const [savedLayout, setSavedLayout] = useState<LayoutEntry[]>(defaultLayout);
  const [customizing, setCustomizing] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [exporting, setExporting] = useState(false);
  const granularityTouched = useRef(false);

  const mayView = canScope(identity, "dashboard:view");
  const mayFinance = canScope(identity, "analytics:finance");

  // Persist the range choice per browser so the merchant lands on the same view.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ preset: range.preset, from: range.from.slice(0, 10), to: new Date(new Date(range.to).getTime() - 1).toISOString().slice(0, 10) }),
      );
    } catch {}
  }, [range]);

  // Follow the range with a sensible bucket until the user picks one explicitly.
  useEffect(() => {
    if (!granularityTouched.current) setGranularity(defaultGranularity(range));
  }, [range.from, range.to]);

  useEffect(() => {
    if (!mayView) return;
    getLayout()
      .then((saved) => {
        const merged = mergeLayout(saved);
        setLayout(merged);
        setSavedLayout(merged);
      })
      .catch(() => {
        /* fall back to the default layout silently */
      });
  }, [mayView]);

  const visibleWidgets = useMemo(
    () =>
      layout.filter((entry) => {
        const definition = WIDGETS.find((widget) => widget.id === entry.id);
        if (!definition) return false;
        if (definition.scope && !canScope(identity, definition.scope)) return false;
        return customizing || !entry.hidden;
      }),
    [layout, identity?.role, identity?.scopes.join(","), customizing],
  );

  const handleMove = useCallback((from: number, to: number) => {
    setLayout((current) => {
      const visible = current.filter((entry) => {
        const definition = WIDGETS.find((widget) => widget.id === entry.id);
        return definition && (!definition.scope || canScope(identity, definition.scope));
      });
      const fromId = visible[from]?.id;
      const toId = visible[to]?.id;
      if (!fromId || !toId) return current;
      const fromIndex = current.findIndex((entry) => entry.id === fromId);
      const toIndex = current.findIndex((entry) => entry.id === toId);
      return moveWidget(current, fromIndex, toIndex);
    });
  }, [identity]);

  const handleToggle = useCallback((id: WidgetId) => setLayout((current) => toggleWidget(current, id)), []);

  async function persistLayout() {
    setSavingLayout(true);
    try {
      await saveLayout({ version: LAYOUT_VERSION, widgets: layout });
      setSavedLayout(layout);
      setCustomizing(false);
      notify.success(t("customize.saved"));
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : t("customize.save_error"));
    } finally {
      setSavingLayout(false);
    }
  }

  function cancelCustomize() {
    setLayout(savedLayout);
    setCustomizing(false);
  }

  async function handleExport(report: ExportReport, excel: boolean) {
    setExporting(true);
    try {
      const { blob, filename } = await downloadReport(report, range, { granularity, lang: locale, excel });
      triggerDownload(blob, filename);
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : t("export.error"));
    } finally {
      setExporting(false);
    }
  }

  const refresh = () => setRefreshKey((value) => value + 1);
  const bumpExpenses = () => setExpensesVersion((value) => value + 1);

  const header = (
    <PageHeader
      title={t("header.title")}
      subtitle={t("header.subtitle")}
      actions={
        mayView ? (
          <div className="flex flex-wrap items-center gap-2">
            {!customizing && <RangePicker range={range} onChange={setRange} />}
            {customizing ? (
              <>
                <Button type="button" variant="ghost" size="sm" onClick={() => setLayout(defaultLayout())}>
                  <RotateCcw size={14} />
                  {t("customize.reset")}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={cancelCustomize} disabled={savingLayout}>
                  <X size={14} />
                  {t("customize.cancel")}
                </Button>
                <Button type="button" size="sm" onClick={() => void persistLayout()} disabled={savingLayout || layoutsEqual(layout, savedLayout)}>
                  <Check size={14} />
                  {t("customize.save")}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" size="icon" aria-label={t("actions.refresh")} onClick={refresh}>
                  <RefreshCw size={15} />
                </Button>
                <DropdownMenu
                  triggerLabel={t("export.label")}
                  trigger={exporting ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
                >
                  <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("export.range_hint").replace("{days}", String(rangeDays(range)))}
                  </p>
                  {(["overview", "timeseries", "wilayas", "products", "carriers"] as ExportReport[]).map((report) => (
                    <DropdownItem key={report} disabled={exporting} onClick={() => void handleExport(report, true)}>
                      {t(`export.reports.${report}`)}
                    </DropdownItem>
                  ))}
                  {mayFinance &&
                    (["pnl", "roas", "expenses"] as ExportReport[]).map((report) => (
                      <DropdownItem key={report} disabled={exporting} onClick={() => void handleExport(report, true)}>
                        {t(`export.reports.${report}`)}
                      </DropdownItem>
                    ))}
                  <p className="px-2.5 pb-1.5 pt-1 text-[10px] text-muted-foreground">{t("export.format_hint")}</p>
                </DropdownMenu>
                <Button type="button" variant="secondary" size="sm" onClick={() => setCustomizing(true)}>
                  <LayoutGrid size={14} />
                  {t("customize.label")}
                </Button>
                {canScope(identity, "orders:create") && (
                  <LinkButton href="/orders/new">
                    <Plus size={16} />
                    {t("recent_orders.new_order")}
                  </LinkButton>
                )}
              </>
            )}
          </div>
        ) : undefined
      }
    />
  );

  if (!mayView) {
    return (
      <div>
        {header}
        <Alert role="alert" tone="critical">
          {auth("no_access")}
        </Alert>
      </div>
    );
  }

  const count = visibleWidgets.length;

  function chromeFor(id: WidgetId, index: number): WidgetChrome {
    return {
      customizing,
      index,
      count,
      hidden: layout.find((entry) => entry.id === id)?.hidden ?? false,
      onMove: handleMove,
      onToggle: handleToggle,
    };
  }

  return (
    <div className="space-y-5">
      {header}
      {customizing && (
        <Alert tone="info">
          <LayoutGrid size={16} className="mt-0.5 shrink-0" />
          <p className="text-sm">{t("customize.hint")}</p>
        </Alert>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        {visibleWidgets.map((entry, index) => {
          const definition = WIDGETS.find((widget) => widget.id === entry.id)!;
          const chrome = chromeFor(entry.id, index);
          const span = definition.span === "full" ? "lg:col-span-2" : "";
          const key = entry.id;
          switch (entry.id) {
            case "kpis":
              return <div key={key} className={span}><KpiCards range={range} chrome={chrome} refreshKey={refreshKey} /></div>;
            case "today":
              return <div key={key} className={span}><TodayBoardWidget chrome={chrome} refreshKey={refreshKey} /></div>;
            case "alerts":
              return <div key={key} className={span}><AlertsWidget chrome={chrome} refreshKey={refreshKey} /></div>;
            case "timeseries":
              return (
                <div key={key} className={span}>
                  <TimeseriesChart
                    range={range}
                    granularity={granularity}
                    onGranularityChange={(value) => {
                      granularityTouched.current = true;
                      setGranularity(value);
                    }}
                    chrome={chrome}
                    refreshKey={refreshKey}
                  />
                </div>
              );
            case "wilayas":
              return <div key={key} className={span}><WilayaHeatmap range={range} chrome={chrome} refreshKey={refreshKey} /></div>;
            case "products":
              return <div key={key} className={span}><ProductsWidget range={range} chrome={chrome} refreshKey={refreshKey} /></div>;
            case "carriers":
              return <div key={key} className={span}><CarriersWidget range={range} chrome={chrome} refreshKey={refreshKey} /></div>;
            case "roas":
              return (
                <div key={key} className={span}>
                  <RoasWidget range={range} chrome={chrome} refreshKey={refreshKey + expensesVersion} onExpensesChanged={bumpExpenses} />
                </div>
              );
            case "pnl":
              return (
                <div key={key} className={span}>
                  <PnlWidget range={range} chrome={chrome} refreshKey={refreshKey} expensesVersion={expensesVersion} onExpensesChanged={bumpExpenses} />
                </div>
              );
            case "status_breakdown":
              return <div key={key} className={span}><StatusBreakdownWidget chrome={chrome} refreshKey={refreshKey} /></div>;
            case "recent_orders":
              return <div key={key} className={span}><RecentOrdersWidget chrome={chrome} refreshKey={refreshKey} /></div>;
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}

export default function DashboardPageApp() {
  return (
    <RequireAuth>
      <DashboardChrome currentPath="/dashboard">
        <DashboardOverview />
      </DashboardChrome>
    </RequireAuth>
  );
}
