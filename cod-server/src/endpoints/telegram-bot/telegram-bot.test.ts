/**
 * Telegram bot unit tests — pure layers only (no network, no D1).
 *
 * Covered:
 *   - callback codec round-trip, 64-byte limit, unknown payloads;
 *   - role-based status targets (admin / staff / confirmer / driver);
 *   - trilingual copy completeness;
 *   - HTML escaping in rendered order cards;
 *   - inline keyboard shape (no empty rows, destructive actions isolated);
 *   - link-code generation alphabet;
 *   - phone normalisation for search.
 */

import { describe, expect, it } from "vitest";
import {
  decodeCallback,
  decodeLegacyApprovalCallback,
  encodeCallback,
  filterCode,
  filterFromCode,
  statusFromCode,
  STATUS_CODE,
  type BotCallback,
} from "./callbacks";
import { allowedStatusTargets, alertTogglePatch, can } from "./permissions";
import { botText, ORDER_STATUSES, statusLabel } from "./i18n";
import { escapeHtml, renderOrderCard, renderOrdersList, renderMainMenu } from "./render";
import { mainMenuKeyboard, ordersMenuKeyboard, orderCardKeyboard, approvalsKeyboard } from "./keyboards";
import { generateLinkCode, roleCanReceive, DEFAULT_BOT_CONFIG, type LinkedUser } from "./store";
import { normalizePhoneQuery } from "./order-queries";
import { canTransition, allowedNextStatuses, type OrderStatus } from "../orders/transitions";

const ORDER_ID = "0f9c2e6a-1111-4a2b-9c3d-aaaaaaaaaaaa";

function identity(role: LinkedUser["user"]["role"], scopes: string[] = []): LinkedUser {
  return {
    link: {
      telegramUserId: "42",
      chatId: "42",
      userId: "u1",
      username: "tester",
      firstName: "Test",
      language: "ar",
      notifyOrders: true,
      notifyShipping: true,
      notifyStock: true,
      notifyFinance: true,
      notifySupport: false,
      notifyApprovals: true,
      notifyReports: true,
      digestMode: "instant",
      mutedUntil: null,
      linkedAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    } as LinkedUser["link"],
    user: {
      id: "u1",
      name: "Tester",
      email: "t@example.com",
      role,
      status: "active",
      language: "ar",
    },
    scopes,
  };
}

describe("callback codec", () => {
  const callbacks: BotCallback[] = [
    { type: "noop" },
    { type: "menu", view: "main" },
    { type: "orders_list", filter: "out_for_delivery", page: 3 },
    { type: "order_view", orderId: ORDER_ID },
    { type: "order_status", orderId: ORDER_ID, status: "confirmed" },
    { type: "approval_decision", id: ORDER_ID, decision: "reject_with_reason" },
    { type: "report", period: "finance" },
    { type: "alert_toggle", kind: "shipping" },
    { type: "alert_digest", mode: "daily" },
    { type: "alert_mute", minutes: 120 },
    { type: "language", language: "fr" },
    { type: "unlink", confirm: true },
    { type: "search", target: "customers" },
    { type: "customer_view", id: ORDER_ID },
    { type: "show_phone", orderId: ORDER_ID },
  ];

  it.each(callbacks)("round-trips %j", (callback) => {
    const data = encodeCallback(callback);
    expect(decodeCallback(data)).toEqual(callback);
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
  });

  it("rejects malformed payloads instead of acting on them", () => {
    expect(decodeCallback("os:not-a-uuid:zz")).toBeNull();
    expect(decodeCallback("mn:unknown")).toBeNull();
    expect(decodeCallback("rp:year")).toBeNull();
    expect(decodeCallback(undefined)).toBeNull();
    expect(decodeCallback("")).toBeNull();
  });

  it("clamps page numbers and mute durations", () => {
    expect(decodeCallback("ol:al:-5")).toEqual({ type: "orders_list", filter: "all", page: 0 });
    expect(decodeCallback("am:999999")).toEqual({ type: "alert_mute", minutes: 1440 });
    expect(decodeCallback("am:1")).toEqual({ type: "alert_mute", minutes: 15 });
  });

  it("still accepts legacy approval callbacks from older messages", () => {
    expect(decodeLegacyApprovalCallback(`approval:approve:${ORDER_ID}`)).toEqual({
      id: ORDER_ID,
      decision: "approve",
    });
    expect(decodeLegacyApprovalCallback("approval:maybe:abc")).toBeNull();
  });

  it("maps every status and filter code both ways", () => {
    for (const status of ORDER_STATUSES) {
      expect(statusFromCode(STATUS_CODE[status])).toBe(status);
    }
    for (const filter of ["all", "active", "new", "delivered", "cancelled"] as const) {
      expect(filterFromCode(filterCode(filter))).toBe(filter);
    }
  });
});

