import type { Context } from "hono";
import type { AppContext } from "@/types";
import { getDb } from "@/db";
import * as queries from "./queries";
import * as validation from "./validation";
import * as contactQueries from "../../../../cod-shared/queries/order-contact";
import {
  countsTowardDailyLimit,
  summarizeContactAttempts,
  triggersAutoUnreachable,
  MAX_DAILY_UNANSWERED_CALLS,
} from "../../../../cod-shared/lib/order-contact";
import { ACTIONS, logActivity, writeActivity } from "@/lib/activity";
import { BusinessLogicError, NotFoundError } from "@/lib/errors/classes";
import { ERROR_CODES } from "../../../../cod-shared/errors/codes";

const CONTACTABLE_STATUSES = new Set(["new", "confirmed", "unreachable", "preparing", "ready", "assigned", "dispatched", "out_for_delivery"]);

function orderIdParam(c: Context<AppContext>): string {
  const params = (c.req as any).valid?.("param") as { id?: string } | undefined;
  return params?.id ?? c.req.param("id")!;
}

async function loadHeader(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const orderId = orderIdParam(c);
  const order = await contactQueries.getOrderContactHeader(db, orderId);
  if (!order) throw new NotFoundError("Order", orderId);
  return { db, order };
}

export async function listContactAttempts(c: Context<AppContext>) {
  const { db, order } = await loadHeader(c);
  const attempts = await contactQueries.listOrderContactAttempts(db, order.id);
  return c.json({
    success: true,
    data: { attempts, summary: summarizeContactAttempts(attempts) },
  }, 200);
}

export async function createContactAttempt(c: Context<AppContext>) {
  const { db, order } = await loadHeader(c);
  const body: validation.ContactAttemptInput =
    (c.req as any).valid?.("json") ?? validation.contactAttemptSchema.parse(await c.req.json());
  const actor = c.get("user");

  if (!CONTACTABLE_STATUSES.has(order.status)) {
    throw new BusinessLogicError(
      `Cannot log contact on a ${order.status} order`,
      ERROR_CODES.INVALID_STATUS_TRANSITION,
      { orderId: order.id, currentStatus: order.status },
    );
  }

  const result = await contactQueries.recordOrderContactAttempt(db, {
    orderId: order.id,
    channel: body.channel,
    outcome: body.outcome,
    note: body.note,
    callbackAt: body.callbackAt,
    actor: { id: actor.id, name: actor.name ?? "Unknown" },
  });

  if (!result.recorded) {
    const summary = await contactQueries.getOrderContactSummary(db, order.id);
    throw new BusinessLogicError(
      `Daily limit reached: ${MAX_DAILY_UNANSWERED_CALLS} unanswered calls already logged today for this order`,
      ERROR_CODES.CONTACT_LIMIT_REACHED,
      { orderId: order.id, limit: MAX_DAILY_UNANSWERED_CALLS, resetsAt: summary.resetsAt },
    );
  }

  const { attempt } = result;
  const entity = { type: "order", id: order.id, label: order.orderNumber };
  const attemptsAfter = await contactQueries.listOrderContactAttempts(db, order.id);
  const summary = summarizeContactAttempts(attemptsAfter);

  await logActivity(db, actor, ACTIONS.ORDER_CONTACT_ATTEMPT, entity, {
    attemptId: attempt.id,
    channel: attempt.channel,
    outcome: attempt.outcome,
    note: attempt.note,
    callbackAt: attempt.callbackAt,
    ...(countsTowardDailyLimit(attempt.channel, attempt.outcome)
      ? { attemptOfDay: summary.unansweredToday, dailyLimit: summary.dailyLimit }
      : {}),
  });

  let statusChanged: { from: string; to: string } | null = null;
  if (triggersAutoUnreachable(attempt.channel, attempt.outcome) && order.status === "new") {
    await queries.updateOrderStatus(db, order.id, "unreachable", actor.id, actor.name ?? undefined);
    statusChanged = { from: order.status, to: "unreachable" };
    await logActivity(db, actor, ACTIONS.ORDER_STATUS_CHANGED, entity, {
      from: order.status,
      to: "unreachable",
      reason: "contact_attempt",
      outcome: attempt.outcome,
    });
  }

  let callbackTaskId: string | null = null;
  if (attempt.channel === "call" && (attempt.outcome === "answered" || attempt.outcome === "callback_requested")) {
    await contactQueries.completeOrderCallbacks(db, order.id);
  }
  if (attempt.outcome === "callback_requested" && attempt.callbackAt) {
    const task = await contactQueries.scheduleOrderCallback(db, {
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        customerName: order.customerName,
      },
      assigneeId: order.confirmationAssigneeId ?? actor.id,
      createdBy: actor.id,
      callbackAt: attempt.callbackAt,
      note: attempt.note,
    });
    callbackTaskId = task.id;
  }

  return c.json({
    success: true,
    data: { attempt, summary, statusChanged, callbackTaskId },
    message: "Contact attempt recorded",
  }, 201);
}

export async function addOrderNote(c: Context<AppContext>) {
  const { db, order } = await loadHeader(c);
  const body: validation.OrderNoteInput =
    (c.req as any).valid?.("json") ?? validation.orderNoteSchema.parse(await c.req.json());
  const actor = c.get("user");
  const row = await writeActivity(
    db,
    actor,
    ACTIONS.ORDER_NOTE_ADDED,
    { type: "order", id: order.id, label: order.orderNumber },
    { note: body.note.trim() },
  );
  return c.json({
    success: true,
    data: { id: row.id, note: body.note.trim(), createdAt: row.createdAt },
    message: "Note added",
  }, 201);
}

export async function getOrderActivity(c: Context<AppContext>) {
  const { db, order } = await loadHeader(c);
  const { entries, attempts } = await contactQueries.getOrderActivityFeed(db, order.id);
  return c.json({
    success: true,
    data: {
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        phone: order.phone,
        status: order.status,
        orderType: order.orderType,
        createdAt: order.createdAt,
        confirmationAssigneeName: order.confirmationAssigneeName ?? null,
      },
      summary: summarizeContactAttempts(attempts),
      entries,
    },
  }, 200);
}
