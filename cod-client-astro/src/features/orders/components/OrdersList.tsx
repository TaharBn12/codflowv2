import { useDeferredValue, useEffect, useState } from "react";
import {
  AlertCircle,
  Download,
  Filter,
  PackageOpen,
  RefreshCw,
  WandSparkles,
  X,
} from "lucide-react";
import { canScope, useIdentity } from "@/features/auth/components/RequireAuth";
import { useLocale, useT } from "@/i18n/react";
import {
  autoAssignNewOrders,
  bulkAssignConfirmationOrders,
  getAutomationSettings,
  saveAutomationSettings,
  listOperationAgents,
  type OperationAgent,
} from "@/features/operations/api";
import { notify } from "@/lib/notify";
import { ApiError } from "@/lib/api";
import {
  assignDriver,
  bulkSyncCarrierStatuses,
  listDeliveryCompanies,
  listDrivers,
  listOrders,
  updateOrderStatus,
} from "@/features/orders/api";
import {
  FILTER_STATUSES,
  filterOrders,
  formatMoney,
  paginateOrders,
  sortOrders,
  type OrderFilters,
  type OrderSortKey,
} from "@/features/orders/model";
import {
  DEFAULT_CSV_COLUMNS,
  buildOrdersCsv,
  downloadCsv,
  orderCsvColumns,
  ordersCsvFilename,
} from "@/features/orders/csv";
import {
  ORDER_STATUSES,
  type DeliveryCompany,
  type Driver,
  type OrderListItem,
} from "@/features/orders/types";
import {
  EmptyState,
  LinkButton,
  Alert,
  Card,
  Pagination,
  SearchInput,
  Select,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  SortHeader,
} from "@/components/ui";
import {
  OrderDesktopRow,
  OrderMobileCard,
} from "@/features/orders/components/OrderRow";

const EMPTY_FILTERS: OrderFilters = {
  query: "",
  status: "all",
  delivery: "all",
  wilaya: "all",
  type: "all",
  confirmationAssignment: "all",
  confirmerId: "all",
};

function OrderSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="h-14 border-b border-border bg-muted/35" />
      {Array.from({ length: 7 }).map((_, index) => (
        <div
          key={index}
          className="grid h-14 grid-cols-[1fr_1.2fr_0.8fr] items-center gap-4 border-b border-border px-4 last:border-0"
        >
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
          <span className="h-6 w-20 justify-self-end animate-pulse rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="relative flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-3 sm:flex-none">
      <Filter
        size={14}
        aria-hidden="true"
        className="shrink-0 text-muted-foreground"
      />
      <Select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        variant="bare"
        size="sm"
        wrapperClassName="min-w-0 flex-1"
        triggerClassName="min-w-0 flex-1"
      >
        {children}
      </Select>
    </label>
  );
}

export function OrdersList() {
  const t = useT("orders");
  const locale = useLocale();
  const common = useT("common");
  const operations = useT("operations");
  const auth = useT("auth");
  const identity = useIdentity();
  const [orders, setOrders] = useState<OrderListItem[] | null>(null);
  const [companies, setCompanies] = useState<DeliveryCompany[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [agents, setAgents] = useState<OperationAgent[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAgentId, setBulkAgentId] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [autoAssignBusy, setAutoAssignBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkDriverId, setBulkDriverId] = useState("");
  const [bulkActionBusy, setBulkActionBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportColumns, setExportColumns] = useState<string[]>(DEFAULT_CSV_COLUMNS);
  const [automationEnabled, setAutomationEnabled] = useState(true);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | Error | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filters, setFilters] = useState<OrderFilters>(() => {
    // Deep links from the dashboard (alerts, heatmap, today board) preselect filters.
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    const delivery = params.get("delivery");
    const wilaya = params.get("wilaya");
    return {
      ...EMPTY_FILTERS,
      query: params.get("search") ?? "",
      status: status && (ORDER_STATUSES as readonly string[]).includes(status) ? status : EMPTY_FILTERS.status,
      delivery: delivery && ["driver", "company", "unassigned"].includes(delivery) ? delivery : EMPTY_FILTERS.delivery,
      wilaya: wilaya ? wilaya : EMPTY_FILTERS.wilaya,
    };
  });
  const [sortKey, setSortKey] = useState<OrderSortKey>("createdAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const deferredFilters = useDeferredValue(filters);
  const pageSize = 10;

  async function load() {
    if (!canScope(identity, "orders:read")) return;
    setLoadError(null);
    try {
      const mayReadDelivery = canScope(identity, "delivery:read");
      const [orderResponse, companyResponse, driverResponse] =
        await Promise.all([
          listOrders({ limit: 100, offset: 0 }),
          mayReadDelivery ? listDeliveryCompanies(true) : Promise.resolve([]),
          mayReadDelivery ? listDrivers() : Promise.resolve([]),
        ]);
      setOrders(orderResponse.data ?? []);
      setCompanies(companyResponse);
      setDrivers(driverResponse);
      if (identity?.role === "admin") {
        const [nextAgents, automation] = await Promise.all([
          listOperationAgents(),
          getAutomationSettings(),
        ]);
        setAgents(nextAgents);
        setAutomationEnabled(automation.autoAssignEnabled);
      }
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  useEffect(() => {
    void load();
  }, [identity?.role, identity?.scopes.join(",")]);

  useEffect(() => {
    setPage(1);
  }, [deferredFilters, sortKey, sortDirection]);

  if (!canScope(identity, "orders:read")) {
    return (
      <Alert role="alert" tone="critical">
        {auth("no_access")}
      </Alert>
    );
  }

  if (loadError) {
    return (
      <Alert role="alert" tone="critical">
        <AlertCircle size={18} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">{t("load_error")}</p>
          <p className="mt-1 text-xs opacity-80">{loadError.message}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 text-xs font-semibold underline underline-offset-4"
          >
            {common("retry")}
          </button>
        </div>
      </Alert>
    );
  }

  if (orders === null) return <OrderSkeleton />;

  const filteredOrders = filterOrders(orders, deferredFilters);
  const sortedOrders = sortOrders(filteredOrders, sortKey, sortDirection);
  const totalPages = Math.max(1, Math.ceil(sortedOrders.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleOrders = paginateOrders(sortedOrders, safePage, pageSize);
  const wilayas = [
    ...new Set(orders.map((order) => order.wilaya).filter(Boolean)),
  ] as string[];
  const hasFilters = Object.values(filters).some(
    (value) => value !== "all" && value !== "",
  );

  function setFilter(key: keyof OrderFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function handleSort(key: string) {
    const cast = key as OrderSortKey;
    if (sortKey === cast)
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortKey(cast);
      setSortDirection("asc");
    }
  }

  const rowProps = {
    drivers,
    companies,
    onChanged: load,
    onError: setActionError,
    agents,
    isAdmin: identity?.role === "admin",
  };
  function selectionProps(orderId: string) {
    if (identity?.role !== "admin") return {};
    return {
      selected: selectedIds.has(orderId),
      onSelected: (selected: boolean) =>
        setSelectedIds((current) => {
          const next = new Set(current);
          selected ? next.add(orderId) : next.delete(orderId);
          return next;
        }),
    };
  }

  async function autoAssign() {
    setAutoAssignBusy(true);
    try {
      const result = await autoAssignNewOrders(
        selectedIds.size ? [...selectedIds] : undefined,
      );
      notify.success(`${operations("auto_assigned")}: ${result.data.assigned}`);
      setSelectedIds(new Set());
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAutoAssignBusy(false);
    }
  }

  async function bulkAssign() {
    if (!bulkAgentId || selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      await bulkAssignConfirmationOrders([...selectedIds], bulkAgentId);
      notify.success(operations("bulk_assigned"));
      setSelectedIds(new Set());
      setBulkAgentId("");
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  /**
   * Pull the latest statuses from the delivery companies. With a selection it
   * polls only those orders (throttle bypassed); without one it sweeps every
   * company that is due. The server applies changes forward-only, so this can
   * never move an order backwards.
   */
  async function syncFromCarriers() {
    setSyncBusy(true);
    setActionError(null);
    try {
      const orderIds = selectedIds.size ? [...selectedIds] : undefined;
      const result = await bulkSyncCarrierStatuses({ orderIds, force: !!orderIds });
      const { totals, companies } = result;
      const unmapped = companies
        .flatMap((company) => company.unmappedStatuses)
        .filter((value, index, all) => all.indexOf(value) === index);
      const summary = t("carrier_sync.result")
        .replace("{updated}", String(totals.updated))
        .replace("{polled}", String(totals.polled))
        .replace("{errors}", String(totals.errors));
      if (totals.errors > 0) notify.error(`${summary} — ${t("carrier_sync.errors")}`);
      else if (unmapped.length > 0)
        notify.success(`${summary} — ${t("carrier_sync.unmapped")}: ${unmapped.join(", ")}`);
      else notify.success(summary);
      setSelectedIds(new Set());
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncBusy(false);
    }
  }

  /**
   * Bulk status change / driver assignment.
   *
   * These run per order rather than through one endpoint on purpose: the
   * single-order handlers own the state-machine and dispatch side effects
   * (shipment creation, activity log, notifications), and an order whose
   * transition is rejected must not abort the rest of the batch. The tally
   * is reported back so a partial run is never silent.
   */
  async function bulkUpdate(mode: "status" | "driver") {
    const target = mode === "status" ? bulkStatus : bulkDriverId;
    if (!target || selectedIds.size === 0 || bulkActionBusy) return;
    setBulkActionBusy(true);
    let ok = 0;
    let failed = 0;
    let lastError = "";
    for (const id of [...selectedIds]) {
      try {
        if (mode === "status") await updateOrderStatus(id, target);
        else await assignDriver(id, target);
        ok += 1;
      } catch (error) {
        failed += 1;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    setBulkActionBusy(false);
    setSelectedIds(new Set());
    if (mode === "status") setBulkStatus("");
    else setBulkDriverId("");
    await load();
    const summary = t(
      mode === "status" ? "bulk.done_status" : "bulk.done_driver",
    ).replace("{ok}", String(ok));
    if (failed === 0) {
      notify.success(summary);
      return;
    }
    const failure = t("bulk.failed").replace("{count}", String(failed));
    notify.error(
      ok > 0
        ? `${t("bulk.partial").replace("{ok}", String(ok)).replace("{count}", String(failed))} — ${lastError}`
        : `${failure} — ${lastError}`,
    );
  }

  /** Export the current filter + sort — not the whole table. */
  function exportCsv(rows: OrderListItem[]) {
    const labels = new Proxy({} as Record<string, string>, {
      get: (_target, key: string) => t(`export.columns.${key}`),
    });
    const columns = orderCsvColumns(
      labels,
      (status) => t(`status.${status}`),
      (value) => formatMoney(value, locale),
    ).filter((column) => exportColumns.includes(column.key));

    if (rows.length === 0) {
      notify.error(t("export.export_empty"));
      return;
    }
    if (columns.length === 0) {
      notify.error(t("export.export_columns_title"));
      return;
    }
    downloadCsv(ordersCsvFilename("orders"), buildOrdersCsv(rows, columns));
  }

  async function toggleAutomation() {
    setAutomationBusy(true);
    try {
      const result = await saveAutomationSettings(!automationEnabled);
      setAutomationEnabled(result.autoAssignEnabled);
      notify.success(
        operations(
          result.autoAssignEnabled
            ? "automation_enabled"
            : "automation_disabled",
        ),
      );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAutomationBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {actionError && (
        <Alert role="alert" tone="critical">
          <AlertCircle size={18} className="shrink-0" />
          <div className="flex-1">{actionError}</div>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label={common("cancel")}
          >
            <X size={16} />
          </button>
        </Alert>
      )}
      {identity?.role === "admin" && selectedIds.size > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3 sm:flex-row sm:items-center">
          <span className="text-sm font-semibold">
            {selectedIds.size} {operations("selected_orders")}
          </span>
          <Select
            value={bulkAgentId}
            onChange={(event) => setBulkAgentId(event.target.value)}
            className="h-10 min-w-52 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="">{operations("select_agent")}</option>
            {agents
              .filter((agent) => agent.status === "active")
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
          </Select>
          <button
            type="button"
            disabled={!bulkAgentId || bulkBusy}
            onClick={() => void bulkAssign()}
            className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {operations("assign")}
          </button>
          <button
            type="button"
            disabled={syncBusy}
            onClick={() => void syncFromCarriers()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-input bg-background px-4 text-sm font-semibold disabled:opacity-50"
          >
            <RefreshCw size={16} className={syncBusy ? "animate-spin" : undefined} />
            {syncBusy ? t("carrier_sync.syncing") : t("carrier_sync.bulk_button")}
          </button>
          <Select
            aria-label={t("bulk.status_title")}
            value={bulkStatus}
            onChange={(event) => setBulkStatus(event.target.value)}
            className="h-10 min-w-44 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="">{t("bulk.pick_status")}</option>
            {FILTER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`status.${status}`)}
              </option>
            ))}
          </Select>
          <button
            type="button"
            disabled={!bulkStatus || bulkActionBusy}
            onClick={() => void bulkUpdate("status")}
            className="h-10 rounded-lg border border-input bg-background px-4 text-sm font-semibold disabled:opacity-50"
          >
            {t("bulk.apply")}
          </button>
          <Select
            aria-label={t("bulk.driver_title")}
            value={bulkDriverId}
            onChange={(event) => setBulkDriverId(event.target.value)}
            className="h-10 min-w-44 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="">{t("bulk.pick_driver")}</option>
            {drivers
              .filter((driver) => driver.status !== "inactive")
              .map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.firstName} {driver.lastName}
                </option>
              ))}
          </Select>
          <button
            type="button"
            disabled={!bulkDriverId || bulkActionBusy}
            onClick={() => void bulkUpdate("driver")}
            className="h-10 rounded-lg border border-input bg-background px-4 text-sm font-semibold disabled:opacity-50"
          >
            {t("bulk.apply")}
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="h-10 px-3 text-sm font-semibold text-muted-foreground"
          >
            {common("cancel")}
          </button>
        </div>
      )}
      <Card flush>
        <div className="space-y-3 border-b border-border p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SearchInput
              value={filters.query}
              onChange={(query) => setFilter("query", query)}
              placeholder={t("search_placeholder")}
            />
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              {filteredOrders.length} {t("orders_count")}
            </span>
            {identity?.role === "admin" && (
              <>
                <div className="flex h-10 items-center gap-3 rounded-lg border border-border bg-card px-3">
                  <span className="text-xs font-semibold text-foreground">
                    {operations("automatic_distribution")}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={automationEnabled}
                    aria-label={operations("automatic_distribution")}
                    disabled={automationBusy}
                    onClick={() => void toggleAutomation()}
                    className={`relative h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${automationEnabled ? "bg-brand" : "bg-muted-foreground/35"}`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 size-4 rounded-full shadow-sm transition-transform ${automationEnabled ? "translate-x-5 bg-brand-foreground" : "translate-x-0 bg-background"}`}
                    />
                  </button>
                </div>
                <button
                  type="button"
                  disabled={autoAssignBusy}
                  onClick={() => void autoAssign()}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                >
                  <WandSparkles size={16} />
                  {autoAssignBusy
                    ? operations("assigning")
                    : operations("auto_assign_new")}
                </button>
              </>
            )}
            {canScope(identity, "orders:update") && (
              <button
                type="button"
                disabled={syncBusy}
                onClick={() => void syncFromCarriers()}
                title={t("carrier_sync.toolbar_hint")}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-input bg-card px-4 text-sm font-semibold disabled:opacity-60"
              >
                <RefreshCw size={16} className={syncBusy ? "animate-spin" : undefined} />
                {syncBusy ? t("carrier_sync.syncing") : t("carrier_sync.toolbar_button")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setExportOpen((open) => !open)}
              aria-expanded={exportOpen}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-input bg-card px-4 text-sm font-semibold"
            >
              <Download size={16} />
              {t("export.export_button")}
            </button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <FilterSelect
              label={t("filters.status")}
              value={filters.status}
              onChange={(value) => setFilter("status", value)}
            >
              <option value="all">{t("status.all")}</option>
              {FILTER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`status.${status}`)}
                </option>
              ))}
            </FilterSelect>
            {identity?.role === "admin" && (
              <>
                <FilterSelect
                  label={t("filters.confirmation_assignment")}
                  value={filters.confirmationAssignment ?? "all"}
                  onChange={(value) =>
                    setFilter("confirmationAssignment", value)
                  }
                >
                  <option value="all">{t("filters.all_assignments")}</option>
                  <option value="assigned">
                    {t("filters.assigned_confirmation")}
                  </option>
                  <option value="unassigned">
                    {t("filters.unassigned_confirmation")}
                  </option>
                </FilterSelect>
                <FilterSelect
                  label={t("filters.confirmer")}
                  value={filters.confirmerId ?? "all"}
                  onChange={(value) => setFilter("confirmerId", value)}
                >
                  <option value="all">{t("filters.all_confirmers")}</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </FilterSelect>
              </>
            )}
            <FilterSelect
              label={t("filters.delivery_method")}
              value={filters.delivery}
              onChange={(value) => setFilter("delivery", value)}
            >
              <option value="all">{t("filters.all_delivery")}</option>
              <option value="driver">{t("filters.driver")}</option>
              <option value="company">{t("filters.company")}</option>
              <option value="unassigned">{t("filters.unassigned")}</option>
            </FilterSelect>
            <FilterSelect
              label={t("filters.type")}
              value={filters.type}
              onChange={(value) => setFilter("type", value)}
            >
              <option value="all">{t("filters.type")}</option>
              <option value="online">{t("type.online")}</option>
              <option value="offline">{t("type.offline")}</option>
            </FilterSelect>
            {wilayas.length > 1 && (
              <FilterSelect
                label={t("filters.wilaya")}
                value={filters.wilaya}
                onChange={(value) => setFilter("wilaya", value)}
              >
                <option value="all">{t("filters.all_wilayas")}</option>
                {wilayas.map((wilaya) => (
                  <option key={wilaya} value={wilaya}>
                    {wilaya}
                  </option>
                ))}
              </FilterSelect>
            )}
            {hasFilters && (
              <button
                type="button"
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="h-10 rounded-lg px-3 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {common("cancel")}
              </button>
            )}
          </div>
          {exportOpen && (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">
                {t("export.export_columns_title")}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {orderCsvColumns(
                  new Proxy({} as Record<string, string>, {
                    get: (_target, key: string) => t(`export.columns.${key}`),
                  }),
                  (status) => t(`status.${status}`),
                  (value) => formatMoney(value, locale),
                ).map((column) => (
                  <label
                    key={column.key}
                    className="inline-flex items-center gap-1.5 text-xs font-medium"
                  >
                    <input
                      type="checkbox"
                      checked={exportColumns.includes(column.key)}
                      onChange={(event) =>
                        setExportColumns((current) =>
                          event.target.checked
                            ? [...current, column.key]
                            : current.filter((key) => key !== column.key),
                        )
                      }
                    />
                    {column.header}
                  </label>
                ))}
              </div>
              <button
                type="button"
                onClick={() => exportCsv(sortedOrders)}
                className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
              >
                <Download size={15} />
                {t("export.export_run").replace("{count}", String(sortedOrders.length))}
              </button>
            </div>
          )}
        </div>

        {filteredOrders.length === 0 ? (
          <EmptyState
            icon={<PackageOpen size={22} />}
            title={
              hasFilters ? common("no_results_found") : t("empty_state.title")
            }
            description={hasFilters ? undefined : t("empty_state.description")}
            action={
              !hasFilters && canScope(identity, "orders:create") ? (
                <LinkButton href="/orders/new">
                  {t("empty_state.action")}
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="divide-y divide-border md:hidden">
              {visibleOrders.map((order) => (
                <OrderMobileCard
                  key={order.id}
                  order={order}
                  {...rowProps}
                  {...selectionProps(order.id)}
                />
              ))}
            </div>

            <div className="hidden overflow-x-auto md:block">
              <Table className="min-w-[940px]">
                <TableHeader>
                  <TableRow className="text-xs font-semibold text-muted-foreground">
                    {identity?.role === "admin" && (
                      <TableHead className="w-10">
                        <input
                          type="checkbox"
                          checked={
                            visibleOrders.length > 0 &&
                            visibleOrders.every((order) =>
                              selectedIds.has(order.id),
                            )
                          }
                          onChange={(event) =>
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              visibleOrders.forEach((order) =>
                                event.target.checked
                                  ? next.add(order.id)
                                  : next.delete(order.id),
                              );
                              return next;
                            })
                          }
                          aria-label="Select visible orders"
                        />
                      </TableHead>
                    )}
                    <SortHeader
                      label={t("table.order_number")}
                      sortKey="orderNumber"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader
                      label={t("table.customer")}
                      sortKey="customerName"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                    />
                    <TableHead className="text-start">
                      {t("table.phone")}
                    </TableHead>
                    <SortHeader
                      label={t("table.status")}
                      sortKey="status"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                    />
                    <TableHead className="text-start">
                      {t("table.confirmation_assignment")}
                    </TableHead>
                    <SortHeader
                      label={t("table.wilaya")}
                      sortKey="wilaya"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                    />
                    <TableHead className="text-start">
                      {t("table.delivery")}
                    </TableHead>
                    <SortHeader
                      label={t("table.total")}
                      sortKey="total"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                      align="end"
                    />
                    <TableHead className="w-12">
                      <span className="sr-only">{common("table.actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleOrders.map((order) => (
                    <OrderDesktopRow
                      key={order.id}
                      order={order}
                      {...rowProps}
                      {...selectionProps(order.id)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>

            <Pagination
              page={safePage}
              totalPages={totalPages}
              total={sortedOrders.length}
              pageSize={pageSize}
              onPageChange={setPage}
            />
          </>
        )}
      </Card>
    </div>
  );
}
