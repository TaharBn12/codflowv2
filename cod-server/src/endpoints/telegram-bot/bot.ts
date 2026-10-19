/**
 * Telegram update dispatcher.
 *
 * Responsibilities:
 *  - verify the caller is a linked, active CodFlow user;
 *  - translate Telegram messages/callbacks into screens and actions;
 *  - enforce RBAC + approval policies before any write;
 *  - audit every action in `telegram_bot_events`.
 *
 * All rendering lives in render/keyboards; all persistence in store/queries.
 */

import type { Env, AuthUser } from "@/types";
import { getDb, type AppDb } from "@/db";
import { telegramUserLinks } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  answerCallback as apiAnswerCallback,
  editBotMessage,
  sendBotMessage,
  type InlineKeyboard,
  type TelegramFetch,
} from "./api";
import {
  decodeCallback,
  decodeLegacyApprovalCallback,
  encodeCallback,
  type BotCallback,
  type OrderFilter,
} from "./callbacks";
import { botText, isBotLanguage, roleLabel, statusLabel, type BotLanguage } from "./i18n";
import {
  claimUpdate,
  clearSession,
  findLinkByTelegramId,
  getBotConfig,
  getSession,
  linkAccount,
  loadLinkedUser,
  markLinkCodeUsed,
  peekLinkCode,
  recordBotEvent,
  revokeLink,
  setSession,
  touchLink,
  updateLink,
  type BotConfigRow,
  type LinkedUser,
} from "./store";
import { allowedStatusTargets, alertTogglePatch, can } from "./permissions";
import {
  BOT_PAGE_SIZE,
  countOrders,
  findOrderByReference,
  findOrdersByQuery,
  getOrderDetail,
  listOrders,
  orderCountsByStatus,
  type BotOrderDetail,
} from "./order-queries";
import { getCustomerDetail, searchCustomers } from "./customer-queries";
import {
  alertKindLabel,
  renderAlertsMenu,
  renderApprovalCard,
  renderApprovalsList,
  renderApprovalsMenu,
  renderCustomerCard,
  renderCustomerSearchResults,
  renderHelp,
  renderMainMenu,
  renderNotLinked,
  renderOrderCard,
  renderOrdersList,
  renderOrdersMenu,
  renderSearchResults,
  renderSettings,
} from "./render";
import {
  alertsKeyboard,
  approvalCardKeyboard,
  approvalsKeyboard,
  approvalsListKeyboard,
  backKeyboard,
  confirmUnlinkKeyboard,
  customerCardKeyboard,
  customerResultsKeyboard,
  mainMenuKeyboard,
  orderCardKeyboard,
  ordersListKeyboard,
  ordersMenuKeyboard,
  reportResultKeyboard,
  reportsKeyboard,
  searchResultsKeyboard,
  settingsKeyboard,
} from "./keyboards";
import {
  pendingApprovalCount,
  decideApproval,
  getApprovalById,
  listApprovals,
  requestOrderStatusApproval,
  requiresTelegramApproval,
  resolveTelegramConfig,
  type ApprovalRequestRecord,
  type ResolvedTelegramConfig,
} from "@/endpoints/telegram-approvals/service";
import {
  buildCustomersReport,
  buildFinanceReport,
  buildOpsReport,
  buildPeriodReport,
  buildStockReport,
  buildTeamReport,
} from "./reports";
import { updateOrderStatus } from "../../../../cod-shared/queries/orders";
import { logActivity, ACTIONS } from "@/lib/activity";
import { shouldTriggerCapiConfirmed, shouldTriggerCapiPurchase, getCapiWorkflowId } from "@/workflows/capi-helpers";

// ─── Telegram update shapes (only the fields we consume) ─────────────────────

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  date?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: { message_id: number; chat: TelegramChat };
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface BotDeps {
  env: Env;
  fetchImpl?: TelegramFetch;
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: Date;
}

export interface BotResult {
  handled: boolean;
  reason?: string;
}

