import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "../db/client";
import {
  activityLogs,
  operationTasks,
  orderConfirmationAssignments,
  orderContactAttempts,
  orderStatusHistory,
  orders,
  users,
} from "../db/schema";
import {
  MAX_DAILY_UNANSWERED_CALLS,
  UNANSWERED_OUTCOMES,
  algeriaDayBounds,
  countsTowardDailyLimit,
  summarizeContactAttempts,
  type ContactChannel,
  type ContactOutcome,
} from "../lib/order-contact";

export type OrderContactAttempt = typeof orderContactAttempts.$inferSelect;

export async function getOrderContactHeader(db: AppDb, orderId: string) {
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      customerName: orders.customerName,
      phone: orders.phone,
      status: orders.status,
      orderType: orders.orderType,
      createdAt: orders.createdAt,
      confirmationAssigneeId: orderConfirmationAssignments.assigneeId,
      confirmationAssigneeName: users.name,
    })
    .from(orders)
    .leftJoin(orderConfirmationAssignments, eq(orderConfirmationAssignments.orderId, orders.id))
    .leftJoin(users, eq(users.id, orderConfirmationAssignments.assigneeId))
    .where(eq(orders.id, orderId))
    .get();
}

export async function listOrderContactAttempts(db: AppDb, orderId: string, limit = 500) {
  return db
    .select()
    .from(orderContactAttempts)
    .where(eq(orderContactAttempts.orderId, orderId))
    .orderBy(desc(orderContactAttempts.createdAt), desc(orderContactAttempts.id))
    .limit(limit)
    .all();
}

export async function getOrderContactSummary(db: AppDb, orderId: string, now: Date = new Date()) {
  return summarizeContactAttempts(await listOrderContactAttempts(db, orderId), now);
}

export interface RecordContactAttemptInput {
  orderId: string;
  channel: ContactChannel;
  outcome: ContactOutcome;
  note?: string | null;
  callbackAt?: string | null;
  actor: { id: string; name: string };
  now?: Date;
}

export async function recordOrderContactAttempt(
  db: AppDb,
  input: RecordContactAttemptInput,
): Promise<{ recorded: false } | { recorded: true; attempt: OrderContactAttempt }> {
  const now = input.now ?? new Date();
  const note = input.note?.trim();
  const attempt: OrderContactAttempt = {
    id: crypto.randomUUID(),
    orderId: input.orderId,
    channel: input.channel,
    outcome: input.outcome,
    note: note ? note : null,
    callbackAt: input.outcome === "callback_requested" ? input.callbackAt ?? null : null,
    createdBy: input.actor.id,
    createdByName: input.actor.name,
    createdAt: now.toISOString(),
  };

  if (!countsTowardDailyLimit(attempt.channel, attempt.outcome)) {
    await db.insert(orderContactAttempts).values(attempt);
    return { recorded: true, attempt };
  }

  const { start, end } = algeriaDayBounds(now);
  const unanswered = sql.join(
    UNANSWERED_OUTCOMES.map((outcome) => sql`${outcome}`),
    sql`, `,
  );
  const result = await db.run(sql`
    INSERT INTO ${orderContactAttempts}
      (id, order_id, channel, outcome, note, callback_at, created_by, created_by_name, created_at)
    SELECT ${attempt.id}, ${attempt.orderId}, ${attempt.channel}, ${attempt.outcome}, ${attempt.note},
      ${attempt.callbackAt}, ${attempt.createdBy}, ${attempt.createdByName}, ${attempt.createdAt}
    WHERE (
      SELECT COUNT(*) FROM ${orderContactAttempts}
      WHERE order_id = ${attempt.orderId}
        AND channel = 'call'
        AND outcome IN (${unanswered})
        AND created_at >= ${start}
        AND created_at < ${end}
    ) < ${MAX_DAILY_UNANSWERED_CALLS}
  `);
  const changes = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
  return changes > 0 ? { recorded: true, attempt } : { recorded: false };
}

