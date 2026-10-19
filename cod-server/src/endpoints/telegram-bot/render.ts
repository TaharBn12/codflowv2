/**
 * Message rendering (HTML parse mode).
 *
 * Only this module knows how a screen looks. Handlers decide *what* to show;
 * renderers turn data into Telegram-safe HTML with escaped user content.
 */

import { botText, roleLabel, statusLabel, STATUS_EMOJI, type BotLanguage, type BotStringKey } from "./i18n";
import type { OrderFilter } from "./callbacks";
import type { BotOrderDetail, BotOrderRow } from "./order-queries";
import type { LinkedUser, TelegramLinkRow } from "./store";
import type { OrderStatus } from "../orders/transitions";

export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function cut(value: string, max: number): string {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

const NUMBER_FORMAT = new Intl.NumberFormat("fr-DZ", { maximumFractionDigits: 0 });

export function money(language: BotLanguage, value: number | null | undefined): string {
  const amount = Number(value ?? 0);
  const suffix = language === "ar" ? "دج" : "DA";
  return `${NUMBER_FORMAT.format(Number.isFinite(amount) ? amount : 0)} ${suffix}`;
}

export function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${Math.round(Number(value) * 10) / 10}%`;
}

export function delta(current: number, previous: number): string {
  if (!previous) return current ? "▲ جديد" : "—";
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.5) return "＝ 0%";
  return `${change > 0 ? "▲ +" : "▼ "}${Math.round(change)}%`;
}

function timeOnly(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function wilayaName(row: { wilayaName: string | null; wilayaNameAr: string | null }, language: BotLanguage) {
  return (language === "ar" ? row.wilayaNameAr : row.wilayaName) ?? row.wilayaName ?? "—";
}

export function orderRowLabel(language: BotLanguage, row: BotOrderRow, index?: number): string {
  const prefix = index != null ? `${index + 1}. ` : "";
  return `${prefix}${STATUS_EMOJI[row.status] ?? "•"} ${cut(row.orderNumber, 14)} · ${cut(wilayaName(row, language), 12)} · ${money(language, row.price)}`;
}

export function filterLabel(language: BotLanguage, filter: OrderFilter): string {
  if (filter === "all") return botText(language, "filter_all");
  if (filter === "active") return botText(language, "filter_active");
  return statusLabel(language, filter);
}

export function renderMainMenu(
  language: BotLanguage,
  identity: LinkedUser,
  counts: Record<string, number>,
): string {
  return [
    `<b>${botText(language, "menu_title")}</b>`,
    `👤 ${escapeHtml(identity.user.name)} · ${roleLabel(language, identity.user.role)}`,
    "",
    `🆕 ${botText(language, "status_new")}: <b>${counts.new ?? 0}</b> · ⏳ ${botText(language, "pending_confirmation")}: <b>${counts.active ?? 0}</b>`,
    `🚚 ${botText(language, "in_transit")}: <b>${(counts.dispatched ?? 0) + (counts.out_for_delivery ?? 0)}</b> · ✅ ${botText(language, "delivered")}: <b>${counts.delivered ?? 0}</b>`,
    "",
    `<i>${botText(language, "menu_hint")}</i>`,
  ].join("\n");
}

export function renderOrdersMenu(
  language: BotLanguage,
  counts: Record<string, number>,
): string {
  const line = (status: string) =>
    `${STATUS_EMOJI[status as OrderStatus] ?? "•"} ${statusLabel(language, status)}: <b>${counts[status] ?? 0}</b>`;
  return [
    `<b>📦 ${botText(language, "orders_title")}</b>`,
    line("new"),
    line("confirmed"),
    line("unreachable"),
    line("preparing"),
    line("ready"),
    line("dispatched"),
    line("out_for_delivery"),
    line("delivered"),
    line("returned"),
    line("cancelled"),
    "",
    `<i>${botText(language, "orders_choose_filter")}</i>`,
  ].join("\n");
}

export function renderOrdersList(
  language: BotLanguage,
  input: { filter: OrderFilter; page: number; total: number; rows: BotOrderRow[]; pageSize: number },
): string {
  const header = `<b>${filterLabel(language, input.filter)}</b> · ${botText(language, "orders_page", {
    page: input.page + 1,
    count: input.total,
  })}`;
  if (!input.rows.length) return `${header}\n\n${botText(language, "orders_empty")}`;
  const lines = input.rows.map((row, index) => {
    const start = input.page * input.pageSize + index + 1;
    return `${start}. ${statusLabel(language, row.status)} · <code>${escapeHtml(row.orderNumber)}</code>\n` +
      `   ${escapeHtml(cut(row.customerName, 26))} · ${money(language, row.price)} · ${timeOnly(row.createdAt)}`;
  });
  return `${header}\n\n${lines.join("\n")}\n\n<i>${botText(language, "orders_quick_hint")}</i>`;
}

const DELIVERY_TYPE_LABEL: Record<BotLanguage, Record<string, string>> = {
  ar: { home: "توصيل للمنزل", stop_desk: "استلام من المكتب" },
  fr: { home: "À domicile", stop_desk: "Point de retrait" },
  en: { home: "Home delivery", stop_desk: "Stop-desk pickup" },
};

export function renderOrderCard(
  language: BotLanguage,
  detail: BotOrderDetail,
  targets: OrderStatus[],
): string {
  const { order } = detail;
  const lines: string[] = [];
  lines.push(
    `<b>${botText(language, "order_card", { number: escapeHtml(order.orderNumber) })}</b> — ${STATUS_EMOJI[order.status] ?? ""} <b>${statusLabel(language, order.status)}</b>`,
  );
  lines.push("");
  lines.push(`👤 ${botText(language, "order_customer")}: ${escapeHtml(order.customerName)}`);
  lines.push(`📞 ${botText(language, "order_phone")}: <code>${escapeHtml(order.phone)}</code>`);
  lines.push(
    `🗺 ${botText(language, "order_wilaya")}: ${escapeHtml(wilayaName(order, language))}${
      order.city ? ` · ${escapeHtml(order.city)}` : ""
    }`,
  );
  if (order.address) lines.push(`📍 ${botText(language, "order_address")}: ${escapeHtml(cut(order.address, 90))}`);
  if (detail.products.length) {
    lines.push("");
    lines.push(`<b>${botText(language, "order_products")}</b>`);
    for (const product of detail.products) {
      const variant = product.variant ? ` (${escapeHtml(product.variant)})` : "";
      lines.push(`• ${escapeHtml(product.name)}${variant} ×${product.quantity} — ${money(language, product.lineTotal)}`);
    }
  }
  lines.push("");
  lines.push(`💵 ${botText(language, "order_total")}: <b>${money(language, order.price + order.deliveryFee)}</b>`);
  lines.push(`💰 ${botText(language, "order_cod")}: ${money(language, order.codAmount)}`);
  lines.push(`🚚 ${DELIVERY_TYPE_LABEL[language][order.deliveryType] ?? order.deliveryType}`);
  if (detail.driverName) lines.push(`🧑‍✈️ ${botText(language, "order_driver")}: ${escapeHtml(detail.driverName)}`);
  if (detail.companyName) lines.push(`🏢 ${botText(language, "order_company")}: ${escapeHtml(detail.companyName)}`);
  if (order.trackingNumber)
    lines.push(`📦 ${botText(language, "order_tracking")}: <code>${escapeHtml(order.trackingNumber)}</code>`);
  lines.push(`🗓 ${botText(language, "order_created")}: ${timeOnly(order.createdAt)}`);
  if (detail.customer.totalOrders > 0) {
    const rate =
      detail.customer.totalOrders > 0
        ? pct((detail.customer.deliveredOrders / detail.customer.totalOrders) * 100)
        : "—";
    lines.push(
      `📈 ${botText(language, "orders")}: ${detail.customer.totalOrders} · ✅ ${detail.customer.deliveredOrders} · ↩️ ${detail.customer.returnedOrders} · ${rate}`,
    );
  }
  if (order.notes) lines.push(`📝 ${botText(language, "order_notes")}: ${escapeHtml(cut(order.notes, 120))}`);
  lines.push("");
  lines.push(
    targets.length
      ? `<b>${botText(language, "order_actions_hint")}</b>`
      : `<i>${botText(language, "order_no_actions")}</i>`,
  );
  return lines.join("\n");
}

export function renderSearchResults(language: BotLanguage, rows: BotOrderRow[]): string {
  if (!rows.length) return botText(language, "no_search_results");
  const lines = rows.map(
    (row, index) =>
      `${index + 1}. ${STATUS_EMOJI[row.status] ?? "•"} <code>${escapeHtml(row.orderNumber)}</code> · ${escapeHtml(cut(row.customerName, 24))} · ${money(language, row.price)}`,
  );
  return `<b>${botText(language, "order_search_results", { count: rows.length })}</b>\n\n${lines.join("\n")}`;
}

export interface ApprovalRowView {
  id: string;
  title: string;
  action: string;
  requestedByName: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  amount: number | null;
  payload: Record<string, unknown>;
}

export function renderApprovalsList(
  language: BotLanguage,
  rows: ApprovalRowView[],
  total: number,
  page: number,
): string {
  const header = `<b>🔐 ${botText(language, "approvals_title")}</b> · ${total}`;
  if (!rows.length) return `${header}\n\n${botText(language, "approvals_empty")}`;
  const lines = rows.map((row, index) => {
    const amount = row.amount != null ? ` — <b>${money(language, row.amount)}</b>` : "";
    return `${page * 5 + index + 1}. ${escapeHtml(row.title)}${amount}\n   ${botText(language, "approvals_requested_by")}: ${escapeHtml(row.requestedByName)} · ${timeOnly(row.createdAt)}`;
  });
  return `${header}\n\n${lines.join("\n")}`;
}

export function renderApprovalCard(language: BotLanguage, row: ApprovalRowView): string {
  const lines: string[] = [];
  lines.push(`<b>🔐 ${escapeHtml(row.title)}</b>`);
  lines.push("");
  lines.push(`${botText(language, "approvals_action")}: <code>${escapeHtml(row.action)}</code>`);
  if (row.amount != null) lines.push(`${botText(language, "approvals_amount")}: <b>${money(language, row.amount)}</b>`);
  lines.push(`${botText(language, "approvals_requested_by")}: ${escapeHtml(row.requestedByName)}`);
  lines.push(`${botText(language, "approvals_expires")}: ${timeOnly(row.expiresAt)}`);
  const orderNumber = row.payload.orderNumber;
  if (typeof orderNumber === "string") lines.push(`📦 <code>${escapeHtml(orderNumber)}</code>`);
  const targetStatus = row.payload.status;
  if (typeof targetStatus === "string") lines.push(`${botText(language, "order_status")}: ${statusLabel(language, targetStatus)}`);
  return lines.join("\n");
}

export function renderApprovalsMenu(language: BotLanguage, total: number): string {
  return [
    `<b>🔐 ${botText(language, "approvals_title")}</b>`,
    "",
    `${botText(language, "approvals_pending")}: <b>${total}</b>`,
    "",
    `<i>${botText(language, "approvals_only_admin")}</i>`,
  ].join("\n");
}

const ALERT_KIND_LABEL: Record<string, BotStringKey> = {
  orders: "alerts_orders",
  shipping: "alerts_shipping",
  stock: "alerts_stock",
  finance: "alerts_finance",
  support: "alerts_support",
  approvals: "alerts_approvals",
  reports: "alerts_reports",
};

export function renderAlertsMenu(language: BotLanguage, link: TelegramLinkRow): string {
  const enabled = (value: boolean) => (value ? "✅" : "⛔");
  const rows = [
    `orders:${link.notifyOrders}`,
    `shipping:${link.notifyShipping}`,
    `stock:${link.notifyStock}`,
    `finance:${link.notifyFinance}`,
    `support:${link.notifySupport}`,
    `approvals:${link.notifyApprovals}`,
    `reports:${link.notifyReports}`,
  ].map((item) => {
    const [kind, value] = item.split(":");
    const label = botText(language, ALERT_KIND_LABEL[kind]);
    return `${enabled(value === "true")} ${label}`;
  });
  const muted = link.mutedUntil && new Date(link.mutedUntil).getTime() > Date.now();
  return [
    `<b>🔔 ${botText(language, "alerts_title")}</b>`,
    "",
    ...rows,
    "",
    `${botText(language, "alerts_digest")}: <b>${botText(language, `digest_${link.digestMode}` as BotStringKey)}</b>`,
    muted ? `🔕 ${botText(language, "alerts_muted")}` : "",
    "",
    `<i>${botText(language, "alerts_hint")}</i>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function alertKindLabel(language: BotLanguage, kind: string): string {
  const key = ALERT_KIND_LABEL[kind];
  return key ? botText(language, key) : kind;
}

export function renderSettings(language: BotLanguage, identity: LinkedUser): string {
  return [
    `<b>⚙️ ${botText(language, "settings_title")}</b>`,
    "",
    `${botText(language, "settings_account")}: ${escapeHtml(identity.user.name)} (${escapeHtml(identity.user.email)})`,
    `${botText(language, "settings_role")}: ${roleLabel(language, identity.user.role)}`,
    `${botText(language, "settings_language")}: ${language.toUpperCase()}`,
    `🗓 ${botText(language, "order_created")}: ${timeOnly(identity.link.linkedAt)}`,
  ].join("\n");
}

export function renderHelp(language: BotLanguage): string {
  return `<b>❓ ${botText(language, "help_title")}</b>\n\n${escapeHtml(botText(language, "help_body"))}`;
}

export function renderNotLinked(language: BotLanguage): string {
  return escapeHtml(botText(language, "not_linked"));
}

// ─── Customers ───────────────────────────────────────────────────────────────

export function renderCustomerSearchResults(
  language: BotLanguage,
  rows: Array<{ id: string; name: string; phone: string; totalOrders: number }>,
): string {
  if (!rows.length) return botText(language, "customer_not_found");
  const lines = rows.map(
    (row, index) =>
      `${index + 1}. ${escapeHtml(cut(row.name, 28))} · <code>${escapeHtml(row.phone)}</code> · ${row.totalOrders} ${botText(language, "orders")}`,
  );
  return `<b>${botText(language, "search_customers")}</b>\n\n${lines.join("\n")}`;
}

export function renderCustomerCard(
  language: BotLanguage,
  detail: {
    customer: {
      name: string;
      phone: string;
      wilayaName: string | null;
      wilayaNameAr: string | null;
      address: string | null;
      totalOrders: number;
      totalSpent: number;
      createdAt: string;
    };
    stats: { delivered: number; returned: number; cancelled: number; inProgress: number };
    recentOrders: Array<{ orderNumber: string; status: string; price: number; createdAt: string }>;
  },
): string {
  const { customer, stats } = detail;
  const wilaya = (language === "ar" ? customer.wilayaNameAr : customer.wilayaName) ?? customer.wilayaName ?? "—";
  const deliveredRate = customer.totalOrders ? (stats.delivered / customer.totalOrders) * 100 : null;
  const lines = [
    `<b>👤 ${botText(language, "customer_card")}</b> — ${escapeHtml(customer.name)}`,
    "",
    `📞 <code>${escapeHtml(customer.phone)}</code>`,
    `🗺 ${escapeHtml(wilaya)}${customer.address ? ` · ${escapeHtml(cut(customer.address, 60))}` : ""}`,
    "",
    `${botText(language, "customer_orders")}: <b>${customer.totalOrders}</b> · ${botText(language, "customer_spent")}: <b>${money(language, customer.totalSpent)}</b>`,
    `✅ ${botText(language, "delivered")}: ${stats.delivered} · ↩️ ${botText(language, "returned")}: ${stats.returned} · ⛔ ${botText(language, "cancelled")}: ${stats.cancelled}`,
    `📈 ${botText(language, "customer_reliability")}: ${pct(deliveredRate)}`,
    `🗓 ${botText(language, "customer_since")}: ${timeOnly(customer.createdAt)}`,
  ];
  if (detail.recentOrders.length) {
    lines.push("", `<b>${botText(language, "customer_recent")}</b>`);
    for (const order of detail.recentOrders) {
      lines.push(
        `${STATUS_EMOJI[order.status as OrderStatus] ?? "•"} <code>${escapeHtml(order.orderNumber)}</code> · ${statusLabel(language, order.status)} · ${money(language, order.price)}`,
      );
    }
  }
  return lines.join("\n");
}