interface Ctx {
  deps: BotDeps;
  env: Env;
  db: AppDb;
  config: ResolvedTelegramConfig;
  botConfig: BotConfigRow;
  now: Date;
  chatId: string;
  telegramUserId: string;
  language: BotLanguage;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function nowOf(deps: BotDeps) {
  return deps.now ?? new Date();
}

async function reply(
  ctx: Ctx,
  text: string,
  keyboard?: InlineKeyboard,
  messageId?: number,
): Promise<void> {
  if (messageId) {
    await editBotMessage(
      ctx.config,
      { chatId: ctx.chatId, messageId, text, keyboard },
      ctx.deps.fetchImpl,
    );
    return;
  }
  await sendBotMessage(
    ctx.config,
    { chatId: ctx.chatId, text, keyboard },
    ctx.deps.fetchImpl,
  );
}

async function toast(ctx: Ctx, callbackId: string, text: string, alert = false): Promise<void> {
  await apiAnswerCallback(ctx.config, callbackId, text, alert, ctx.deps.fetchImpl);
}

async function audit(
  ctx: Ctx,
  action: string,
  target?: { type: string; id: string },
  status: "ok" | "denied" | "failed" = "ok",
  detail?: string | null,
): Promise<void> {
  await recordBotEvent(
    ctx.db,
    {
      telegramUserId: ctx.telegramUserId,
      userId: null,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      status,
      detail: detail ?? null,
    },
    ctx.now,
  );
}

function asAuthUser(identity: LinkedUser): AuthUser {
  return {
    ...identity.user,
    scopes: identity.scopes,
  } as unknown as AuthUser;
}

function languageOf(link: { language: string } | null | undefined, config: BotConfigRow): BotLanguage {
  return isBotLanguage(link?.language) ? link.language : config.defaultLanguage;
}

function parseCommand(text: string): { command: string; args: string[] } | null {
  if (!text.startsWith("/")) return null;
  const parts = text.trim().split(/\s+/);
  const command = (parts[0] ?? "").slice(1).split("@")[0].toLowerCase();
  return command ? { command, args: parts.slice(1) } : null;
}

const ORDER_FILTER_SET = new Set<OrderFilter>([
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
]);

function asFilter(value: unknown): OrderFilter {
  return typeof value === "string" && ORDER_FILTER_SET.has(value as OrderFilter)
    ? (value as OrderFilter)
    : "all";
}

function approvalAmount(request: ApprovalRequestRecord): number | null {
  try {
    const payload = JSON.parse(request.payload) as { amount?: unknown };
    return typeof payload.amount === "number" ? payload.amount : null;
  } catch {
    return null;
  }
}

function approvalView(request: ApprovalRequestRecord) {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(request.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: request.id,
    title: request.title,
    action: request.action,
    requestedByName: request.requestedByName,
    status: request.status,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
    amount: approvalAmount(request),
    payload,
  };
}

// ─── Linking ─────────────────────────────────────────────────────────────────

async function redeemLinkCode(ctx: Ctx, rawCode: string): Promise<void> {
  const code = rawCode.trim().toUpperCase();
  if (!code) {
    await reply(ctx, botText(ctx.language, "settings_link_hint"));
    return;
  }
  const record = await peekLinkCode(ctx.db, code);
  if (!record || record.usedAt || record.expiresAt < ctx.now.toISOString()) {
    await reply(ctx, botText(ctx.language, "link_invalid"));
    await audit(ctx, "link.failed", { type: "link_code", id: code }, "failed", "invalid_or_expired");
    return;
  }
  const targetLink = await ctx.db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.userId, record.userId))
    .get();
  if (targetLink && !targetLink.revokedAt && targetLink.telegramUserId !== ctx.telegramUserId) {
    await reply(ctx, botText(ctx.language, "link_target_has_account"));
    return;
  }

  await markLinkCodeUsed(ctx.db, code, ctx.telegramUserId, ctx.now);
  const link = await linkAccount(
    ctx.db,
    {
      telegramUserId: ctx.telegramUserId,
      chatId: ctx.chatId,
      userId: record.userId,
      firstName: null,
      username: null,
      language: ctx.botConfig.defaultLanguage,
    },
    ctx.now,
  );
  const identity = await loadLinkedUser(ctx.db, link);
  await clearSession(ctx.db, ctx.telegramUserId);
  if (!identity) {
    await reply(ctx, botText(ctx.language, "link_invalid"));
    return;
  }
  ctx.language = languageOf(link, ctx.botConfig);
  await reply(
    ctx,
    botText(ctx.language, "link_success", {
      name: identity.user.name,
      role: roleLabel(ctx.language, identity.user.role),
    }),
    mainMenuKeyboard(ctx.language),
  );
  await recordBotEvent(
    ctx.db,
    {
      telegramUserId: ctx.telegramUserId,
      userId: identity.user.id,
      action: "link.success",
      targetType: "user",
      targetId: identity.user.id,
      status: "ok",
    },
    ctx.now,
  );
}

// ─── Screens ─────────────────────────────────────────────────────────────────

async function showMainMenu(ctx: Ctx, identity: LinkedUser, messageId?: number) {
  const counts = await orderCountsByStatus(ctx.db);
  await reply(
    ctx,
    renderMainMenu(ctx.language, identity, counts),
    mainMenuKeyboard(ctx.language),
    messageId,
  );
}

async function showOrdersMenu(ctx: Ctx, identity: LinkedUser, messageId?: number) {
  if (!can(identity, "orders.read")) {
    await reply(ctx, botText(ctx.language, "permission_denied"), backKeyboard(ctx.language, "main"), messageId);
    return;
  }
  const counts = await orderCountsByStatus(ctx.db);
  await reply(ctx, renderOrdersMenu(ctx.language, counts), ordersMenuKeyboard(ctx.language, counts), messageId);
}

