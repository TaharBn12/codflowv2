/**
 * Compact callback-data codec.
 *
 * Telegram caps `callback_data` at 64 bytes. Order ids are UUIDs (36 chars),
 * so every prefix and status need short codes. Encoding/decoding lives here
 * (with tests) instead of being string-spliced across handlers.
 */

import { ORDER_STATUSES, type BotOrderStatus } from "./i18n";

export const STATUS_CODE: Record<BotOrderStatus, string> = {
  new: "nw",
  confirmed: "cf",
  unreachable: "un",
  preparing: "pr",
  ready: "rd",
  assigned: "as",
  dispatched: "ds",
  out_for_delivery: "of",
  delivered: "dv",
  returned: "rt",
  cancelled: "cn",
};

const CODE_STATUS = Object.fromEntries(
  Object.entries(STATUS_CODE).map(([status, code]) => [code, status]),
) as Record<string, BotOrderStatus>;

export function statusFromCode(code: string): BotOrderStatus | null {
  return CODE_STATUS[code] ?? null;
}

export const ORDER_FILTERS = [
  "all",
  "active",
  "new",
  "confirmed",
  "unreachable",
  "preparing",
  "ready",
  "dispatched",
  "out_for_delivery",
  "delivered",
  "returned",
  "cancelled",
] as const;

export type OrderFilter = (typeof ORDER_FILTERS)[number];

const FILTER_CODE: Record<OrderFilter, string> = {
  all: "al",
  active: "ac",
  new: "nw",
  confirmed: "cf",
  unreachable: "un",
  preparing: "pr",
  ready: "rd",
  dispatched: "ds",
  out_for_delivery: "of",
  delivered: "dv",
  returned: "rt",
  cancelled: "cn",
};

const CODE_FILTER = Object.fromEntries(
  Object.entries(FILTER_CODE).map(([filter, code]) => [code, filter]),
) as Record<string, OrderFilter>;

export function filterFromCode(code: string): OrderFilter {
  return CODE_FILTER[code] ?? "all";
}

export function filterCode(filter: OrderFilter): string {
  return FILTER_CODE[filter] ?? "al";
}

export type BotCallback =
  | { type: "noop" }
  | { type: "menu"; view: "main" | "orders" | "reports" | "approvals" | "alerts" | "settings" | "help" }
  | { type: "orders_list"; filter: OrderFilter; page: number }
  | { type: "order_view"; orderId: string }
  | { type: "order_status"; orderId: string; status: BotOrderStatus }
  | { type: "approvals_list"; page: number }
  | { type: "approval_view"; id: string }
  | { type: "approval_decision"; id: string; decision: "approve" | "reject" | "reject_with_reason" }
  | { type: "alert_toggle"; kind: string }
  | { type: "alert_digest"; mode: "instant" | "hourly" | "daily" }
  | { type: "alert_mute"; minutes: number }
  | { type: "alert_unmute" }
  | { type: "language"; language: "ar" | "fr" | "en" }
  | { type: "unlink"; confirm: boolean }
  | { type: "report"; period: "today" | "yesterday" | "week" | "month" | "ops" | "team" | "stock" | "finance" | "customers" }
  | { type: "show_phone"; orderId: string }
  | { type: "search"; target: "orders" | "customers" }
  | { type: "customer_view"; id: string };

export const CALLBACK_PREFIX = {
  noop: "np",
  menu: "mn",
  ordersList: "ol",
  orderView: "ov",
  orderStatus: "os",
  approvalsList: "al",
  approvalView: "aw",
  approvalDecision: "ad",
  alertToggle: "at",
  alertDigest: "ag",
  alertMute: "am",
  alertUnmute: "ax",
  language: "lg",
  unlink: "ul",
  report: "rp",
  showPhone: "ph",
  search: "sr",
  customerView: "cv",
} as const;

export function encodeCallback(callback: BotCallback): string {
  switch (callback.type) {
    case "noop":
      return CALLBACK_PREFIX.noop;
    case "menu":
      return `${CALLBACK_PREFIX.menu}:${callback.view}`;
    case "orders_list":
      return `${CALLBACK_PREFIX.ordersList}:${filterCode(callback.filter)}:${Math.max(0, callback.page)}`;
    case "order_view":
      return `${CALLBACK_PREFIX.orderView}:${callback.orderId}`;
    case "order_status":
      return `${CALLBACK_PREFIX.orderStatus}:${callback.orderId}:${STATUS_CODE[callback.status]}`;
    case "approvals_list":
      return `${CALLBACK_PREFIX.approvalsList}:${Math.max(0, callback.page)}`;
    case "approval_view":
      return `${CALLBACK_PREFIX.approvalView}:${callback.id}`;
    case "approval_decision":
      return `${CALLBACK_PREFIX.approvalDecision}:${callback.decision === "approve" ? "y" : callback.decision === "reject" ? "n" : "r"}:${callback.id}`;
    case "alert_toggle":
      return `${CALLBACK_PREFIX.alertToggle}:${callback.kind}`;
    case "alert_digest":
      return `${CALLBACK_PREFIX.alertDigest}:${callback.mode}`;
    case "alert_mute":
      return `${CALLBACK_PREFIX.alertMute}:${callback.minutes}`;
    case "alert_unmute":
      return CALLBACK_PREFIX.alertUnmute;
    case "language":
      return `${CALLBACK_PREFIX.language}:${callback.language}`;
    case "unlink":
      return `${CALLBACK_PREFIX.unlink}:${callback.confirm ? "y" : "n"}`;
    case "report":
      return `${CALLBACK_PREFIX.report}:${callback.period}`;
    case "show_phone":
      return `${CALLBACK_PREFIX.showPhone}:${callback.orderId}`;
    case "search":
      return `${CALLBACK_PREFIX.search}:${callback.target === "customers" ? "c" : "o"}`;
    case "customer_view":
      return `${CALLBACK_PREFIX.customerView}:${callback.id}`;
  }
}

