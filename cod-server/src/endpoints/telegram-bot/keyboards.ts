/**
 * Inline keyboards.
 *
 * Layout rules:
 *  - destructive actions never sit next to benign ones;
 *  - every screen has a single, predictable “back”;
 *  - callback payloads are short codes (see callbacks.ts) so order UUIDs fit
 *    inside Telegram's 64-byte limit.
 */

import { botText, statusLabel, STATUS_EMOJI, type BotLanguage } from "./i18n";
import { encodeCallback, ORDER_FILTERS, type OrderFilter } from "./callbacks";
import { alertKindLabel } from "./render";
import type { InlineKeyboard, InlineKeyboardButton } from "./api";
import type { BotOrderRow } from "./order-queries";
import type { OrderStatus } from "../orders/transitions";
import type { LinkedUser, TelegramLinkRow } from "./store";
import { can } from "./permissions";
import type { ApprovalRowView } from "./render";

function button(text: string, callback: Parameters<typeof encodeCallback>[0]): InlineKeyboardButton {
  return { text, callback_data: encodeCallback(callback) };
}

function urlButton(text: string, url: string): InlineKeyboardButton {
  return { text, url };
}

/**
 * Main menu. When an identity is supplied only the sections it may open are
 * rendered — a confirmer never sees «Approvals», a warehouse user never sees
 * «Finance». Without an identity the full catalog is returned (tests/setup).
 */
export function mainMenuKeyboard(language: BotLanguage, identity?: LinkedUser | null): InlineKeyboard {
  const rows: InlineKeyboard = [];
  const allow = (permission: Parameters<typeof can>[1]) => !identity || can(identity, permission);
  const first: InlineKeyboardButton[] = [];
  if (allow("orders.read")) first.push(button(botText(language, "menu_orders"), { type: "menu", view: "orders" }));
  if (allow("reports.view")) first.push(button(botText(language, "menu_reports"), { type: "menu", view: "reports" }));
  if (first.length) rows.push(first);
  const second: InlineKeyboardButton[] = [];
  if (allow("approvals.view")) second.push(button(botText(language, "menu_approvals"), { type: "menu", view: "approvals" }));
  second.push(button(botText(language, "menu_alerts"), { type: "menu", view: "alerts" }));
  rows.push(second);
  const third: InlineKeyboardButton[] = [];
  if (allow("stock.view") && allow("reports.view"))
    third.push(button(botText(language, "menu_stock"), { type: "report", period: "stock" }));
  if (allow("orders.read")) third.push(button(botText(language, "menu_search"), { type: "search", target: "orders" }));
  if (third.length) rows.push(third);
  rows.push([
    button(botText(language, "menu_settings"), { type: "menu", view: "settings" }),
    button(botText(language, "menu_help"), { type: "menu", view: "help" }),
  ]);
  return rows;
}

const FILTER_LAYOUT: OrderFilter[] = [...ORDER_FILTERS];

export function ordersMenuKeyboard(language: BotLanguage, counts: Record<string, number>): InlineKeyboard {
  const rows: InlineKeyboardButton[][] = [];
  const labels: Record<OrderFilter, string> = {
    all: `📋 ${botText(language, "filter_all")} (${counts.all ?? 0})`,
    active: `⏳ ${botText(language, "filter_active")} (${counts.active ?? 0})`,
    new: `${STATUS_EMOJI.new} ${statusLabel(language, "new")} (${counts.new ?? 0})`,
    confirmed: `${STATUS_EMOJI.confirmed} ${statusLabel(language, "confirmed")} (${counts.confirmed ?? 0})`,
    unreachable: `${STATUS_EMOJI.unreachable} ${statusLabel(language, "unreachable")} (${counts.unreachable ?? 0})`,
    preparing: `${STATUS_EMOJI.preparing} ${statusLabel(language, "preparing")} (${counts.preparing ?? 0})`,
    ready: `${STATUS_EMOJI.ready} ${statusLabel(language, "ready")} (${counts.ready ?? 0})`,
    dispatched: `${STATUS_EMOJI.dispatched} ${statusLabel(language, "dispatched")} (${counts.dispatched ?? 0})`,
    out_for_delivery: `${STATUS_EMOJI.out_for_delivery} ${statusLabel(language, "out_for_delivery")} (${counts.out_for_delivery ?? 0})`,
    delivered: `${STATUS_EMOJI.delivered} ${statusLabel(language, "delivered")} (${counts.delivered ?? 0})`,
    returned: `${STATUS_EMOJI.returned} ${statusLabel(language, "returned")} (${counts.returned ?? 0})`,
    cancelled: `${STATUS_EMOJI.cancelled} ${statusLabel(language, "cancelled")} (${counts.cancelled ?? 0})`,
  };
  for (let index = 0; index < FILTER_LAYOUT.length; index += 2) {
    rows.push(
      FILTER_LAYOUT.slice(index, index + 2).map((filter) =>
        button(labels[filter], { type: "orders_list", filter, page: 0 }),
      ),
    );
  }
  rows.push([button(botText(language, "search"), { type: "search", target: "orders" })]);
  rows.push([button(botText(language, "back"), { type: "menu", view: "main" })]);
  return rows;
}