async function showOrdersList(
  ctx: Ctx,
  identity: LinkedUser,
  filter: OrderFilter,
  page: number,
  messageId?: number,
) {
  if (!can(identity, "orders.read")) {
    await reply(ctx, botText(ctx.language, "permission_denied"), backKeyboard(ctx.language, "orders"), messageId);
    return;
  }
  const [rows, total] = await Promise.all([
    listOrders(ctx.db, { filter, page }),
    countOrders(ctx.db, filter),
  ]);
  await setSession(ctx.db, ctx.telegramUserId, "idle", { filter, page }, ctx.now);
  await reply(
    ctx,
    renderOrdersList(ctx.language, { filter, page, total, rows, pageSize: BOT_PAGE_SIZE }),
    ordersListKeyboard(ctx.language, { rows, filter, page, total, pageSize: BOT_PAGE_SIZE }),
    messageId,
  );
}

async function showOrderCard(
  ctx: Ctx,
  identity: LinkedUser,
  detail: BotOrderDetail,
  messageId?: number,
) {
  const session = await getSession(ctx.db, ctx.telegramUserId);
  const filter = asFilter(session.payload.filter);
  const page = Number.isFinite(session.payload.page) ? Number(session.payload.page) : 0;
  const targets = allowedStatusTargets(identity, detail.order.status);
  await reply(
    ctx,
    renderOrderCard(ctx.language, detail, targets),
    orderCardKeyboard(ctx.language, {
      orderId: detail.order.id,
      status: detail.order.status,
      phone: detail.order.phone,
      targets,
      filter,
      page,
    }),
    messageId,
  );
}

async function showApprovalsMenu(ctx: Ctx, identity: LinkedUser, messageId?: number) {
  if (!can(identity, "approvals.view")) {
    await reply(ctx, botText(ctx.language, "approvals_only_admin"), backKeyboard(ctx.language, "main"), messageId);
    return;
  }
  const total = await pendingApprovalCount(ctx.db, ctx.now);
  await reply(ctx, renderApprovalsMenu(ctx.language, total), approvalsKeyboard(ctx.language, total), messageId);
}

async function showApprovalsList(ctx: Ctx, identity: LinkedUser, page: number, messageId?: number) {
  if (!can(identity, "approvals.view")) {
    await reply(ctx, botText(ctx.language, "approvals_only_admin"), backKeyboard(ctx.language, "main"), messageId);
    return;
  }
  const { rows, total } = await listApprovals(ctx.db, { status: "pending", limit: 5, offset: page * 5 });
  const views = rows.map(approvalView);
  await reply(
    ctx,
    renderApprovalsList(ctx.language, views, total, page),
    approvalsListKeyboard(ctx.language, { rows: views, page, total }),
    messageId,
  );
}

async function showApprovalCard(
  ctx: Ctx,
  identity: LinkedUser,
  id: string,
  messageId?: number,
) {
  if (!can(identity, "approvals.view")) {
    await reply(ctx, botText(ctx.language, "approvals_only_admin"), backKeyboard(ctx.language, "main"), messageId);
    return;
  }
  const request = await getApprovalById(ctx.db, id);
  if (!request) {
    await reply(ctx, botText(ctx.language, "approvals_already"), backKeyboard(ctx.language, "approvals"), messageId);
    return;
  }
  if (request.status !== "pending") {
    await reply(
      ctx,
      `${renderApprovalCard(ctx.language, approvalView(request))}\n\n${botText(ctx.language, "approvals_already")}`,
      backKeyboard(ctx.language, "approvals"),
      messageId,
    );
    return;
  }
  await reply(
    ctx,
    renderApprovalCard(ctx.language, approvalView(request)),
    approvalCardKeyboard(ctx.language, id),
    messageId,
  );
}

async function showAlerts(ctx: Ctx, identity: LinkedUser, messageId?: number) {
  await reply(
    ctx,
    renderAlertsMenu(ctx.language, identity.link),
    alertsKeyboard(ctx.language, identity.link),
    messageId,
  );
}

async function showSettings(ctx: Ctx, identity: LinkedUser, messageId?: number) {
  await reply(ctx, renderSettings(ctx.language, identity), settingsKeyboard(ctx.language), messageId);
}

async function showHelp(ctx: Ctx, messageId?: number) {
  await reply(ctx, renderHelp(ctx.language), backKeyboard(ctx.language, "main"), messageId);
}

async function showReportsMenu(ctx: Ctx, identity: LinkedUser, messageId?: number) {
  if (!can(identity, "reports.view")) {
    await reply(ctx, botText(ctx.language, "permission_denied"), backKeyboard(ctx.language, "main"), messageId);
    return;
  }
  await reply(
    ctx,
    `<b>${botText(ctx.language, "reports_title")}</b>\n\n${botText(ctx.language, "reports_today")} · ${botText(ctx.language, "reports_week")} · ${botText(ctx.language, "reports_ops")}`,
    reportsKeyboard(ctx.language),
    messageId,
  );
}