describe("bot permissions", () => {
  it("gives admins every status from a valid transition", () => {
    expect(allowedStatusTargets(identity("admin"), "new")).toEqual(
      expect.arrayContaining(["confirmed", "unreachable", "cancelled"]),
    );
  });

  it("limits a confirmer to the confirmation funnel", () => {
    expect(allowedStatusTargets(identity("confirmer"), "new")).toEqual(
      expect.arrayContaining(["confirmed", "unreachable"]),
    );
    expect(allowedStatusTargets(identity("confirmer"), "ready")).toEqual([]);
    expect(allowedStatusTargets(identity("confirmer"), "out_for_delivery")).toEqual([]);
  });

  it("requires the update scope for staff", () => {
    expect(allowedStatusTargets(identity("staff"), "new")).toEqual([]);
    expect(allowedStatusTargets(identity("staff", ["orders:update"]), "new")).toEqual(
      expect.arrayContaining(["confirmed"]),
    );
  });

  it("blocks destructive statuses without delete rights", () => {
    const targets = allowedStatusTargets(identity("staff", ["orders:update"]), "new");
    expect(targets).not.toContain("cancelled");
    const manager = allowedStatusTargets(identity("staff", ["orders:update", "orders:delete"]), "new");
    expect(manager).toContain("cancelled");
  });

  it("lets only admins decide approvals and see money", () => {
    expect(can(identity("admin"), "approvals.decide")).toBe(true);
    expect(can(identity("staff", ["orders:read"]), "approvals.decide")).toBe(false);
    expect(can(identity("staff"), "reports.finance")).toBe(false);
    expect(can(identity("staff", ["analytics:finance"]), "reports.finance")).toBe(true);
  });

  it("keeps finance and approvals out of non-admin notification feeds", () => {
    expect(roleCanReceive("finance", "staff")).toBe(false);
    expect(roleCanReceive("approvals", "staff")).toBe(false);
    expect(roleCanReceive("orders", "confirmer")).toBe(true);
    expect(roleCanReceive("stock", "driver")).toBe(false);
  });

  it("toggles each alert category independently", () => {
    const link = identity("admin").link;
    expect(alertTogglePatch("orders", link)).toEqual({ notifyOrders: false });
    expect(alertTogglePatch("stock", { ...link, notifyStock: false })).toEqual({ notifyStock: true });
    expect(alertTogglePatch("unknown", link)).toBeNull();
  });
});

describe("order workflow", () => {
  it("never allows backward or terminal transitions", () => {
    expect(canTransition("new", "confirmed")).toBe(true);
    expect(canTransition("delivered", "new")).toBe(false);
    expect(canTransition("cancelled", "confirmed")).toBe(false);
    expect(allowedNextStatuses("delivered")).toEqual([]);
  });
});