/**
 * Results list with the status actions attached to each result, so a status is
 * one tap away without opening the card. Only targets the caller may actually
 * apply are passed in (`allowedStatusTargets`), and "cancelled" is left to the
 * card where it gets an explicit confirmation.
 */
export function ordersListKeyboard(
  language: BotLanguage,
  input: {
    rows: BotOrderRow[];
    filter: OrderFilter;
    page: number;
    total: number;
    pageSize: number;
    quickTargets?: Record<string, OrderStatus[]>;
  },
): InlineKeyboard {
  const rows: InlineKeyboardButton[][] = input.rows.map((row, index) => {
    const quick = (input.quickTargets?.[row.id] ?? []).filter((status) => status !== "cancelled").slice(0, 2);
    const label = `${input.page * input.pageSize + index + 1}. ${row.orderNumber} · ${row.customerName}`;
    return [
      button(label.slice(0, quick.length ? 34 : 60), { type: "order_view", orderId: row.id }),
      ...quick.map((status) =>
        button(`${STATUS_EMOJI[status] ?? ""} ${statusLabel(language, status)}`.slice(0, 20), {
          type: "order_status",
          orderId: row.id,
          status,
        }),
      ),
    ];
  });
  const pages = Math.max(1, Math.ceil(input.total / input.pageSize));
  const paging: InlineKeyboardButton[] = [];
  if (input.page > 0)
    paging.push(button(botText(language, "prev"), { type: "orders_list", filter: input.filter, page: input.page - 1 }));
  if (input.page + 1 < pages)
    paging.push(button(botText(language, "next"), { type: "orders_list", filter: input.filter, page: input.page + 1 }));
  if (paging.length) rows.push(paging);
  rows.push([
    button(botText(language, "search"), { type: "search", target: "orders" }),
    button(botText(language, "back"), { type: "menu", view: "orders" }),
  ]);
  return rows;
}

export function searchResultsKeyboard(language: BotLanguage, rows: BotOrderRow[]): InlineKeyboard {
  return [
    ...rows.map((row, index) => [
      button(`${index + 1}. ${row.orderNumber} · ${row.customerName}`.slice(0, 60), { type: "order_view", orderId: row.id }),
    ]),
    [button(botText(language, "back"), { type: "menu", view: "orders" })],
  ];
}

export function orderCardKeyboard(
  language: BotLanguage,
  input: { orderId: string; status: string; phone: string; targets: OrderStatus[]; filter: OrderFilter; page: number },
): InlineKeyboard {
  const rows: InlineKeyboardButton[][] = [];
  // Status actions: up to three per row, clearly labelled with the target state.
  for (let index = 0; index < input.targets.length; index += 3) {
    rows.push(
      input.targets.slice(index, index + 3).map((status) =>
        button(`${STATUS_EMOJI[status] ?? ""} ${statusLabel(language, status)}`, {
          type: "order_status",
          orderId: input.orderId,
          status,
        }),
      ),
    );
  }
  const waNumber = input.phone.replace(/[^\d]/g, "").replace(/^0/, "213");
  rows.push([
    button(`📞 ${botText(language, "copy_phone")}`, { type: "show_phone", orderId: input.orderId }),
    urlButton(`💬 ${botText(language, "whatsapp")}`, `https://wa.me/${waNumber}`),
  ]);
  rows.push([
    button(botText(language, "refresh"), { type: "order_view", orderId: input.orderId }),
    button(botText(language, "back"), { type: "orders_list", filter: input.filter, page: input.page }),
  ]);
  return rows;
}

export function reportsKeyboard(language: BotLanguage): InlineKeyboard {
  return [
    [button(botText(language, "reports_today"), { type: "report", period: "today" }), button(botText(language, "reports_yesterday"), { type: "report", period: "yesterday" })],
    [button(botText(language, "reports_week"), { type: "report", period: "week" }), button(botText(language, "reports_month"), { type: "report", period: "month" })],
    [button(botText(language, "reports_ops"), { type: "report", period: "ops" })],
    [button(botText(language, "reports_team"), { type: "report", period: "team" }), button(botText(language, "reports_stock"), { type: "report", period: "stock" })],
    [button(botText(language, "reports_finance"), { type: "report", period: "finance" }), button(botText(language, "reports_customers"), { type: "report", period: "customers" })],
    [button(botText(language, "back"), { type: "menu", view: "main" })],
  ];
}

export function reportResultKeyboard(language: BotLanguage): InlineKeyboard {
  return [
    [button(botText(language, "reports_week"), { type: "report", period: "week" }), button(botText(language, "reports_ops"), { type: "report", period: "ops" })],
    [button(botText(language, "back"), { type: "menu", view: "reports" })],
  ];
}

export function approvalsKeyboard(language: BotLanguage, total: number): InlineKeyboard {
  return [
    [button(`📥 ${botText(language, "approvals_view")} (${total})`, { type: "approvals_list", page: 0 })],
    [button(botText(language, "back"), { type: "menu", view: "main" })],
  ];
}