// ─── Reports ─────────────────────────────────────────────────────────────────

async function showReport(
  ctx: Ctx,
  identity: LinkedUser,
  period: Extract<BotCallback, { type: "report" }>["period"],
  messageId?: number,
) {
  if (!can(identity, "reports.view")) {
    await reply(ctx, botText(ctx.language, "permission_denied"), backKeyboard(ctx.language, "reports"), messageId);
    return;
  }
  let text: string;
  switch (period) {
    case "today":
    case "yesterday":
    case "week":
    case "month":
      text = await buildPeriodReport(ctx.db, period, ctx.language, ctx.now);
      break;
    case "ops":
      text = await buildOpsReport(ctx.db, ctx.language, ctx.now);
      break;
    case "stock":
      if (!can(identity, "stock.view")) {
        await reply(ctx, botText(ctx.language, "permission_denied"), backKeyboard(ctx.language, "reports"), messageId);
        return;
      }
      text = await buildStockReport(ctx.db, ctx.language);
      break;
    case "finance":
      if (!can(identity, "reports.finance")) {
        await reply(ctx, botText(ctx.language, "permission_denied"), backKeyboard(ctx.language, "reports"), messageId);
        return;
      }
      text = await buildFinanceReport(ctx.db, ctx.language, ctx.now);
      break;
    case "team":
      if (!can(identity, "reports.team")) {
        await reply(ctx, botText(ctx.language, "permission_denied"), backKeyboard(ctx.language, "reports"), messageId);
        return;
      }
      text = await buildTeamReport(ctx.db, ctx.language, ctx.now);
      break;
    case "customers":
      if (!can(identity, "customers.view")) {
        await reply(ctx, botText(ctx.language, "permission_denied"), backKeyboard(ctx.language, "reports"), messageId);
        return;
      }
      text = await buildCustomersReport(ctx.db, ctx.language, ctx.now);
      break;
    default:
      text = botText(ctx.language, "no_data");
  }
  await reply(ctx, text, reportResultKeyboard(ctx.language), messageId);
  await audit(ctx, `report.${period}`);
}

// ─── Order actions ───────────────────────────────────────────────────────────