const MENU_VIEWS = ["main", "orders", "reports", "approvals", "alerts", "settings", "help"] as const;
const REPORT_PERIODS = ["today", "yesterday", "week", "month", "ops", "team", "stock", "finance", "customers"] as const;
const DIGEST_MODES = ["instant", "hourly", "daily"] as const;
const LANGUAGES = ["ar", "fr", "en"] as const;

export function decodeCallback(data: string | undefined | null): BotCallback | null {
  if (!data) return null;
  if (data === CALLBACK_PREFIX.noop) return { type: "noop" };
  if (data === CALLBACK_PREFIX.alertUnmute) return { type: "alert_unmute" };

  const [prefix, ...rest] = data.split(":");
  switch (prefix) {
    case CALLBACK_PREFIX.menu: {
      const view = rest[0] as (typeof MENU_VIEWS)[number];
      return MENU_VIEWS.includes(view) ? { type: "menu", view } : null;
    }
    case CALLBACK_PREFIX.ordersList: {
      const page = Number.parseInt(rest[1] ?? "0", 10);
      return {
        type: "orders_list",
        filter: filterFromCode(rest[0] ?? "al"),
        page: Number.isFinite(page) && page >= 0 ? page : 0,
      };
    }
    case CALLBACK_PREFIX.orderView:
      return rest[0] ? { type: "order_view", orderId: rest[0] } : null;
    case CALLBACK_PREFIX.orderStatus: {
      const status = statusFromCode(rest[1] ?? "");
      if (!rest[0] || !status) return null;
      return { type: "order_status", orderId: rest[0], status };
    }
    case CALLBACK_PREFIX.approvalsList: {
      const page = Number.parseInt(rest[0] ?? "0", 10);
      return { type: "approvals_list", page: Number.isFinite(page) && page >= 0 ? page : 0 };
    }
    case CALLBACK_PREFIX.approvalView:
      return rest[0] ? { type: "approval_view", id: rest[0] } : null;
    case CALLBACK_PREFIX.approvalDecision: {
      const decision = rest[0] === "y" ? "approve" : rest[0] === "n" ? "reject" : rest[0] === "r" ? "reject_with_reason" : null;
      if (!decision || !rest[1]) return null;
      return { type: "approval_decision", id: rest[1], decision };
    }
    case CALLBACK_PREFIX.alertToggle:
      return rest[0] ? { type: "alert_toggle", kind: rest[0] } : null;
    case CALLBACK_PREFIX.alertDigest: {
      const mode = rest[0] as (typeof DIGEST_MODES)[number];
      return DIGEST_MODES.includes(mode) ? { type: "alert_digest", mode } : null;
    }
    case CALLBACK_PREFIX.alertMute: {
      const minutes = Number.parseInt(rest[0] ?? "120", 10);
      return { type: "alert_mute", minutes: Number.isFinite(minutes) ? Math.max(15, Math.min(minutes, 24 * 60)) : 120 };
    }
    case CALLBACK_PREFIX.language: {
      const language = rest[0] as (typeof LANGUAGES)[number];
      return LANGUAGES.includes(language) ? { type: "language", language } : null;
    }
    case CALLBACK_PREFIX.unlink:
      return { type: "unlink", confirm: rest[0] === "y" };
    case CALLBACK_PREFIX.report: {
      const period = rest[0] as (typeof REPORT_PERIODS)[number];
      return REPORT_PERIODS.includes(period) ? { type: "report", period } : null;
    }
    case CALLBACK_PREFIX.showPhone:
      return rest[0] ? { type: "show_phone", orderId: rest[0] } : null;
    case CALLBACK_PREFIX.search:
      return { type: "search", target: rest[0] === "c" ? "customers" : "orders" };
    case CALLBACK_PREFIX.customerView:
      return rest[0] ? { type: "customer_view", id: rest[0] } : null;
    default:
      return null;
  }
}

/** Legacy `approval:approve:<id>` callbacks from messages sent before v1.2. */
export function decodeLegacyApprovalCallback(
  data: string | undefined | null,
): { id: string; decision: "approve" | "reject" } | null {
  if (!data) return null;
  const match = /^approval:(approve|reject):([0-9a-f-]+)$/.exec(data);
  if (!match) return null;
  return { id: match[2], decision: match[1] as "approve" | "reject" };
}

export function isValidOrderStatus(value: string): value is BotOrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}
