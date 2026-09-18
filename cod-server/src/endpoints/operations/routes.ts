import { OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  operationAgentSettings,
  operationTasks,
  orders,
  staffCommissions,
  users,
} from "@/db/schema";
import type { AppContext } from "@/types";
import { z } from "zod";
import { hasPermission } from "../../../../cod-shared/rbac/utils";

const routes = new OpenAPIHono<AppContext>();
const activeOrderStatuses = ["new", "confirmed", "unreachable"] as const;

routes.use("*", async (c, next) => {
  const user = c.get("user");
  if (user.role !== "admin" && !hasPermission(user.scopes, "orders:read")) {
    return c.json(
      {
        success: false,
        error: "Orders read permission required",
        code: "FORBIDDEN",
      },
      403,
    );
  }
  await next();
});

function forbidden(c: any) {
  return c.json(
    {
      success: false,
      error: "Administrator access required",
      code: "FORBIDDEN",
    },
    403,
  );
}

function isAdmin(c: any) {
  return c.get("user")?.role === "admin";
}

routes.get("/summary", async (c) => {
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const own =
    actor.role === "admin"
      ? undefined
      : eq(operationTasks.assigneeId, actor.id);
  const [taskRows, commissionRows, unassigned] = await Promise.all([
    db
      .select({ status: operationTasks.status, count: sql<number>`count(*)` })
      .from(operationTasks)
      .where(own)
      .groupBy(operationTasks.status)
      .all(),
    db
      .select({
        status: staffCommissions.status,
        amount: sql<number>`coalesce(sum(${staffCommissions.amount}), 0)`,
      })
      .from(staffCommissions)
      .where(
        actor.role === "admin"
          ? undefined
          : eq(staffCommissions.userId, actor.id),
      )
      .groupBy(staffCommissions.status)
      .all(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(orders)
      .where(
        and(
          inArray(orders.status, [...activeOrderStatuses]),
          sql`${orders.confirmationAssigneeId} IS NULL`,
        ),
      )
      .get(),
  ]);
  const tasks = Object.fromEntries(
    taskRows.map((row) => [row.status, row.count]),
  );
  const commissions = Object.fromEntries(
    commissionRows.map((row) => [row.status, row.amount]),
  );
  return c.json({
    success: true,
    data: {
      openTasks: (tasks.open ?? 0) + (tasks.in_progress ?? 0),
      completedTasks: tasks.completed ?? 0,
      unassignedOrders: unassigned?.count ?? 0,
      earnedCommission: commissions.earned ?? 0,
      paidCommission: commissions.paid ?? 0,
    },
  });
});

routes.get("/tasks", async (c) => {
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const requestedAssignee = c.req.query("assigneeId");
  const assigneeId = actor.role === "admin" ? requestedAssignee : actor.id;
  const status = c.req.query("status");
  const conditions = [];
  if (assigneeId) conditions.push(eq(operationTasks.assigneeId, assigneeId));
  if (
    status &&
    ["open", "in_progress", "completed", "cancelled"].includes(status)
  ) {
    conditions.push(eq(operationTasks.status, status as any));
  }
  const rows = await db
    .select({
      id: operationTasks.id,
      title: operationTasks.title,
      description: operationTasks.description,
      type: operationTasks.type,
      status: operationTasks.status,
      priority: operationTasks.priority,
      orderId: operationTasks.orderId,
      customerId: operationTasks.customerId,
      assigneeId: operationTasks.assigneeId,
      assigneeName: users.name,
      dueAt: operationTasks.dueAt,
      completedAt: operationTasks.completedAt,
      createdAt: operationTasks.createdAt,
      updatedAt: operationTasks.updatedAt,
    })
    .from(operationTasks)
    .leftJoin(users, eq(operationTasks.assigneeId, users.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(
      sql`CASE ${operationTasks.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`,
      operationTasks.dueAt,
      desc(operationTasks.createdAt),
    )
    .limit(200)
    .all();
  return c.json({ success: true, data: rows, count: rows.length });
});

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  type: z
    .enum([
      "confirmation",
      "callback",
      "address_review",
      "shipment_follow_up",
      "follow_up",
    ])
    .default("follow_up"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  assigneeId: z.string().min(1),
  orderId: z.string().optional(),
  customerId: z.string().optional(),
  dueAt: z.string().datetime().optional(),
});

routes.post("/tasks", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const parsed = createTaskSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json(
      {
        success: false,
        error: parsed.error.flatten(),
        code: "VALIDATION_FAILED",
      },
      400,
    );
  const db = getDb(c.env.DB);
  const assignee = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.id, parsed.data.assigneeId), eq(users.status, "active")),
    )
    .get();
  if (!assignee)
    return c.json(
      { success: false, error: "Active assignee not found", code: "NOT_FOUND" },
      404,
    );
  const now = new Date().toISOString();
  const task = {
    id: crypto.randomUUID(),
    ...parsed.data,
    status: "open" as const,
    createdBy: c.get("user").id,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(operationTasks).values(task);
  return c.json({ success: true, data: task }, 201);
});

const updateTaskSchema = z.object({
  status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigneeId: z.string().min(1).optional(),
  dueAt: z.string().datetime().nullable().optional(),
});

