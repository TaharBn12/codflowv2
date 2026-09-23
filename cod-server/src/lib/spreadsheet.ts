/**
 * Spreadsheet reading — the only module in cod-server that touches SheetJS.
 *
 * Kept deliberately thin and dependency-isolating:
 *   • the dashboard's order import is the sole consumer, so the parser is
 *     bundled once and every "what did the sheet actually contain?" question is
 *     answered here rather than in the endpoint;
 *   • the *mini* build is imported on purpose (`dist/xlsx.mini.min.js`, ~280 KB
 *     versus ~1 MB for the full ESM build). It drops styles, charts, images and
 *     VBA — none of which an order sheet needs — and the Worker bundle stays
 *     inside a sane size. Reading plain `.xlsx` / `.xls` / `.csv` cells is
 *     identical between the two builds;
 *   • limits are enforced before parsing, because a spreadsheet bomb (a few KB
 *     of zip expanding to millions of cells) is the classic way to hand a
 *     Worker an infinite loop.
 *
 * Output is intentionally dumb: `rows: unknown[][]` per sheet. Turning those
 * cells into orders (header detection, aliases, money parsing) is
 * cod-shared/lib/order-import's job, which the dashboard also uses to preview a
 * mapping without a second upload.
 */

import XLSXMini from "@e965/xlsx/dist/xlsx.mini.min.js";
import type * as SheetJs from "@e965/xlsx";

// The mini build is UMD; under a bundler its `module.exports` arrives as the
// default export. The cast keeps the official type definitions in play.
const XLSX = XLSXMini as unknown as typeof SheetJs;

/** Uploads above this are refused outright (a real order sheet is far smaller). */
export const SPREADSHEET_MAX_BYTES = 5 * 1024 * 1024;
/** Rows read from the first sheet before the rest is ignored. */
export const SPREADSHEET_MAX_ROWS = 2000;

const EXCEL_EXTENSIONS = [".xlsx", ".xlsm", ".xlsb", ".xls", ".xlt", ".ods"];
const TEXT_EXTENSIONS = [".csv", ".tsv", ".txt"];

export type SpreadsheetKind = "excel" | "csv";

export interface SheetTable {
  sheetName: string;
  /** Row-major cell values, exactly as the sheet holds them. */
  rows: unknown[][];
  /** True when SPREADSHEET_MAX_ROWS cut the sheet short. */
  truncated: boolean;
}

export interface SpreadsheetReadOptions {
  filename?: string;
  maxBytes?: number;
  maxRows?: number;
  /** Read only this sheet (default: every sheet, in workbook order). */
  sheetName?: string;
}

export function spreadsheetKind(filename: string): SpreadsheetKind | null {
  const name = filename.toLowerCase();
  if (EXCEL_EXTENSIONS.some((ext) => name.endsWith(ext))) return "excel";
  if (TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))) return "csv";
  return null;
}

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Parse an uploaded workbook into plain cell grids.
 *
 * Throws `SpreadsheetError` for anything the caller should report back to the
 * merchant as a 4xx (wrong type, too large, unreadable, empty) rather than a
 * 500 — an import that fails is a user-facing event, not a server fault.
 */
export function readSpreadsheet(
  data: ArrayBuffer | Uint8Array,
  options: SpreadsheetReadOptions = {},
): SheetTable[] {
  const maxBytes = options.maxBytes ?? SPREADSHEET_MAX_BYTES;
  const maxRows = options.maxRows ?? SPREADSHEET_MAX_ROWS;
  const bytes = toBytes(data);

  if (bytes.byteLength === 0) {
    throw new SpreadsheetError("The uploaded file is empty", "EMPTY_FILE");
  }
  if (bytes.byteLength > maxBytes) {
    throw new SpreadsheetError(
      `File is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — the limit is ${Math.round(
        maxBytes / 1024 / 1024,
      )} MB`,
      "FILE_TOO_LARGE",
    );
  }

  const kind = options.filename ? spreadsheetKind(options.filename) : null;
  if (options.filename && kind === null) {
    throw new SpreadsheetError(
      `Unsupported file type "${options.filename.split(".").pop()}" — upload .xlsx, .xls or .csv`,
      "UNSUPPORTED_FILE_TYPE",
    );
  }

  let workbook: SheetJs.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
      type: "array",
      // Cell dates as ISO strings, no formatting pass, no formula evaluation —
      // an order sheet is data, and every option here is CPU we do not spend.
      cellDates: false,
      cellFormula: false,
      cellStyles: false,
      cellNF: false,
      sheetStubs: false,
      dense: false,
    });
  } catch (err) {
    throw new SpreadsheetError(
      `Could not read the spreadsheet (${err instanceof Error ? err.message : "parse error"})`,
      "UNREADABLE_FILE",
    );
  }

  const wanted = options.sheetName
    ? workbook.SheetNames.filter((name) => name === options.sheetName)
    : workbook.SheetNames;
  if (wanted.length === 0) {
    throw new SpreadsheetError(
      options.sheetName
        ? `Sheet "${options.sheetName}" is not in this workbook`
        : "The workbook has no sheets",
      "SHEET_NOT_FOUND",
    );
  }

  const tables: SheetTable[] = [];
  for (const sheetName of wanted) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
      range: 0,
    }) as unknown[][];

    tables.push({
      sheetName,
      rows: rows.slice(0, maxRows),
      truncated: rows.length > maxRows,
    });
  }

  if (tables.every((table) => table.rows.length === 0)) {
    throw new SpreadsheetError("The spreadsheet has no rows", "EMPTY_FILE");
  }

  return tables;
}

/** Failure a merchant can act on — mapped to a 400/413/415 by the endpoint. */
export class SpreadsheetError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "EMPTY_FILE"
      | "FILE_TOO_LARGE"
      | "UNSUPPORTED_FILE_TYPE"
      | "UNREADABLE_FILE"
      | "SHEET_NOT_FOUND",
  ) {
    super(message);
    this.name = "SpreadsheetError";
  }
}
