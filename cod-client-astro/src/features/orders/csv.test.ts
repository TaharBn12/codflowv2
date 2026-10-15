import { describe, expect, it } from "vitest";
import {
  DEFAULT_CSV_COLUMNS,
  buildOrdersCsv,
  orderCsvColumns,
  ordersCsvFilename,
} from "./csv";
import type { OrderListItem } from "./types";

const order = (overrides: Partial<OrderListItem> = {}): OrderListItem =>
  ({
    id: "1",
    orderNumber: "ORD-001",
    customerName: "Ahmed Benali",
    phone: "0551234567",
    wilaya: "الجزائر",
    commune: "بئر مراد رايس",
    address: "12 Rue Didouche Mourad",
    price: 2500,
    deliveryFee: 400,
    codAmount: 2900,
    status: "new",
    orderType: "online",
    deliveryMethod: "company",
    deliveryType: "home",
    driverId: null,
    driverName: null,
    companyId: "c1",
    trackingNumber: "TRK-1",
    trackingUrl: null,
    stationCode: null,
    notes: null,
    lastCarrierStatus: null,
    lastTrackingSyncAt: null,
    deliveryAttempts: 0,
    createdAt: "2026-09-21T08:00:00.000Z",
    updatedAt: "2026-09-21T08:00:00.000Z",
    ...overrides,
  }) as OrderListItem;

/** Headers come from the locale in the app; a stub stands in for useT. */
const labels = new Proxy({} as Record<string, string>, {
  get: (_t, key: string) => `col.${key}`,
});

function columns(keys?: string[]) {
  return orderCsvColumns(labels, (status) => `status.${status}`, (v) => `${v} DZD`).filter(
    (column) => !keys || keys.includes(column.key),
  );
}

describe("buildOrdersCsv", () => {
  it("emits a header row followed by one row per order", () => {
    const csv = buildOrdersCsv([order(), order({ orderNumber: "ORD-002" })], columns(["orderNumber"]));
    const lines = csv.split("\r\n");
    expect(lines).toEqual(['"col.orderNumber"', '"ORD-001"', '"ORD-002"']);
  });

  it("keeps numeric columns numeric so spreadsheets sort them", () => {
    const csv = buildOrdersCsv([order()], columns(["price", "codAmount"]));
    expect(csv.split("\r\n")[1]).toBe('"2500","2900"');
  });

  it("quotes embedded quotes and commas (RFC 4180)", () => {
    const csv = buildOrdersCsv(
      [order({ customerName: 'Benali, "Ahmed"' })],
      columns(["customerName"]),
    );
    expect(csv.split("\r\n")[1]).toBe('"Benali, ""Ahmed"""');
  });

  it("neutralises spreadsheet formula injection", () => {
    for (const payload of ["=1+1", "+1+1", "-1+1", "@SUM(A1)"]) {
      const csv = buildOrdersCsv([order({ notes: payload })], columns(["notes"]));
      expect(csv.split("\r\n")[1]).toBe(`"\t${payload}"`);
    }
  });

  it("renders null values as empty cells", () => {
    const csv = buildOrdersCsv([order()], columns(["commune", "stationCode"]));
    expect(csv.split("\r\n")[1]).toBe(`"${order().commune}",`);
  });

  it("maps statuses through the caller's label function", () => {
    const csv = buildOrdersCsv([order()], columns(["status"]));
    expect(csv.split("\r\n")[1]).toBe('"status.new"');
  });

  it("only exports the columns that were picked", () => {
    const csv = buildOrdersCsv([order()], columns(DEFAULT_CSV_COLUMNS));
    const headers = csv.split("\r\n")[0].split(",");
    expect(headers).toContain('"col.orderNumber"');
    expect(headers).toContain('"col.trackingNumber"');
    // The default set is the operational minimum — notes stay opt-in.
    expect(headers).not.toContain('"col.notes"');
    expect(headers).toHaveLength(DEFAULT_CSV_COLUMNS.length);
  });

  it("every default column resolves to a real column definition", () => {
    const all = orderCsvColumns(labels, (s) => s, String).map((c) => c.key);
    for (const key of DEFAULT_CSV_COLUMNS) expect(all).toContain(key);
  });
});

describe("ordersCsvFilename", () => {
  it("suffixes the export date so repeated exports do not collide", () => {
    expect(ordersCsvFilename("orders", new Date("2026-09-21T23:30:00.000Z"))).toBe(
      "orders-2026-09-21.csv",
    );
  });
});