export function approvalsListKeyboard(
  language: BotLanguage,
  input: { rows: ApprovalRowView[]; page: number; total: number },
): InlineKeyboard {
  const rows: InlineKeyboardButton[][] = input.rows.map((row, index) => [
    button(
      `${input.page * 5 + index + 1}. ${row.title}${row.amount != null ? ` · ${Math.round(row.amount)}` : ""}`.slice(0, 60),
      { type: "approval_view", id: row.id },
    ),
  ]);
  const pages = Math.max(1, Math.ceil(input.total / 5));
  const paging: InlineKeyboardButton[] = [];
  if (input.page > 0) paging.push(button(botText(language, "prev"), { type: "approvals_list", page: input.page - 1 }));
  if (input.page + 1 < pages) paging.push(button(botText(language, "next"), { type: "approvals_list", page: input.page + 1 }));
  if (paging.length) rows.push(paging);
  rows.push([button(botText(language, "back"), { type: "menu", view: "main" })]);
  return rows;
}

export function approvalCardKeyboard(language: BotLanguage, id: string): InlineKeyboard {
  return [
    [
      button(botText(language, "approvals_approve"), { type: "approval_decision", id, decision: "approve" }),
      button(botText(language, "approvals_reject"), { type: "approval_decision", id, decision: "reject" }),
    ],
    [button(botText(language, "approvals_reject_reason"), { type: "approval_decision", id, decision: "reject_with_reason" })],
    [button(botText(language, "back"), { type: "approvals_list", page: 0 })],
  ];
}

const ALERT_KINDS = ["orders", "shipping", "stock", "finance", "support", "approvals", "reports"] as const;

export function alertsKeyboard(language: BotLanguage, link: TelegramLinkRow): InlineKeyboard {
  const valueOf = (kind: (typeof ALERT_KINDS)[number]) =>
    ({
      orders: link.notifyOrders,
      shipping: link.notifyShipping,
      stock: link.notifyStock,
      finance: link.notifyFinance,
      support: link.notifySupport,
      approvals: link.notifyApprovals,
      reports: link.notifyReports,
    })[kind];
  const rows: InlineKeyboardButton[][] = [];
  for (let index = 0; index < ALERT_KINDS.length; index += 2) {
    rows.push(
      ALERT_KINDS.slice(index, index + 2).map((kind) =>
        button(
          `${valueOf(kind) ? "✅" : "⛔"} ${alertKindLabel(language, kind)}`,
          { type: "alert_toggle", kind },
        ),
      ),
    );
  }
  rows.push(
    (["instant", "hourly", "daily"] as const).map((mode) =>
      button(
        `${link.digestMode === mode ? "• " : ""}${botText(language, `digest_${mode}` as "digest_instant")}`,
        { type: "alert_digest", mode },
      ),
    ),
  );
  const muted = link.mutedUntil && new Date(link.mutedUntil).getTime() > Date.now();
  rows.push([
    muted
      ? button(botText(language, "alerts_unmute"), { type: "alert_unmute" })
      : button(botText(language, "alerts_mute"), { type: "alert_mute", minutes: 120 }),
  ]);
  rows.push([button(botText(language, "back"), { type: "menu", view: "main" })]);
  return rows;
}

export function settingsKeyboard(language: BotLanguage): InlineKeyboard {
  return [
    (["ar", "fr", "en"] as const).map((code) =>
      button(`${language === code ? "• " : ""}${code.toUpperCase()}`, { type: "language", language: code }),
    ),
    [button(botText(language, "settings_unlink"), { type: "unlink", confirm: false })],
    [button(botText(language, "back"), { type: "menu", view: "main" })],
  ];
}

export function confirmUnlinkKeyboard(language: BotLanguage): InlineKeyboard {
  return [
    [button(`⚠️ ${botText(language, "settings_unlink")}`, { type: "unlink", confirm: true })],
    [button(botText(language, "back"), { type: "menu", view: "settings" })],
  ];
}

export function backKeyboard(language: BotLanguage, view: "main" | "orders" | "reports" | "approvals" | "alerts" | "settings" | "help"): InlineKeyboard {
  return [[button(botText(language, "back"), { type: "menu", view })]];
}

// ─── Customers ───────────────────────────────────────────────────────────────

export function customerResultsKeyboard(
  language: BotLanguage,
  rows: Array<{ id: string; name: string; phone: string }>,
): InlineKeyboard {
  return [
    ...rows.map((row, index) => [
      button(`${index + 1}. ${row.name} · ${row.phone}`.slice(0, 60), { type: "customer_view", id: row.id }),
    ]),
    [
      button(botText(language, "search"), { type: "search", target: "customers" }),
      button(botText(language, "back"), { type: "menu", view: "main" }),
    ],
  ];
}

export function customerCardKeyboard(
  language: BotLanguage,
  orders: Array<{ id: string; orderNumber: string }>,
): InlineKeyboard {
  return [
    ...orders.slice(0, 3).map((order) => [
      button(`📦 ${order.orderNumber}`.slice(0, 60), { type: "order_view", orderId: order.id }),
    ]),
    [button(botText(language, "back"), { type: "menu", view: "main" })],
  ];
}
