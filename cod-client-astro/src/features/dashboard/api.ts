import { apiFetch, apiFetchBlob } from "@/lib/api";
import type {
  CarrierStat,
  DashboardAlert,
  DashboardLayout,
  ExpenseInput,
  ExpenseRecord,
  Granularity,
  OrderStatusStat,
  OverviewResult,
  ProductStat,
  ProfitAndLoss,
  ReportConfig,
  RoasResult,
  TimeseriesPoint,
  TodayBoard,
  WilayaStat,
} from "../../../../cod-shared/queries/analytics";
import type { DateRange } from "./model";

interface Envelope<T> {
  success: boolean;
  data: T;
}

export interface ReportConfigView extends ReportConfig {
  telegramConfigured: boolean;
  emailConfigured: boolean;
}

export interface ReportSendResult {
  telegram: "sent" | "skipped" | "not_configured" | "failed";
  email: { sent: number; failed: number; skipped: boolean; notConfigured: boolean };
  errors: string[];
}

function rangeQuery(range: DateRange, extra: Record<string, string | number | undefined> = {}) {
  const params = new URLSearchParams({ from: range.from, to: range.to, tz: String(range.tz) });
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

function json(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } };
}

export async function getDashboardStats(): Promise<OrderStatusStat[]> {
  const response = await apiFetch<Envelope<OrderStatusStat[]>>("/api/analytics/dashboard-stats");
  return response.data;
}

export async function getOverview(range: DateRange): Promise<OverviewResult> {
  return (await apiFetch<Envelope<OverviewResult>>(`/api/analytics/overview?${rangeQuery(range)}`)).data;
}

export async function getTimeseries(range: DateRange, granularity: Granularity): Promise<TimeseriesPoint[]> {
  return (
    await apiFetch<Envelope<TimeseriesPoint[]>>(`/api/analytics/timeseries?${rangeQuery(range, { granularity })}`)
  ).data;
}

export async function getWilayaStats(range: DateRange): Promise<WilayaStat[]> {
  return (await apiFetch<Envelope<WilayaStat[]>>(`/api/analytics/wilayas?${rangeQuery(range)}`)).data;
}

export async function getProductStats(range: DateRange, limit = 100): Promise<ProductStat[]> {
  return (await apiFetch<Envelope<ProductStat[]>>(`/api/analytics/products?${rangeQuery(range, { limit })}`)).data;
}

export async function getCarrierStats(range: DateRange, wilayaId?: number): Promise<CarrierStat[]> {
  return (await apiFetch<Envelope<CarrierStat[]>>(`/api/analytics/carriers?${rangeQuery(range, { wilayaId })}`)).data;
}

export async function getAlerts(): Promise<DashboardAlert[]> {
  return (await apiFetch<Envelope<DashboardAlert[]>>("/api/analytics/alerts")).data;
}

export async function getTodayBoard(startOfDayIso: string): Promise<TodayBoard> {
  const params = new URLSearchParams({ from: startOfDayIso });
  return (await apiFetch<Envelope<TodayBoard>>(`/api/analytics/today?${params}`)).data;
}

export async function getPnl(range: DateRange): Promise<ProfitAndLoss> {
  return (await apiFetch<Envelope<ProfitAndLoss>>(`/api/analytics/pnl?${rangeQuery(range)}`)).data;
}

export async function getRoas(range: DateRange, landingPageId?: string): Promise<RoasResult> {
  return (await apiFetch<Envelope<RoasResult>>(`/api/analytics/roas?${rangeQuery(range, { landingPageId })}`)).data;
}

export async function listExpenses(range: DateRange, category?: string): Promise<ExpenseRecord[]> {
  return (await apiFetch<Envelope<ExpenseRecord[]>>(`/api/analytics/expenses?${rangeQuery(range, { category, limit: 500 })}`)).data;
}

export async function createExpense(input: ExpenseInput): Promise<ExpenseRecord> {
  return (await apiFetch<Envelope<ExpenseRecord>>("/api/analytics/expenses", json({ method: "POST", body: JSON.stringify(input) }))).data;
}

export async function updateExpense(id: string, input: Partial<ExpenseInput>): Promise<ExpenseRecord> {
  return (
    await apiFetch<Envelope<ExpenseRecord>>(`/api/analytics/expenses/${id}`, json({ method: "PATCH", body: JSON.stringify(input) }))
  ).data;
}

export async function deleteExpense(id: string): Promise<void> {
  await apiFetch<{ success: boolean }>(`/api/analytics/expenses/${id}`, { method: "DELETE" });
}

export type ExportReport = "overview" | "timeseries" | "wilayas" | "products" | "carriers" | "pnl" | "expenses" | "roas";

export async function downloadReport(
  report: ExportReport,
  range: DateRange,
  options: { granularity?: Granularity; lang: string; excel?: boolean },
): Promise<{ blob: Blob; filename: string }> {
  const query = rangeQuery(range, {
    report,
    granularity: options.granularity,
    lang: options.lang,
    delimiter: options.excel ? "semicolon" : "comma",
  });
  const blob = await apiFetchBlob(`/api/analytics/export?${query}`);
  return { blob, filename: `codflow-${report}-${range.from.slice(0, 10)}-${range.to.slice(0, 10)}.csv` };
}

export async function getLayout(): Promise<DashboardLayout | null> {
  return (await apiFetch<Envelope<DashboardLayout | null>>("/api/analytics/dashboard-layout")).data;
}

export async function saveLayout(layout: DashboardLayout): Promise<void> {
  await apiFetch<Envelope<DashboardLayout>>("/api/analytics/dashboard-layout", json({ method: "PUT", body: JSON.stringify(layout) }));
}

export async function getReportConfig(): Promise<ReportConfigView> {
  return (await apiFetch<Envelope<ReportConfigView>>("/api/analytics/report-config")).data;
}

export async function saveReportConfig(input: Omit<ReportConfig, "lastSentOn">): Promise<ReportConfigView> {
  return (
    await apiFetch<Envelope<ReportConfigView>>("/api/analytics/report-config", json({ method: "PUT", body: JSON.stringify(input) }))
  ).data;
}

export async function sendReportNow(): Promise<ReportSendResult> {
  return (await apiFetch<Envelope<ReportSendResult>>("/api/analytics/report/send", { method: "POST" })).data;
}
