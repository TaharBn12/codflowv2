import { OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  operationAgentSettings,
  operationAutomationSettings,
  operationTasks,
  orderConfirmationAssignments,
  orders,
  staffCommissions,
  telegramApprovalConfig,
  users,
} from "@/db/schema";
import type { AppContext } from "@/types";
import { z } from "zod";
import { hasPermission } from "../../../../cod-shared/rbac/utils";
import { chooseLeastLoadedConfirmer, createStaffCommissionStages } from "../../../../cod-shared/queries/orders";
import {
  configureTelegramWebhook,
  requestCommissionPayoutApproval,
  resolveTelegramConfig,
} from "@/endpoints/telegram-approvals/service";

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
    actor.role === "admin"
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(orders)
          .leftJoin(
            orderConfirmationAssignments,
            eq(orders.id, orderConfirmationAssignments.orderId),
          )
          .where(
            and(
              inArray(orders.status, [...activeOrderStatuses]),
              sql`${orderConfirmationAssignments.orderId} IS NULL`,
            ),
          )
          .get()
      : Promise.resolve({ count: 0 }),
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
      orderStatus: orders.status,
    })
    .from(operationTasks)
    .leftJoin(orders, eq(operationTasks.orderId, orders.id))
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

routes.post("/orders/auto-assign", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    orderIds?: string[];
  };
  const parsed = z
    .object({ orderIds: z.array(z.string().min(1)).max(100).optional() })
    .safeParse(body);
  if (!parsed.success)
    return c.json(
      {
        success: false,
        code: "VALIDATION_FAILED",
        error: parsed.error.flatten(),
      },
      400,
    );
  const db = getDb(c.env.DB);
  const conditions = [
    eq(orders.status, "new"),
    sql`${orderConfirmationAssignments.orderId} IS NULL`,
  ];
  if (parsed.data.orderIds?.length)
    conditions.push(inArray(orders.id, parsed.data.orderIds));
  const pending = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
    })
    .from(orders)
    .leftJoin(
      orderConfirmationAssignments,
      eq(orders.id, orderConfirmationAssignments.orderId),
    )
    .where(and(...conditions))
    .orderBy(orders.createdAt)
    .limit(100)
    .all();
  let assigned = 0;
  for (const order of pending) {
    const agent = await chooseLeastLoadedConfirmer(db);
    if (!agent) break;
    const now = new Date().toISOString();
    await db.batch([
      db.insert(orderConfirmationAssignments).values({
        orderId: order.id,
        assigneeId: agent.id,
        assignedBy: c.get("user").id,
        assignedAt: now,
        updatedAt: now,
      }),
      db.insert(operationTasks).values({
        id: crypto.randomUUID(),
        title: `Confirm order ${order.orderNumber}`,
        type: "confirmation",
        status: "open",
        priority: "normal",
        orderId: order.id,
        customerId: order.customerId,
        assigneeId: agent.id,
        createdBy: c.get("user").id,
        dueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    await createStaffCommissionStages(db, order.id, false);
    assigned += 1;
  }
  return c.json({
    success: true,
    data: { assigned, remaining: pending.length - assigned },
  });
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
      status: orders.status,
    })
    .from(orders)
    .where(inArray(orders.id, parsed.data.orderIds))
    .all();
  const now = new Date().toISOString();
  const statements: any[] = selected.length
    ? [
        db
          .update(operationTasks)
          .set({ status: "cancelled", updatedAt: now })
          .where(
            and(
              inArray(
                operationTasks.orderId,
                selected.map((order) => order.id),
              ),
              inArray(operationTasks.status, ["open", "in_progress"]),
            ),
          ),
      ]
    : [];
  statements.push(
    ...selected.map((order) =>
      db
        .insert(orderConfirmationAssignments)
        .values({
          orderId: order.id,
          assigneeId: assignee.id,
          assignedBy: c.get("user").id,
          assignedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: orderConfirmationAssignments.orderId,
          set: {
            assigneeId: assignee.id,
            assignedBy: c.get("user").id,
            assignedAt: now,
            updatedAt: now,
          },
        }),
    ),
  );
  for (const order of selected) {
    if (["delivered", "returned", "cancelled"].includes(order.status)) continue;
    statements.push(
      db.insert(operationTasks).values({
        id: crypto.randomUUID(),
        title: `${order.status === "new" ? "Confirm" : "Follow up"} order ${order.orderNumber}`,
        type: order.status === "new" ? "confirmation" : "follow_up",
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
  if (selected.length) {
    await db.batch(statements as any);
    for (const order of selected) {
      await createStaffCommissionStages(db, order.id, order.status !== "new");
    }
  }
  return c.json({
    success: true,
    data: { assigned: selected.length, assignee },
  });
});

routes.get("/commissions", async (c) => {
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const rows = await db
    .select({
      id: staffCommissions.id,
      orderId: staffCommissions.orderId,
      orderNumber: orders.orderNumber,
      userId: staffCommissions.userId,
      userName: users.name,
      amount: staffCommissions.amount,
      category: staffCommissions.category,
      status: staffCommissions.status,
      earnedAt: staffCommissions.earnedAt,
      paidAt: staffCommissions.paidAt,
    })
    .from(staffCommissions)
    .innerJoin(users, eq(staffCommissions.userId, users.id))
    .innerJoin(orders, eq(staffCommissions.orderId, orders.id))
    .where(
      actor.role === "admin"
        ? undefined
        : eq(staffCommissions.userId, actor.id),
    )
    .orderBy(desc(staffCommissions.earnedAt))
    .limit(250)
    .all();
  return c.json({ success: true, data: rows, count: rows.length });
});

routes.get("/commissions/report", async (c) => {
  const actor = c.get("user");
  const parsed = z.object({ period: z.enum(["daily", "monthly"]).default("daily"), from: z.string().optional(), to: z.string().optional(), category: z.enum(["confirmation", "follow_up"]).optional(), userId: z.string().optional() }).safeParse(c.req.query());
  if (!parsed.success) return c.json({ success: false, code: "VALIDATION_FAILED", error: parsed.error.flatten() }, 400);
  const bucket = parsed.data.period === "monthly" ? sql<string>`strftime('%Y-%m', ${staffCommissions.createdAt})` : sql<string>`date(${staffCommissions.createdAt})`;
  const conditions = [actor.role === "admin" ? undefined : eq(staffCommissions.userId, actor.id), parsed.data.from ? gte(staffCommissions.createdAt, parsed.data.from) : undefined, parsed.data.to ? lte(staffCommissions.createdAt, parsed.data.to) : undefined, parsed.data.category ? eq(staffCommissions.category, parsed.data.category) : undefined, actor.role === "admin" && parsed.data.userId ? eq(staffCommissions.userId, parsed.data.userId) : undefined].filter(Boolean) as any[];
  const rows = await getDb(c.env.DB).select({ period: bucket, userId: staffCommissions.userId, userName: users.name, category: staffCommissions.category, status: staffCommissions.status, amount: sql<number>`sum(${staffCommissions.amount})`, count: sql<number>`count(*)` }).from(staffCommissions).innerJoin(users, eq(staffCommissions.userId, users.id)).where(conditions.length ? and(...conditions) : undefined).groupBy(bucket, staffCommissions.userId, users.name, staffCommissions.category, staffCommissions.status).orderBy(desc(bucket)).all();
  return c.json({ success: true, data: rows, count: rows.length });
});

routes.post("/commissions/mark-paid", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const parsed = z
    .object({ ids: z.array(z.string().min(1)).min(1).max(250) })
    .safeParse(await c.req.json());
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
  const eligible = await db
    .select({ id: staffCommissions.id, amount: staffCommissions.amount })
    .from(staffCommissions)
    .where(
      and(
        inArray(staffCommissions.id, parsed.data.ids),
        eq(staffCommissions.status, "earned"),
      ),
    )
    .all();
  const telegramConfig = await resolveTelegramConfig(c.env);
  if (telegramConfig) {
    const approval = await requestCommissionPayoutApproval(
      c.env,
      c.get("user"),
      eligible.map((row) => row.id),
      eligible.reduce((sum, row) => sum + row.amount, 0),
    );
    return c.json(
      {
        success: true,
        data: { approvalId: approval.id, status: "pending" },
        message: "Approval sent to Telegram",
      },
      202,
    );
  }
  const now = new Date().toISOString();
  const result = await db
    .update(staffCommissions)
    .set({ status: "paid", paidAt: now, updatedAt: now })
    .where(
      and(
        inArray(
          staffCommissions.id,
          eligible.map((row) => row.id),
        ),
        eq(staffCommissions.status, "earned"),
      ),
    )
    .returning({ id: staffCommissions.id })
    .all();
  return c.json({ success: true, data: { paid: result.length } });
});

routes.get("/telegram/config", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const resolved = await resolveTelegramConfig(c.env);
  const stored = await getDb(c.env.DB)
    .select()
    .from(telegramApprovalConfig)
    .where(eq(telegramApprovalConfig.id, "default"))
    .get();
  const token = stored?.botToken ?? resolved?.botToken ?? "";
  return c.json({
    success: true,
    data: {
      configured: Boolean(resolved),
      source: stored ? "dashboard" : (resolved?.source ?? null),
      chatId:
        stored?.chatId ??
        (resolved?.source === "environment" ? resolved.chatId : ""),
      enabled: stored?.enabled ?? Boolean(resolved),
      botTokenMasked: token ? `••••${token.slice(-6)}` : "",
    },
  });
});

routes.put("/telegram/config", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const parsed = z
    .object({
      botToken: z.string().trim().default(""),
      chatId: z.string().trim().min(1),
      enabled: z.boolean().default(true),
    })
    .safeParse(await c.req.json());
  if (!parsed.success)
    return c.json(
      {
        success: false,
        code: "VALIDATION_FAILED",
        error: parsed.error.flatten(),
      },
      400,
    );
  const db = getDb(c.env.DB);
  const existing = await db
    .select()
    .from(telegramApprovalConfig)
    .where(eq(telegramApprovalConfig.id, "default"))
    .get();
  const botToken = parsed.data.botToken || existing?.botToken || c.env.TELEGRAM_BOT_TOKEN || "";
  if (!botToken)
    return c.json(
      {
        success: false,
        code: "BOT_TOKEN_REQUIRED",
        error: "Bot token is required",
      },
      400,
    );
  const now = new Date().toISOString();
  const values = {
    id: "default",
    botToken,
    chatId: parsed.data.chatId,
    enabled: parsed.data.enabled,
    webhookSecret:
      existing?.webhookSecret ||
      `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", ""),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db
    .insert(telegramApprovalConfig)
    .values(values)
    .onConflictDoUpdate({
      target: telegramApprovalConfig.id,
      set: {
        botToken: values.botToken,
        chatId: values.chatId,
        enabled: values.enabled,
        webhookSecret: values.webhookSecret,
        updatedAt: now,
      },
    });
  if (values.enabled) await configureTelegramWebhook(c.env);
  return c.json({
    success: true,
    data: {
      configured: values.enabled,
      source: "dashboard",
      chatId: values.chatId,
      enabled: values.enabled,
      botTokenMasked: `••••${botToken.slice(-6)}`,
    },
  });
});

routes.post("/telegram/setup", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const webhookUrl = await configureTelegramWebhook(c.env);
  return c.json({ success: true, data: { webhookUrl } });
});

routes.get("/automation-settings", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const db = getDb(c.env.DB);
  const row = await db.select().from(operationAutomationSettings).where(eq(operationAutomationSettings.id, "default")).get();
  return c.json({ success: true, data: { autoAssignEnabled: row?.autoAssignEnabled ?? true } });
});

routes.put("/automation-settings", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const parsed = z.object({ autoAssignEnabled: z.boolean() }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten(), code: "VALIDATION_FAILED" }, 400);
  const now = new Date().toISOString();
  const values = { id: "default", autoAssignEnabled: parsed.data.autoAssignEnabled, updatedBy: c.get("user").id, createdAt: now, updatedAt: now };
  const db = getDb(c.env.DB);
  await db.insert(operationAutomationSettings).values(values).onConflictDoUpdate({
    target: operationAutomationSettings.id,
    set: { autoAssignEnabled: values.autoAssignEnabled, updatedBy: values.updatedBy, updatedAt: now },
  });
  return c.json({ success: true, data: { autoAssignEnabled: values.autoAssignEnabled } });
});

const agentSettingsSchema = z.object({
  autoAssignEnabled: z.boolean(),
  maxOpenOrders: z.number().int().min(1).max(500),
  commissionType: z.enum(["fixed", "percentage"]),
  commissionValue: z.number().min(0).max(1000000),
  confirmationCommissionType: z.enum(["fixed", "percentage"]),
  confirmationCommissionValue: z.number().min(0).max(1000000),
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
      confirmationCommissionType: sql<string>`coalesce(${operationAgentSettings.confirmationCommissionType}, 'fixed')`,
      confirmationCommissionValue: sql<number>`coalesce(${operationAgentSettings.confirmationCommissionValue}, 0)`,
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
      (SELECT COUNT(*) FROM order_confirmation_assignments ca JOIN orders o ON o.id = ca.order_id WHERE ca.assignee_id = u.id AND o.status IN ('new','confirmed','unreachable')) AS openOrders,
      (SELECT COUNT(*) FROM order_confirmation_assignments ca JOIN orders o ON o.id = ca.order_id WHERE ca.assignee_id = u.id AND o.status = 'delivered') AS deliveredOrders,
      (SELECT COUNT(*) FROM order_confirmation_assignments ca JOIN orders o ON o.id = ca.order_id WHERE ca.assignee_id = u.id AND o.status IN ('returned','cancelled')) AS failedOrders,
      COALESCE((SELECT SUM(sc.amount) FROM staff_commission_events sc WHERE sc.user_id = u.id AND sc.status = 'earned'), 0) AS earnedCommission,
      COALESCE((SELECT SUM(sc.amount) FROM staff_commission_events sc WHERE sc.user_id = u.id AND sc.category = 'confirmation' AND sc.status IN ('earned','paid')), 0) AS confirmationCommission,
      COALESCE((SELECT SUM(sc.amount) FROM staff_commission_events sc WHERE sc.user_id = u.id AND sc.category = 'follow_up' AND sc.status IN ('earned','paid')), 0) AS followUpCommission,
      COALESCE((SELECT SUM(sc.amount) FROM staff_commission_events sc WHERE sc.user_id = u.id AND sc.status = 'paid'), 0) AS paidCommission
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