async function applyStatus(
  ctx: Ctx,
  identity: LinkedUser,
  orderId: string,
  target: BotOrderDetail["order"]["status"],
  callbackId: string,
  messageId?: number,
) {
  const detail = await getOrderDetail(ctx.db, orderId);
  if (!detail) {
    await toast(ctx, callbackId, botText(ctx.language, "order_not_found"), true);
    return;
  }
  const targets = allowedStatusTargets(identity, detail.order.status);
  if (!targets.includes(target)) {
    await audit(ctx, "order.status_denied", { type: "order", id: orderId }, "denied", target);
    await toast(ctx, callbackId, botText(ctx.language, "permission_denied"), true);
    return;
  }

  const needsApproval = await requiresTelegramApproval(ctx.db, identity.user.id, "orders.status_change");
  if (needsApproval) {
    await requestOrderStatusApproval(ctx.env, {
      requestedBy: identity.user.id,
      requestedByName: identity.user.name,
      orderId,
      orderNumber: detail.order.orderNumber,
      fromStatus: detail.order.status,
      targetStatus: target,
    });
    await toast(ctx, callbackId, botText(ctx.language, "order_needs_approval"), true);
    await audit(ctx, "order.status_approval_requested", { type: "order", id: orderId }, "ok", target);
    const refreshed = await getOrderDetail(ctx.db, orderId);
    if (refreshed) await showOrderCard(ctx, identity, refreshed, messageId);
    return;
  }

  try {
    await updateOrderStatus(ctx.db, orderId, target, identity.user.id, identity.user.name);
    await logActivity(ctx.db, asAuthUser(identity), ACTIONS.ORDER_STATUS_CHANGED, {
      type: "order",
      id: orderId,
      label: detail.order.orderNumber,
    }, { from: detail.order.status, to: target, source: "telegram" });

    const isDelivered = shouldTriggerCapiPurchase(target, detail.order.wilayaId);
    const isConfirmed = shouldTriggerCapiConfirmed(target);
    if ((isDelivered || isConfirmed) && ctx.env.CAPI_WORKFLOW) {
      const stage = isConfirmed ? "confirmed" : "delivered";
      const workflowId = getCapiWorkflowId(orderId, stage, "Purchase");
      const promise = ctx.env.CAPI_WORKFLOW.create({
        id: workflowId,
        params: {
          orderId,
          eventName: "Purchase",
          stage,
          triggeredAt: Math.floor(ctx.now.getTime() / 1000),
          triggerStatus: target,
        },
      }).catch((error: Error) => console.error("[telegram-bot] capi trigger failed", error));
      ctx.deps.waitUntil?.(promise);
    }

    await toast(ctx, callbackId, botText(ctx.language, "order_updated", { status: statusLabel(ctx.language, target) }));
    await audit(ctx, "order.status_changed", { type: "order", id: orderId }, "ok", target);
    const refreshed = await getOrderDetail(ctx.db, orderId);
    if (refreshed) await showOrderCard(ctx, identity, refreshed, messageId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await toast(ctx, callbackId, botText(ctx.language, "order_update_failed", { reason: reason.slice(0, 120) }), true);
    await audit(ctx, "order.status_failed", { type: "order", id: orderId }, "failed", reason.slice(0, 200));
  }
}

async function handleSearchOrders(ctx: Ctx, identity: LinkedUser, query: string, messageId?: number) {
  if (!can(identity, "orders.read")) {
    await reply(ctx, botText(ctx.language, "permission_denied"));
    return;
  }
  const rows = await findOrdersByQuery(ctx.db, query);
  await reply(
    ctx,
    renderSearchResults(ctx.language, rows),
    searchResultsKeyboard(ctx.language, rows),
    messageId,
  );
}

async function handleSearchCustomers(ctx: Ctx, identity: LinkedUser, query: string, messageId?: number) {
  if (!can(identity, "customers.view")) {
    await reply(ctx, botText(ctx.language, "permission_denied"));
    return;
  }
  const rows = await searchCustomers(ctx.db, query);
  await reply(
    ctx,
    renderCustomerSearchResults(ctx.language, rows),
    customerResultsKeyboard(ctx.language, rows),
    messageId,
  );
}

// ─── Callbacks ───────────────────────────────────────────────────────────────

async function handleCallback(
  ctx: Ctx,
  identity: LinkedUser,
  callback: TelegramCallbackQuery,
): Promise<void> {
  const data = callback.data ?? "";
  const messageId = callback.message?.message_id;

  const legacy = decodeLegacyApprovalCallback(data);
  if (legacy) {
    await decideFromBot(ctx, identity, callback.id, legacy.id, legacy.decision, messageId);
    return;
  }

  const decoded = decodeCallback(data);
  if (!decoded) {
    await toast(ctx, callback.id, botText(ctx.language, "unknown_command"));
    return;
  }

  switch (decoded.type) {
    case "noop":
      await toast(ctx, callback.id, "");
      return;
    case "menu": {
      switch (decoded.view) {
        case "main":
          await showMainMenu(ctx, identity, messageId);
          break;
        case "orders":
          await showOrdersMenu(ctx, identity, messageId);
          break;
        case "reports":
          await showReportsMenu(ctx, identity, messageId);
          break;
        case "approvals":
          await showApprovalsMenu(ctx, identity, messageId);
          break;
        case "alerts":
          await showAlerts(ctx, identity, messageId);
          break;
        case "settings":
          await showSettings(ctx, identity, messageId);
          break;
        case "help":
          await showHelp(ctx, messageId);
          break;
      }
      await toast(ctx, callback.id, "");
      return;
    }
    case "orders_list":
      await showOrdersList(ctx, identity, decoded.filter, decoded.page, messageId);
      await toast(ctx, callback.id, "");
      return;
    case "order_view": {
      const detail = await getOrderDetail(ctx.db, decoded.orderId);
      if (!detail) {
        await toast(ctx, callback.id, botText(ctx.language, "order_not_found"), true);
        return;
      }
      await showOrderCard(ctx, identity, detail, messageId);
      await toast(ctx, callback.id, "");
      return;
    }
    case "order_status":
      await applyStatus(ctx, identity, decoded.orderId, decoded.status, callback.id, messageId);
      return;
    case "show_phone": {
      const detail = await getOrderDetail(ctx.db, decoded.orderId);
      await toast(ctx, callback.id, detail ? `📞 ${detail.order.phone}` : botText(ctx.language, "order_not_found"), true);
      return;
    }
    case "search": {
      if (decoded.target === "customers") {
        if (!can(identity, "customers.view")) {
          await toast(ctx, callback.id, botText(ctx.language, "permission_denied"), true);
          return;
        }
        await setSession(ctx.db, ctx.telegramUserId, "awaiting_customer_search", {}, ctx.now);
        await reply(ctx, botText(ctx.language, "customer_search_prompt"), backKeyboard(ctx.language, "main"), messageId);
      } else {
        if (!can(identity, "orders.read")) {
          await toast(ctx, callback.id, botText(ctx.language, "permission_denied"), true);
          return;
        }
        await setSession(ctx.db, ctx.telegramUserId, "awaiting_order_search", {}, ctx.now);
        await reply(ctx, botText(ctx.language, "order_search_prompt"), backKeyboard(ctx.language, "orders"), messageId);
      }
      await toast(ctx, callback.id, "");
      return;
    }
    case "customer_view": {
      if (!can(identity, "customers.view")) {
        await toast(ctx, callback.id, botText(ctx.language, "permission_denied"), true);
        return;
      }
      const detail = await getCustomerDetail(ctx.db, decoded.id);
      if (!detail) {
        await toast(ctx, callback.id, botText(ctx.language, "customer_not_found"), true);
        return;
      }
      await reply(
        ctx,
        renderCustomerCard(ctx.language, detail),
        customerCardKeyboard(ctx.language, detail.recentOrders),
        messageId,
      );
      await toast(ctx, callback.id, "");
      return;
    }
    case "report":
      await showReport(ctx, identity, decoded.period, messageId);
      await toast(ctx, callback.id, "");
      return;
    case "approvals_list":
      await showApprovalsList(ctx, identity, decoded.page, messageId);
      await toast(ctx, callback.id, "");
      return;
    case "approval_view":
      await showApprovalCard(ctx, identity, decoded.id, messageId);
      await toast(ctx, callback.id, "");
      return;
    case "approval_decision": {
      if (!can(identity, "approvals.decide")) {
        await audit(ctx, "approval.decision_denied", { type: "approval", id: decoded.id }, "denied");
        await toast(ctx, callback.id, botText(ctx.language, "approvals_only_admin"), true);
        return;
      }
      if (decoded.decision === "reject_with_reason") {
        await setSession(
          ctx.db,
          ctx.telegramUserId,
          "awaiting_rejection_reason",
          { approvalId: decoded.id },
          ctx.now,
        );
        await reply(ctx, botText(ctx.language, "approvals_reason_prompt"), backKeyboard(ctx.language, "approvals"), messageId);
        await toast(ctx, callback.id, "");
        return;
      }
      await decideFromBot(
        ctx,
        identity,
        callback.id,
        decoded.id,
        decoded.decision === "approve" ? "approve" : "reject",
        messageId,
      );
      return;
    }
    case "alert_toggle": {
      const patch = alertTogglePatch(decoded.kind, identity.link);
      if (!patch) {
        await toast(ctx, callback.id, botText(ctx.language, "error_generic"));
        return;
      }
      const updated = await updateLink(ctx.db, ctx.telegramUserId, patch);
      if (updated) identity.link = updated;
      await showAlerts(ctx, identity, messageId);
      await toast(ctx, callback.id, botText(ctx.language, "alerts_saved"));
      await audit(ctx, "alerts.toggle", { type: "alert", id: decoded.kind });
      return;
    }
    case "alert_digest": {
      const updated = await updateLink(ctx.db, ctx.telegramUserId, { digestMode: decoded.mode });
      if (updated) identity.link = updated;
      await showAlerts(ctx, identity, messageId);
      await toast(ctx, callback.id, botText(ctx.language, "alerts_saved"));
      return;
    }
    case "alert_mute": {
      const mutedUntil = new Date(ctx.now.getTime() + decoded.minutes * 60_000).toISOString();
      const updated = await updateLink(ctx.db, ctx.telegramUserId, { mutedUntil });
      if (updated) identity.link = updated;
      await showAlerts(ctx, identity, messageId);
      await toast(ctx, callback.id, botText(ctx.language, "alerts_muted"));
      return;
    }
    case "alert_unmute": {
      const updated = await updateLink(ctx.db, ctx.telegramUserId, { mutedUntil: null });
      if (updated) identity.link = updated;
      await showAlerts(ctx, identity, messageId);
      await toast(ctx, callback.id, botText(ctx.language, "alerts_unmuted"));
      return;
    }
    case "language": {
      const updated = await updateLink(ctx.db, ctx.telegramUserId, { language: decoded.language });
      if (updated) identity.link = updated;
      ctx.language = decoded.language;
      await showSettings(ctx, identity, messageId);
      await toast(ctx, callback.id, botText(ctx.language, "alerts_saved"));
      return;
    }
    case "unlink": {
      if (!decoded.confirm) {
        await reply(
          ctx,
          `⚠️ ${botText(ctx.language, "settings_unlink_confirm")}`,
          confirmUnlinkKeyboard(ctx.language),
          messageId,
        );
        await toast(ctx, callback.id, botText(ctx.language, "settings_unlink_confirm"));
        return;
      }
      await revokeLink(ctx.db, ctx.telegramUserId, ctx.now);
      await clearSession(ctx.db, ctx.telegramUserId);
      await reply(ctx, botText(ctx.language, "settings_unlinked"));
      await toast(ctx, callback.id, botText(ctx.language, "settings_unlinked"), true);
      await audit(ctx, "unlink.success");
      return;
    }
    default:
      await toast(ctx, callback.id, botText(ctx.language, "unknown_command"));
  }
}

async function decideFromBot(
  ctx: Ctx,
  identity: LinkedUser,
  callbackId: string | null,
  id: string,
  decision: "approve" | "reject",
  messageId?: number,
  note?: string | null,
) {
  if (!can(identity, "approvals.decide")) {
    await audit(ctx, "approval.decision_denied", { type: "approval", id }, "denied");
    if (callbackId) await toast(ctx, callbackId, botText(ctx.language, "approvals_only_admin"), true);
    else await reply(ctx, botText(ctx.language, "approvals_only_admin"));
    return;
  }
  const result = await decideApproval(ctx.env, id, decision, ctx.telegramUserId, {
    actorUserId: identity.user.id,
    note: note ?? null,
    waitUntil: ctx.deps.waitUntil,
  });
  if (callbackId) await toast(ctx, callbackId, result.text, true);
  await audit(
    ctx,
    decision === "approve" ? "approval.approved" : "approval.rejected",
    { type: "approval", id },
    result.ok ? "ok" : "failed",
    note ?? null,
  );
  const request = await getApprovalById(ctx.db, id);
  if (request && messageId) {
    await reply(
      ctx,
      `${renderApprovalCard(ctx.language, approvalView(request))}\n\n${decision === "approve" ? botText(ctx.language, "approvals_approved") : botText(ctx.language, "approvals_rejected")}`,
      backKeyboard(ctx.language, "approvals"),
      messageId,
    );
  }
}

// ─── Messages / commands ─────────────────────────────────────────────────────

async function handleMessage(
  ctx: Ctx,
  identity: LinkedUser,
  message: TelegramMessage,
): Promise<void> {
  const text = (message.text ?? "").trim();
  const session = await getSession(ctx.db, ctx.telegramUserId);

  if (session.state === "awaiting_order_search") {
    await clearSession(ctx.db, ctx.telegramUserId);
    await handleSearchOrders(ctx, identity, text);
    return;
  }
  if (session.state === "awaiting_customer_search") {
    await clearSession(ctx.db, ctx.telegramUserId);
    await handleSearchCustomers(ctx, identity, text);
    return;
  }
  if (session.state === "awaiting_rejection_reason") {
    await clearSession(ctx.db, ctx.telegramUserId);
    const approvalId = session.payload.approvalId;
    if (approvalId) {
      await decideFromBot(ctx, identity, null, approvalId, "reject", undefined, text);
      await reply(ctx, botText(ctx.language, "approvals_reason_saved"));
    }
    return;
  }

  const parsed = parseCommand(text);
  if (parsed) {
    const { command, args } = parsed;
    switch (command) {
      case "start":
        if (args[0]) {
          await redeemLinkCode(ctx, args[0]);
          return;
        }
        await showMainMenu(ctx, identity);
        return;
      case "menu":
        await showMainMenu(ctx, identity);
        return;
      case "orders":
        await showOrdersMenu(ctx, identity);
        return;
      case "order": {
        if (!args[0]) {
          await setSession(ctx.db, ctx.telegramUserId, "awaiting_order_search", {}, ctx.now);
          await reply(ctx, botText(ctx.language, "order_search_prompt"));
          return;
        }
        const detail = await findOrderByReference(ctx.db, args.join(" "));
        if (!detail) {
          await reply(ctx, botText(ctx.language, "order_not_found"));
          return;
        }
        await showOrderCard(ctx, identity, detail);
        return;
      }
      case "report": {
        const period = (args[0] ?? "today").toLowerCase();
        const allowed = ["today", "yesterday", "week", "month", "ops", "team", "stock", "finance", "customers"] as const;
        if (!allowed.includes(period as (typeof allowed)[number])) {
          await showReportsMenu(ctx, identity);
          return;
        }
        await showReport(ctx, identity, period as (typeof allowed)[number]);
        return;
      }
      case "pending":
      case "approvals":
        await showApprovalsList(ctx, identity, 0);
        return;
      case "stock":
        await showReport(ctx, identity, "stock");
        return;
      case "finance":
        await showReport(ctx, identity, "finance");
        return;
      case "team":
        await showReport(ctx, identity, "team");
        return;
      case "customer": {
        if (!args[0]) {
          await setSession(ctx.db, ctx.telegramUserId, "awaiting_customer_search", {}, ctx.now);
          await reply(ctx, botText(ctx.language, "customer_search_prompt"));
          return;
        }
        await handleSearchCustomers(ctx, identity, args.join(" "));
        return;
      }
      case "mute": {
        const arg = (args[0] ?? "2h").toLowerCase();
        if (arg === "off") {
          const updated = await updateLink(ctx.db, ctx.telegramUserId, { mutedUntil: null });
          if (updated) identity.link = updated;
          await reply(ctx, botText(ctx.language, "alerts_unmuted"));
          return;
        }
        const minutes = arg.endsWith("h") ? Number.parseInt(arg, 10) * 60 : Number.parseInt(arg, 10) || 120;
        const mutedUntil = new Date(ctx.now.getTime() + Math.max(15, Math.min(minutes, 24 * 60)) * 60_000).toISOString();
        const updated = await updateLink(ctx.db, ctx.telegramUserId, { mutedUntil });
        if (updated) identity.link = updated;
        await reply(ctx, botText(ctx.language, "alerts_muted"));
        return;
      }
      case "link":
        if (args[0]) await redeemLinkCode(ctx, args[0]);
        else await reply(ctx, botText(ctx.language, "settings_link_hint"));
        return;
      case "unlink": {
        await revokeLink(ctx.db, ctx.telegramUserId, ctx.now);
        await clearSession(ctx.db, ctx.telegramUserId);
        await reply(ctx, botText(ctx.language, "settings_unlinked"));
        await audit(ctx, "unlink.success");
        return;
      }
      case "settings":
        await showSettings(ctx, identity);
        return;
      case "language": {
        const value = (args[0] ?? "").toLowerCase();
        if (isBotLanguage(value)) {
          const updated = await updateLink(ctx.db, ctx.telegramUserId, { language: value });
          if (updated) identity.link = updated;
          ctx.language = value;
        }
        await showSettings(ctx, identity);
        return;
      }
      case "help":
        await showHelp(ctx);
        return;
      case "id":
        await reply(ctx, `<code>${ctx.telegramUserId}</code>`);
        return;
      default:
        await reply(ctx, botText(ctx.language, "unknown_command"), mainMenuKeyboard(ctx.language));
        return;
    }
  }

  // Free text: phone / order number / customer name search.
  if (text.length >= 3) {
    if (!can(identity, "orders.read")) {
      await reply(ctx, botText(ctx.language, "permission_denied"));
      return;
    }
    await handleSearchOrders(ctx, identity, text);
    return;
  }
  await showMainMenu(ctx, identity);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function handleTelegramUpdate(deps: BotDeps, update: TelegramUpdate): Promise<BotResult> {
  const config = await resolveTelegramConfig(deps.env);
  if (!config) return { handled: false, reason: "not_configured" };

  const db = getDb(deps.env.DB);
  const botConfig = await getBotConfig(db);
  const now = nowOf(deps);

  const message = update.message ?? update.edited_message;
  const callback = update.callback_query;
  const telegramUser = callback?.from ?? message?.from;
  const chatId = String(callback?.message?.chat.id ?? message?.chat.id ?? "");
  if (!telegramUser || !chatId) return { handled: false, reason: "no_user" };

  const telegramUserId = String(telegramUser.id);
  if (!(await claimUpdate(db, update.update_id, telegramUserId, callback ? "callback" : "message", now))) {
    return { handled: false, reason: "duplicate" };
  }

  const link = await findLinkByTelegramId(db, telegramUserId);
  const language = languageOf(link, botConfig);

  const ctx: Ctx = {
    deps,
    env: deps.env,
    db,
    config,
    botConfig,
    now,
    chatId,
    telegramUserId,
    language,
  };

  if (!botConfig.enabled) {
    if (message) await reply(ctx, botText(language, "bot_disabled"));
    if (callback) await toast(ctx, callback.id, botText(language, "bot_disabled"), true);
    return { handled: false, reason: "disabled" };
  }

  // Unlinked users can only bind an account.
  if (!link) {
    if (callback) {
      await toast(ctx, callback.id, botText(language, "not_linked_short"), true);
      return { handled: true, reason: "not_linked" };
    }
    const parsed = parseCommand((message?.text ?? "").trim());
    if (parsed && (parsed.command === "start" || parsed.command === "link") && parsed.args[0]) {
      await redeemLinkCode(ctx, parsed.args[0]);
      return { handled: true, reason: "linking" };
    }
    if (parsed?.command === "help" || parsed?.command === "link" || parsed?.command === "start") {
      await reply(ctx, renderNotLinked(language));
      return { handled: true, reason: "not_linked" };
    }
    await reply(ctx, renderNotLinked(language));
    return { handled: true, reason: "not_linked" };
  }

  const identity = await loadLinkedUser(db, link);
  if (!identity) {
    if (message) await reply(ctx, botText(language, "bot_disabled"));
    if (callback) await toast(ctx, callback.id, botText(language, "bot_disabled"), true);
    return { handled: false, reason: "inactive_user" };
  }

  ctx.language = languageOf(link, botConfig);
  await touchLink(db, telegramUserId, now);

  try {
    if (callback) {
      await handleCallback(ctx, identity, callback);
    } else if (message) {
      await handleMessage(ctx, identity, message);
    }
  } catch (error) {
    console.error("[telegram-bot] update failed", error);
    const text = botText(ctx.language, "error_generic");
    try {
      if (callback) await toast(ctx, callback.id, text, true);
      else await reply(ctx, text);
    } catch {
      /* the bot is unreachable — nothing else to do */
    }
    await recordBotEvent(
      db,
      {
        telegramUserId,
        userId: identity.user.id,
        action: "update.failed",
        status: "failed",
        detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      },
      now,
    );
    return { handled: false, reason: "error" };
  }

  return { handled: true };
}

