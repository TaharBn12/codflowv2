/**
 * Orders CSV export
 *
 * Exports exactly what the merchant is looking at (the current filter +
 * sort), with a column picker — the same file feeds the merchant's own
 * spreadsheet and the carrier's import template, which is why the columns are
 * individually selectable instead of a fixed dump.
 *
 * The output carries a UTF-8 BOM: without it Excel reads Arabic customer names
 * as mojibake. Values are RFC 4180 quoted, and anything that a spreadsheet
 * could reinterpret as a formula (=, +, -, @) is prefixed with a tab so an
 * exported note can never execute on open.
 */

import type { OrderListItem } from "./types";

export interface CsvColumn {
  key: string;
  /** Localized header — resolved by the caller. */
  header: string;
  /** Raw cell value; numbers stay numbers so spreadsheets keep sorting them. */
  value: (order: OrderListItem) => string | number | null | undefined;
}

/** Every exportable column, in the default export order. */
export function orderCsvColumns(
  labels: Record<string, string>,
  statusLabel: (status: string) => string,
  formatMoney: (value: number) => string,
): CsvColumn[] {
  return [
    { key: "orderNumber", header: labels.orderNumber, value: (o) => o.orderNumber },
    { key: "createdAt", header: labels.createdAt, value: (o) => o.createdAt },
    { key: "status", header: labels.status, value: (o) => statusLabel(o.status) },
    { key: "customerName", header: labels.customerName, value: (o) => o.customerName },
    { key: "phone", header: labels.phone, value: (o) => o.phone },
    { key: "wilaya", header: labels.wilaya, value: (o) => o.wilaya },
    { key: "commune", header: labels.commune, value: (o) => o.commune },
    { key: "address", header: labels.address, value: (o) => o.address },
    { key: "price", header: labels.price, value: (o) => o.price },
    { key: "deliveryFee", header: labels.deliveryFee, value: (o) => o.deliveryFee },
    { key: "codAmount", header: labels.codAmount, value: (o) => o.codAmount ?? "" },
    { key: "codAmountText", header: labels.codAmountText, value: (o) => formatMoney(o.codAmount ?? o.price) },
    { key: "deliveryType", header: labels.deliveryType, value: (o) => o.deliveryType },
    { key: "deliveryMethod", header: labels.deliveryMethod, value: (o) => o.deliveryMethod },
    { key: "driverName", header: labels.driverName, value: (o) => o.driverName },
    { key: "trackingNumber", header: labels.trackingNumber, value: (o) => o.trackingNumber },
    { key: "stationCode", header: labels.stationCode, value: (o) => o.stationCode },
    { key: "deliveryAttempts", header: labels.deliveryAttempts, value: (o) => o.deliveryAttempts ?? 0 },
    { key: "lastCarrierStatus", header: labels.lastCarrierStatus, value: (o) => o.lastCarrierStatus },
    { key: "lastTrackingSyncAt", header: labels.lastTrackingSyncAt, value: (o) => o.lastTrackingSyncAt },
    { key: "notes", header: labels.notes, value: (o) => o.notes },
  ];
}

/** Columns selected by default — the operational minimum. */
export const DEFAULT_CSV_COLUMNS = [
  "orderNumber",
  "createdAt",
  "status",
  "customerName",
  "phone",
  "wilaya",
  "commune",
  "address",
  "codAmount",
  "deliveryType",
  "trackingNumber",
];

function escapeCell(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return "";
  const text = String(input);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `\t${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Build the CSV text for the given rows and columns (headers included). */
export function buildOrdersCsv(
  rows: OrderListItem[],
  columns: CsvColumn[],
): string {
  const header = columns.map((column) => escapeCell(column.header)).join(",");
  const body = rows.map((row) =>
    columns.map((column) => escapeCell(column.value(row))).join(","),
  );
  return [header, ...body].join("\r\n");
}

/**
 * Trigger a client-side download. The BOM is what makes Excel decode the file
 * as UTF-8; `text/csv;charset=utf-8` alone is not enough on Windows.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** orders-2026-09-21.csv — the date keeps repeated exports from colliding. */
export function ordersCsvFilename(prefix: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return `${prefix}-${date}.csv`;
}
