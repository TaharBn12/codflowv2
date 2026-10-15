/**
 * Activity Log System
 *
 * Centralized helper for writing audit log entries.
 * Only admins can read activity logs via the API.
 *
 * logActivity() silently swallows errors so that audit failures
 * never break the primary business operation.
 */

import { activityLogs } from "@/db/schema";
import type { AppDb } from "@/db";
import type { AuthUser } from "@/types";

// ─── Action Constants ─────────────────────────────────────────────────────────

export const ACTIONS = {
  // Orders
  ORDER_CREATED:           "order.created",
  ORDER_STATUS_CHANGED:    "order.status_changed",
  ORDER_DRIVER_ASSIGNED:   "order.driver_assigned",
  ORDER_DISPATCHED:        "order.dispatched",
  ORDER_PRODUCT_RETURNED:  "order.product_returned",
  ORDER_DELETED:           "order.deleted",
  /** Carrier tracking poll applied (manual per-order, or the cron sweep). */
  ORDER_CARRIER_SYNCED:    "order.carrier_synced",
  /** Bulk carrier tracking poll from the orders list. */
  ORDER_CARRIER_SYNC_BULK: "order.carrier_sync_bulk",
  ORDER_CONTACT_ATTEMPT:   "order.contact_attempt",
  ORDER_NOTE_ADDED:        "order.note_added",
  ORDER_CONFIRMER_ASSIGNED: "order.confirmer_assigned",

  // Customers
  CUSTOMER_CREATED:        "customer.created",
  CUSTOMER_UPDATED:        "customer.updated",
  CUSTOMER_DELETED:        "customer.deleted",

  // Customer Groups
  CUSTOMER_GROUP_CREATED:        "customer_group.created",
  CUSTOMER_GROUP_UPDATED:        "customer_group.updated",
  CUSTOMER_GROUP_DELETED:        "customer_group.deleted",
  CUSTOMER_GROUP_MEMBER_ADDED:   "customer_group.member_added",
  CUSTOMER_GROUP_MEMBER_REMOVED: "customer_group.member_removed",

  // Customer Tags
  CUSTOMER_TAG_CREATED:          "customer_tag.created",
  CUSTOMER_TAG_UPDATED:          "customer_tag.updated",
  CUSTOMER_TAG_DELETED:          "customer_tag.deleted",
  CUSTOMER_TAG_ASSIGNED:         "customer_tag.assigned",
  CUSTOMER_TAG_UNASSIGNED:       "customer_tag.unassigned",

  // Drivers
  DRIVER_CREATED:          "driver.created",
  DRIVER_UPDATED:          "driver.updated",
  DRIVER_STATUS_CHANGED:   "driver.status_changed",
  DRIVER_DELETED:          "driver.deleted",

  // Products
  PRODUCT_CREATED:         "product.created",
  PRODUCT_UPDATED:         "product.updated",
  PRODUCT_STATUS_CHANGED:  "product.status_changed",
  PRODUCT_DELETED:         "product.deleted",

  // Landing Pages
  LANDING_PAGE_CREATED:    "landing_page.created",
  LANDING_PAGE_UPDATED:    "landing_page.updated",
  LANDING_PAGE_PUBLISHED:  "landing_page.published",
  LANDING_PAGE_UNPUBLISHED: "landing_page.unpublished",
  LANDING_PAGE_ARCHIVED:   "landing_page.archived",
  LANDING_PAGE_DELETED:    "landing_page.deleted",

  // Stock
  STOCK_ADJUSTED:          "stock.adjusted",

  // Dashboard finance (expenses / ad spend) and the automatic daily report
  EXPENSE_CREATED:         "expense.created",
  EXPENSE_UPDATED:         "expense.updated",
  EXPENSE_DELETED:         "expense.deleted",
  DAILY_REPORT_SETTINGS_CHANGED: "daily_report.settings_changed",
  DAILY_REPORT_SENT:       "daily_report.sent",

  // Reviews
  REVIEW_APPROVED:         "review.approved",
  REVIEW_REJECTED:         "review.rejected",
  REVIEW_DELETED:          "review.deleted",

  // Users / Team
  USER_CREATED:            "user.created",
  USER_UPDATED:            "user.updated",
  USER_ROLE_CHANGED:       "user.role_changed",
  USER_SCOPE_GRANTED:      "user.scope_granted",
  USER_SCOPE_REVOKED:      "user.scope_revoked",

  // Operations settings and assignment administration
  OPERATIONS_SETTINGS_CHANGED: "operations.settings_changed",
  OPERATIONS_ASSIGNMENT_CHANGED: "operations.assignment_changed",

  // MCP — one row per remote MCP tool call (success or failure),
  // plus one row for user-declined HITL elicitations. Lets ops audit
  // exactly what each AI agent did, and when it was told "no".
  MCP_TOOL_CALLED:         "mcp.tool_called",
  MCP_TOOL_DECLINED:       "mcp.tool_declined",
  /** User or admin revoked an MCP client's access from the /mcp page. */
  MCP_CONNECTION_REVOKED:  "mcp.connection_revoked",
  /** Admin deleted a registered MCP client and revoked all its grants. */
  MCP_CLIENT_DELETED:      "mcp.client_deleted",
} as const;

export type ActivityAction = (typeof ACTIONS)[keyof typeof ACTIONS];

// ─── Helper ───────────────────────────────────────────────────────────────────

type ActivityActor = Pick<AuthUser, "id" | "name" | "role">;
type ActivityEntity = { type: string; id: string; label?: string | null };

function activityRow(
  actor: ActivityActor,
  action: ActivityAction,
  entity: ActivityEntity,
  metadata?: Record<string, unknown>,
) {
  return {
    id: crypto.randomUUID(),
    actorId: actor.id,
    actorName: actor.name ?? "Unknown",
    actorRole: actor.role,
    action,
    entityType: entity.type,
    entityId: entity.id,
    entityLabel: entity.label ?? null,
    metadata: metadata ? JSON.stringify(metadata) : null,
    createdAt: new Date().toISOString(),
  };
}

export async function writeActivity(
  db: AppDb,
  actor: ActivityActor,
  action: ActivityAction,
  entity: ActivityEntity,
  metadata?: Record<string, unknown>,
) {
  const row = activityRow(actor, action, entity, metadata);
  await db.insert(activityLogs).values(row);
  return row;
}

export async function logActivity(
  db: AppDb,
  actor: ActivityActor,
  action: ActivityAction,
  entity: ActivityEntity,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await writeActivity(db, actor, action, entity, metadata);
  } catch (err) {
    console.error("[activity] Failed to log:", action, entity.id, err);
  }
}

export async function logActivities(
  db: AppDb,
  actor: ActivityActor,
  action: ActivityAction,
  entries: Array<{ entity: ActivityEntity; metadata?: Record<string, unknown> }>,
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const rows = entries.map((entry) => activityRow(actor, action, entry.entity, entry.metadata));
    for (let i = 0; i < rows.length; i += 20) {
      await db.insert(activityLogs).values(rows.slice(i, i + 20));
    }
  } catch (err) {
    console.error("[activity] Failed to log batch:", action, entries.length, err);
  }
}
