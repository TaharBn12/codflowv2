/**
 * Bot authorization.
 *
 * The bot never trusts a Telegram user id on its own: every action is checked
 * against the linked CodFlow user's role and scopes, exactly like the HTTP API.
 * Rules are deliberately explicit (rather than a generic scope check) because
 * Telegram is a high-risk surface: an accidental tap must never dispatch cash.
 */

import { hasPermission } from "../../../../cod-shared/rbac/utils";
import { SCOPES } from "../../../../cod-shared/rbac/scopes";
import type { LinkedUser } from "./store";
import { CONFIRMATION_STATUSES, allowedNextStatuses, type OrderStatus } from "../orders/transitions";

export type BotPermission =
  | "orders.read"
  | "orders.update"
  | "orders.cancel"
  | "reports.view"
  | "reports.finance"
  | "reports.team"
  | "customers.view"
  | "stock.view"
  | "approvals.view"
  | "approvals.decide"
  | "settings.view";

function scope(user: LinkedUser, scope: string): boolean {
  return user.user.role === "admin" || hasPermission(user.scopes, scope);
}

export function can(user: LinkedUser | null, permission: BotPermission): boolean {
  if (!user) return false;
  const role = user.user.role;
  switch (permission) {
    case "orders.read":
      return scope(user, SCOPES.ORDERS_READ) || role === "confirmer";
    case "orders.update":
      return scope(user, SCOPES.ORDERS_UPDATE) || role === "confirmer";
    case "orders.cancel":
      return role === "admin" || scope(user, SCOPES.ORDERS_DELETE);
    case "reports.view":
      return role === "admin" || scope(user, SCOPES.DASHBOARD_VIEW) || scope(user, SCOPES.ANALYTICS_FINANCE);
    case "reports.finance":
      return role === "admin" || scope(user, SCOPES.ANALYTICS_FINANCE);
    case "reports.team":
      return role === "admin" || scope(user, SCOPES.OPERATIONS_VIEW);
    case "customers.view":
      return role === "admin" || scope(user, SCOPES.CUSTOMERS_READ);
    case "stock.view":
      return role === "admin" || scope(user, SCOPES.STOCK_READ);
    case "approvals.view":
    case "approvals.decide":
      return role === "admin";
    case "settings.view":
      return true;
    default:
      return false;
  }
}

/**
 * Statuses this identity may apply to this order, from the bot.
 * A confirmer only touches the confirmation funnel; anyone else needs the
 * update scope, and destructive statuses additionally need delete rights.
 */
export function allowedStatusTargets(
  identity: LinkedUser | null,
  currentStatus: string,
): OrderStatus[] {
  if (!identity) return [];
  if (!can(identity, "orders.update")) return [];
  const targets = [...allowedNextStatuses(currentStatus)];
  if (identity.user.role === "confirmer") {
    return targets.filter((status) => {
      // Confirmation agents may cancel only before the order enters fulfilment
      // (a ready/preparing order is the warehouse's decision, not theirs).
      if (status === "cancelled") return currentStatus === "new" || currentStatus === "unreachable";
      return CONFIRMATION_STATUSES.includes(status);
    });
  }
  return targets.filter((status) => {
    if ((status === "cancelled" || status === "returned") && !can(identity, "orders.cancel")) return false;
    return true;
  });
}

/** Roles that may see prices/costs in a report. */
export function canSeeMoney(identity: LinkedUser | null): boolean {
  return can(identity, "reports.finance");
}

/** A linked user with no role at all should still be able to read the menu. */
export function displayName(identity: LinkedUser): string {
  return identity.user.name || identity.user.email;
}

/**
 * Flips one notification category for the “Alerts” screen.
 * Returns null for unknown categories so the caller can show an error.
 */
export function alertTogglePatch(
  kind: string,
  link: {
    notifyOrders: boolean;
    notifyShipping: boolean;
    notifyStock: boolean;
    notifyFinance: boolean;
    notifySupport: boolean;
    notifyApprovals: boolean;
    notifyReports: boolean;
  },
) {
  switch (kind) {
    case "orders":
      return { notifyOrders: !link.notifyOrders };
    case "shipping":
      return { notifyShipping: !link.notifyShipping };
    case "stock":
      return { notifyStock: !link.notifyStock };
    case "finance":
      return { notifyFinance: !link.notifyFinance };
    case "support":
      return { notifySupport: !link.notifySupport };
    case "approvals":
      return { notifyApprovals: !link.notifyApprovals };
    case "reports":
      return { notifyReports: !link.notifyReports };
    default:
      return null;
  }
}