describe("bot copy", () => {
  it("has every key translated in ar / fr / en", () => {
    const keys = [
      "menu_title", "menu_orders", "menu_reports", "menu_approvals", "menu_alerts",
      "menu_settings", "menu_help", "back", "next", "prev", "order_card", "order_search_prompt",
      "approvals_approve", "approvals_reject", "approvals_reject_reason", "alerts_saved",
      "settings_unlink", "customer_card", "customer_search_prompt", "search", "not_linked",
      "link_success", "permission_denied", "error_generic", "reports_today", "reports_finance",
    ] as const;
    for (const language of ["ar", "fr", "en"] as const) {
      for (const key of keys) {
        const value = botText(language, key);
        expect(value, `${language}.${key}`).not.toBe(key);
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("interpolates variables and translates statuses", () => {
    expect(botText("ar", "order_card", { number: "ORD-1" })).toContain("ORD-1");
    expect(statusLabel("ar", "out_for_delivery")).toBe("في الطريق");
    expect(statusLabel("fr", "delivered")).toBe("Livrée");
    expect(statusLabel("en", "delivered")).toBe("Delivered");
    expect(statusLabel("en", "not_a_status")).toBe("not_a_status");
  });
});

describe("rendering", () => {
  const detail = {
    order: {
      id: ORDER_ID,
      orderNumber: "ORD-20261019-0042",
      customerName: "<script>alert(1)</script>",
      phone: "0550123456",
      status: "new" as const,
      price: 4500,
      deliveryFee: 500,
      codAmount: 5000,
      createdAt: "2026-10-19T09:00:00.000Z",
      wilayaId: 16,
      wilayaName: "Alger",
      wilayaNameAr: "الجزائر",
      address: "Rue <b>1</b>",
      city: "Bab Ezzouar",
      notes: null,
      deliveryType: "home" as const,
      deliveryMethod: "unassigned" as const,
      trackingNumber: null,
      trackingUrl: null,
      driverId: null,
      companyId: null,
      updatedAt: "2026-10-19T09:00:00.000Z",
      customerId: "c1",
    },
    driverName: null,
    companyName: null,
    products: [{ name: "Galaxy A54", variant: "أسود / 128GB", quantity: 1, lineTotal: 4500 }],
    customer: { totalOrders: 3, deliveredOrders: 2, returnedOrders: 1 },
    history: [],
  };

  it("escapes customer-controlled HTML in the order card", () => {
    const text = renderOrderCard("ar", detail, ["confirmed", "unreachable", "cancelled"]);
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("ORD-20261019-0042");
    expect(text).toMatch(/5.000 دج/);
    expect(text).toContain("اضغط حالة للانتقال إليها");
  });

  it("says so when there are no legal next states", () => {
    const delivered = { ...detail, order: { ...detail.order, status: "delivered" as const } };
    expect(renderOrderCard("en", delivered, [])).toContain("No actions available");
  });

  it("renders empty and non-empty order lists safely", () => {
    const empty = renderOrdersList("fr", { filter: "new", page: 0, total: 0, rows: [], pageSize: 8 });
    expect(empty).toContain("Aucune commande");
    const rows = renderOrdersList("en", {
      filter: "all",
      page: 0,
      total: 1,
      pageSize: 8,
      rows: [detail.order],
    });
    expect(rows).toContain("ORD-20261019-0042");
    expect(rows).toContain("New");
  });

  it("shows the linked user and counts on the main menu", () => {
    const menu = renderMainMenu("ar", identity("admin"), { new: 4, active: 9, dispatched: 2, out_for_delivery: 1, delivered: 30 });
    expect(menu).toContain("مركز قيادة CodFlow");
    expect(menu).toContain("Tester");
    expect(menu).toContain("30");
  });

  it("escapeHtml covers the three dangerous characters", () => {
    expect(escapeHtml("<a & b>")).toBe("&lt;a &amp; b&gt;");
  });
});

describe("keyboards", () => {
  const noEmptyRows = (rows: Array<Array<{ text: string }>>) => {
    for (const row of rows) {
      expect(row.length).toBeGreaterThan(0);
      for (const button of row) expect(button.text.length).toBeGreaterThan(0);
    }
  };

  it("builds the main menu with one row per pair", () => {
    const rows = mainMenuKeyboard("ar");
    expect(rows).toHaveLength(3);
    noEmptyRows(rows);
  });

  it("shows counts on every filter button", () => {
    const rows = ordersMenuKeyboard("en", { all: 12, active: 5, new: 3 });
    expect(rows[0][0].text).toContain("12");
    noEmptyRows(rows);
  });

  it("puts status actions before contact actions on a card", () => {
    const rows = orderCardKeyboard("ar", {
      orderId: ORDER_ID,
      status: "new",
      phone: "0550123456",
      targets: ["confirmed", "unreachable", "cancelled"] as OrderStatus[],
      filter: "new",
      page: 0,
    });
    expect(rows[0]).toHaveLength(3);
    expect(rows[0][0].callback_data).toBe(`os:${ORDER_ID}:cf`);
    expect(rows[1].some((button) => button.url?.includes("wa.me/213"))).toBe(true);
    noEmptyRows(rows);
  });

  it("sizes approval buttons for the 64-byte callback budget", () => {
    const rows = approvalsKeyboard("en", 2);
    for (const row of rows) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callback_data ?? "", "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("link codes", () => {
  it("generates 8 unambiguous uppercase characters", () => {
    for (let index = 0; index < 25; index += 1) {
      const code = generateLinkCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it("has safe defaults for a fresh install", () => {
    expect(DEFAULT_BOT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_BOT_CONFIG.defaultLanguage).toBe("ar");
    expect(DEFAULT_BOT_CONFIG.quietHoursStart).toBeGreaterThan(DEFAULT_BOT_CONFIG.quietHoursEnd);
  });
});

describe("order search helpers", () => {
  it("normalises Algerian phone formats", () => {
    expect(normalizePhoneQuery("+213 550 12 34 56")).toBe("0550123456");
    expect(normalizePhoneQuery("00213550123456")).toBe("00213550123456");
    expect(normalizePhoneQuery("ORD-20261019-0042")).toBe("");
  });
});