export async function completeOrderCallbacks(db: AppDb, orderId: string) {
  const now = new Date().toISOString();
  await db
    .update(operationTasks)
    .set({ status: "completed", completedAt: now, updatedAt: now })
    .where(
      and(
        eq(operationTasks.orderId, orderId),
        eq(operationTasks.type, "callback"),
        sql`${operationTasks.status} IN ('open','in_progress')`,
      ),
    );
}

export async function scheduleOrderCallback(
  db: AppDb,
  params: {
    order: { id: string; orderNumber: string; customerId: string; customerName: string };
    assigneeId: string;
    createdBy: string;
    callbackAt: string;
    note?: string | null;
  },
) {
  const now = new Date().toISOString();
  const note = params.note?.trim();
  const task = {
    id: crypto.randomUUID(),
    title: `Call back ${params.order.customerName} · ${params.order.orderNumber}`,
    description: note ? note : null,
    type: "callback" as const,
    status: "open" as const,
    priority: "high" as const,
    orderId: params.order.id,
    customerId: params.order.customerId,
    assigneeId: params.assigneeId,
    createdBy: params.createdBy,
    dueAt: params.callbackAt,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(operationTasks).values(task);
  return task;
}

export type OrderActivityKind = "created" | "status" | "contact" | "note" | "event";

export interface OrderActivityEntry {
  id: string;
  kind: OrderActivityKind;
  action: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  source: string | null;
  createdAt: string;
  fromStatus: string | null;
  toStatus: string | null;
  channel: string | null;
  outcome: string | null;
  note: string | null;
  callbackAt: string | null;
  metadata: Record<string, unknown> | null;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const SHIPMENT_STATUS_ACTIONS = new Set([
  "update_shipment",
  "cancel_shipment",
  "ask_return",
  "confirm_return_reception",
  "carrier_remark",
]);
const STATUS_LOG_MATCH_WINDOW_MS = 15_000;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export async function getOrderActivityFeed(db: AppDb, orderId: string, limit = 500) {
  const [logs, history, attempts] = await db.batch([
    db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.entityType, "order"), eq(activityLogs.entityId, orderId)))
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit),
    db
      .select({
        id: orderStatusHistory.id,
        status: orderStatusHistory.status,
        timestamp: orderStatusHistory.timestamp,
        by: orderStatusHistory.by,
        byName: users.name,
        byRole: users.role,
      })
      .from(orderStatusHistory)
      .leftJoin(users, eq(orderStatusHistory.by, users.id))
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(desc(orderStatusHistory.timestamp))
      .limit(limit),
    db
      .select({
        id: orderContactAttempts.id,
        orderId: orderContactAttempts.orderId,
        channel: orderContactAttempts.channel,
        outcome: orderContactAttempts.outcome,
        note: orderContactAttempts.note,
        callbackAt: orderContactAttempts.callbackAt,
        createdBy: orderContactAttempts.createdBy,
        createdByName: orderContactAttempts.createdByName,
        createdAt: orderContactAttempts.createdAt,
        createdByRole: users.role,
      })
      .from(orderContactAttempts)
      .leftJoin(users, eq(orderContactAttempts.createdBy, users.id))
      .where(eq(orderContactAttempts.orderId, orderId))
      .orderBy(desc(orderContactAttempts.createdAt), desc(orderContactAttempts.id))
      .limit(limit),
  ]);

  const parsedLogs = logs.map((log) => ({ ...log, meta: parseMetadata(log.metadata) }));
  const statusLogs = parsedLogs.filter(
    (log) => log.action === "order.status_changed" && !stringOrNull(log.meta?.action),
  );
  const consumedStatusLogs = new Set<string>();
  const createdLog = parsedLogs.find((log) => log.action === "order.created");
  const chronological = [...history].reverse();
  const entries: OrderActivityEntry[] = [];

  chronological.forEach((row, index) => {
    const isUser = Boolean(row.by && row.byName);
    const source = row.by && !isUser ? row.by : null;
    if (index === 0) {
      if (createdLog) return;
      entries.push({
        id: `status:${row.id}`,
        kind: "created",
        action: "order.created",
        actorId: isUser ? row.by : null,
        actorName: row.byName ?? null,
        actorRole: row.byRole ?? null,
        source,
        createdAt: row.timestamp,
        fromStatus: null,
        toStatus: row.status,
        channel: null,
        outcome: null,
        note: null,
        callbackAt: null,
        metadata: null,
      });
      return;
    }
    const at = Date.parse(row.timestamp);
    const match = statusLogs.find(
      (log) =>
        !consumedStatusLogs.has(log.id) &&
        log.actorId === row.by &&
        log.meta?.to === row.status &&
        Math.abs(Date.parse(log.createdAt) - at) <= STATUS_LOG_MATCH_WINDOW_MS,
    );
    if (match) consumedStatusLogs.add(match.id);
    entries.push({
      id: `status:${row.id}`,
      kind: "status",
      action: "order.status_changed",
      actorId: isUser ? row.by : match?.actorId ?? null,
      actorName: row.byName ?? match?.actorName ?? null,
      actorRole: row.byRole ?? match?.actorRole ?? null,
      source,
      createdAt: row.timestamp,
      fromStatus: chronological[index - 1]?.status ?? null,
      toStatus: row.status,
      channel: null,
      outcome: null,
      note: null,
      callbackAt: null,
      metadata: match?.meta ?? null,
    });
  });

  const unansweredPerDay = new Map<string, number>();
  for (const attempt of [...attempts].reverse()) {
    let metadata: Record<string, unknown> | null = null;
    if (countsTowardDailyLimit(attempt.channel, attempt.outcome)) {
      const day = algeriaDayBounds(new Date(attempt.createdAt)).start;
      const attemptOfDay = (unansweredPerDay.get(day) ?? 0) + 1;
      unansweredPerDay.set(day, attemptOfDay);
      metadata = { attemptOfDay, dailyLimit: MAX_DAILY_UNANSWERED_CALLS };
    }
    entries.push({
      id: `contact:${attempt.id}`,
      kind: "contact",
      action: "order.contact_attempt",
      actorId: attempt.createdBy,
      actorName: attempt.createdByName,
      actorRole: attempt.createdByRole ?? null,
      source: null,
      createdAt: attempt.createdAt,
      fromStatus: null,
      toStatus: null,
      channel: attempt.channel,
      outcome: attempt.outcome,
      note: attempt.note,
      callbackAt: attempt.callbackAt,
      metadata,
    });
  }

  for (const log of parsedLogs) {
    if (log.action === "order.contact_attempt") continue;
    const metaAction = stringOrNull(log.meta?.action);
    let action = log.action;
    let kind: OrderActivityKind = "event";
    if (log.action === "order.status_changed") {
      if (!metaAction || !SHIPMENT_STATUS_ACTIONS.has(metaAction)) continue;
      action = `order.${metaAction}`;
    } else if (log.action === "order.dispatched" && metaAction === "validated") {
      action = "order.shipment_validated";
    } else if (log.action === "order.created") {
      kind = "created";
    } else if (log.action === "order.note_added") {
      kind = "note";
    }
    entries.push({
      id: `activity:${log.id}`,
      kind,
      action,
      actorId: log.actorId,
      actorName: log.actorName,
      actorRole: log.actorRole,
      source: null,
      createdAt: log.createdAt,
      fromStatus: null,
      toStatus: kind === "created" ? chronological[0]?.status ?? null : null,
      channel: null,
      outcome: null,
      note: stringOrNull(log.meta?.note),
      callbackAt: stringOrNull(log.meta?.callbackAt),
      metadata: log.meta,
    });
  }

  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return { entries, attempts };
}
