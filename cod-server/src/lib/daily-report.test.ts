import { describe, expect, it } from "vitest";
import { localClock, renderEmailReport, renderTelegramReport, type DailyReportData } from "./daily-report";

const totals = {
  totalOrders: 42,
  confirmedOrders: 30,
  deliveredOrders: 18,
  returnedOrders: 2,
  cancelledOrders: 4,
  pendingConfirmation: 3,
  inTransit: 9,
  revenueDelivered: 81000,
  deliveryFeesDelivered: 9000,
  revenuePending: 65000,
  revenueLostReturns: 9000,
  avgOrderValue: 4500,
  confirmationRate: 71.4,
  deliveryRate: 90,
  returnRate: 10,
  cancellationRate: 9.5,
};

const sample: DailyReportData = {
  date: "2026-09-20",
  storeName: "Boutique <Test>",
  language: "en",
  today: totals,
  yesterday: { ...totals, totalOrders: 35, revenueDelivered: 60000 },
  topProducts: [{ name: "Montre & Co", orders: 12, revenueDelivered: 36000 }],
  topWilayas: [{ name: "Sétif", orders: 9, deliveryRate: 88.9 }],
  alerts: [
    { id: "unconfirmed_orders", severity: "warning", count: 5, href: "/orders?status=new" },
    { id: "driver_cash", severity: "critical", count: 2, amount: 120000, href: "/delivery" },
  ],
};

describe("localClock", () => {
  it("resolves the store-local day, hour and offset for Africa/Algiers (UTC+1)", () => {
    const clock = localClock(new Date("2026-09-20T19:30:00.000Z"), "Africa/Algiers");
    expect(clock.date).toBe("2026-09-20");
    expect(clock.hour).toBe(20);
    expect(clock.offsetMinutes).toBe(60);
    expect(clock.startOfDayIso).toBe("2026-09-19T23:00:00.000Z");
  });

  it("rolls over to the next local day after 23:00 UTC", () => {
    const clock = localClock(new Date("2026-09-20T23:30:00.000Z"), "Africa/Algiers");
    expect(clock.date).toBe("2026-09-21");
    expect(clock.hour).toBe(0);
  });

  it("falls back to Africa/Algiers for an unknown timezone", () => {
    const clock = localClock(new Date("2026-09-20T19:30:00.000Z"), "Mars/Olympus");
    expect(clock.offsetMinutes).toBe(60);
  });
});

describe("renderTelegramReport", () => {
  it("escapes HTML, shows deltas and lists alerts", () => {
    const text = renderTelegramReport(sample);
    expect(text).toContain("Boutique &lt;Test&gt;");
    expect(text).toContain("Orders: <b>42</b> ▲ 20%");
    expect(text).toContain("81,000 DZD");
    expect(text).toContain("Montre &amp; Co");
    expect(text).toContain("🔴 2 drivers holding unsettled cash (120,000 DZD)");
    expect(text).toContain("🟠 5 orders unconfirmed for 24h+");
  });

  it("renders Arabic copy when the store language is ar", () => {
    const text = renderTelegramReport({ ...sample, language: "ar" });
    expect(text).toContain("التقرير اليومي");
    expect(text).toContain("نسبة التسليم");
  });

  it("says when there are no orders yet", () => {
    const text = renderTelegramReport({ ...sample, today: { ...totals, totalOrders: 0 } });
    expect(text).toContain("No orders yet today");
  });
});

describe("renderEmailReport", () => {
  it("produces a subject, RTL html for Arabic and a plain-text fallback", () => {
    const email = renderEmailReport({ ...sample, language: "ar" });
    expect(email.subject).toContain("2026-09-20");
    expect(email.html).toContain('dir="rtl"');
    expect(email.html).not.toContain("<Test>");
    expect(email.text).not.toContain("<b>");
  });
});