routes.patch("/tasks/:id", async (c) => {
  const parsed = updateTaskSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json(
      {
        success: false,
        error: parsed.error.flatten(),
        code: "VALIDATION_FAILED",
      },
      400,
    );
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const task = await db
    .select()
    .from(operationTasks)
    .where(eq(operationTasks.id, c.req.param("id")))
    .get();
  if (!task)
    return c.json(
      { success: false, error: "Task not found", code: "NOT_FOUND" },
      404,
    );
  if (actor.role !== "admin" && task.assigneeId !== actor.id)
    return forbidden(c);
  const now = new Date().toISOString();
  await db
    .update(operationTasks)
    .set({
      ...parsed.data,
      completedAt:
        parsed.data.status === "completed"
          ? now
          : parsed.data.status
            ? null
            : task.completedAt,
      updatedAt: now,
    })
    .where(eq(operationTasks.id, task.id));
  return c.json({ success: true, message: "Task updated" });
});

const bulkAssignSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1).max(100),
  assigneeId: z.string().min(1),
});

routes.post("/orders/bulk-assign", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const parsed = bulkAssignSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json(
      {
        success: false,
        error: parsed.error.flatten(),
        code: "VALIDATION_FAILED",
      },
      400,
    );
  const db = getDb(c.env.DB);
  const assignee = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      and(
        eq(users.id, parsed.data.assigneeId),
        eq(users.role, "confirmer"),
        eq(users.status, "active"),
      ),
    )
    .get();
  if (!assignee)
    return c.json(
      {
        success: false,
        error: "Active confirmation agent not found",
        code: "NOT_FOUND",
      },
      404,
    );
  const selected = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
    })
    .from(orders)
    .where(inArray(orders.id, parsed.data.orderIds))
    .all();
  const now = new Date().toISOString();
  const statements: any[] = [
    db
      .update(orders)
      .set({ confirmationAssigneeId: assignee.id, confirmationAssignedAt: now })
      .where(
        inArray(
          orders.id,
          selected.map((order) => order.id),
        ),
      ),
  ];
  for (const order of selected) {
    statements.push(
      db.insert(operationTasks).values({
        id: crypto.randomUUID(),
        title: `Confirm order ${order.orderNumber}`,
        type: "confirmation",
        status: "open",
        priority: "normal",
        orderId: order.id,
        customerId: order.customerId,
        assigneeId: assignee.id,
        createdBy: c.get("user").id,
        dueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  if (selected.length) await db.batch(statements as any);
  return c.json({
    success: true,
    data: { assigned: selected.length, assignee },
  });
});

const agentSettingsSchema = z.object({
  autoAssignEnabled: z.boolean(),
  maxOpenOrders: z.number().int().min(1).max(500),
  commissionType: z.enum(["fixed", "percentage"]),
  commissionValue: z.number().min(0).max(1000000),
});

routes.get("/agents", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const db = getDb(c.env.DB);
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      autoAssignEnabled: sql<boolean>`coalesce(${operationAgentSettings.autoAssignEnabled}, 1)`,
      maxOpenOrders: sql<number>`coalesce(${operationAgentSettings.maxOpenOrders}, 25)`,
      commissionType: sql<string>`coalesce(${operationAgentSettings.commissionType}, 'fixed')`,
      commissionValue: sql<number>`coalesce(${operationAgentSettings.commissionValue}, 0)`,
    })
    .from(users)
    .leftJoin(
      operationAgentSettings,
      eq(users.id, operationAgentSettings.userId),
    )
    .where(eq(users.role, "confirmer"))
    .orderBy(users.name)
    .all();
  return c.json({ success: true, data: rows, count: rows.length });
});

routes.put("/agents/:id/settings", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const parsed = agentSettingsSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json(
      {
        success: false,
        error: parsed.error.flatten(),
        code: "VALIDATION_FAILED",
      },
      400,
    );
  const db = getDb(c.env.DB);
  const agent = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, c.req.param("id")), eq(users.role, "confirmer")))
    .get();
  if (!agent)
    return c.json(
      {
        success: false,
        error: "Confirmation agent not found",
        code: "NOT_FOUND",
      },
      404,
    );
  const values = {
    userId: agent.id,
    ...parsed.data,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(operationAgentSettings)
    .values(values)
    .onConflictDoUpdate({
      target: operationAgentSettings.userId,
      set: { ...parsed.data, updatedAt: values.updatedAt },
    });
  return c.json({ success: true, data: values });
});

routes.get("/performance", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const result = await c.env.DB.prepare(
    `
    SELECT u.id, u.name,
      COALESCE(s.auto_assign_enabled, 1) AS autoAssignEnabled,
      COALESCE(s.max_open_orders, 25) AS maxOpenOrders,
      (SELECT COUNT(*) FROM orders o WHERE o.confirmation_assignee_id = u.id AND o.status IN ('new','confirmed','unreachable')) AS openOrders,
      (SELECT COUNT(*) FROM orders o WHERE o.confirmation_assignee_id = u.id AND o.status = 'delivered') AS deliveredOrders,
      (SELECT COUNT(*) FROM orders o WHERE o.confirmation_assignee_id = u.id AND o.status IN ('returned','cancelled')) AS failedOrders,
      COALESCE((SELECT SUM(sc.amount) FROM staff_commissions sc WHERE sc.user_id = u.id AND sc.status = 'earned'), 0) AS earnedCommission,
      COALESCE((SELECT SUM(sc.amount) FROM staff_commissions sc WHERE sc.user_id = u.id AND sc.status = 'paid'), 0) AS paidCommission
    FROM users u
    LEFT JOIN operation_agent_settings s ON s.user_id = u.id
    WHERE u.role = 'confirmer'
    ORDER BY deliveredOrders DESC, u.name ASC
  `,
  ).all();
  return c.json({
    success: true,
    data: result.results,
    count: result.results.length,
  });
});

export default routes;
