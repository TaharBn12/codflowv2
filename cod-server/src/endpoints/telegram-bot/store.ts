/**
 * Persistence for the interactive bot: account links, one-time link codes,
 * conversation state, update dedupe, audit events, digests and alert state.
 *
 * Kept separate from rendering/decisions so every table is touched in one place
 * and the webhook handler stays readable.
 */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  telegramAlertState,
  telegramBotConfig,
  telegramBotEvents,
  telegramBotSessions,
  telegramDigestQueue,
  telegramLinkCodes,
  telegramUpdateLog,
  telegramUserLinks,
  users,
  userScopes,
} from "@/db/schema";
import type { BotLanguage } from "./i18n";
import { isBotLanguage } from "./i18n";

export type TelegramLinkRow = typeof telegramUserLinks.$inferSelect;

export interface LinkedUser {
  link: TelegramLinkRow;
  user: {
    id: string;
    name: string;
    email: string;
    role: "admin" | "staff" | "confirmer" | "driver";
    status: "active" | "inactive";
    language: string;
  };
  scopes: string[];
}

export interface BotConfigRow {
  enabled: boolean;
  defaultLanguage: BotLanguage;
  quietHoursStart: number;
  quietHoursEnd: number;
  digestIntervalMinutes: number;
  weeklyReportEnabled: boolean;
  weeklyReportDay: number;
  weeklyReportHour: number;
  monthlyReportEnabled: boolean;
  monthlyReportHour: number;
  lastWeeklySentOn: string | null;
  lastMonthlySentOn: string | null;
}

export const DEFAULT_BOT_CONFIG: BotConfigRow = {
  enabled: true,
  defaultLanguage: "ar",
  quietHoursStart: 23,
  quietHoursEnd: 7,
  digestIntervalMinutes: 60,
  weeklyReportEnabled: true,
  weeklyReportDay: 6,
  weeklyReportHour: 20,
  monthlyReportEnabled: true,
  monthlyReportHour: 20,
  lastWeeklySentOn: null,
  lastMonthlySentOn: null,
};

function clampHour(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(23, Math.trunc(parsed)));
}

export async function getBotConfig(db: AppDb): Promise<BotConfigRow> {
  const row = await db
    .select()
    .from(telegramBotConfig)
    .where(eq(telegramBotConfig.id, "default"))
    .get();
  if (!row) return { ...DEFAULT_BOT_CONFIG };
  return {
    enabled: Boolean(row.enabled),
    defaultLanguage: isBotLanguage(row.defaultLanguage) ? row.defaultLanguage : "ar",
    quietHoursStart: clampHour(row.quietHoursStart, DEFAULT_BOT_CONFIG.quietHoursStart),
    quietHoursEnd: clampHour(row.quietHoursEnd, DEFAULT_BOT_CONFIG.quietHoursEnd),
    digestIntervalMinutes: Math.max(5, Math.min(24 * 60, row.digestIntervalMinutes || 60)),
    weeklyReportEnabled: Boolean(row.weeklyReportEnabled),
    weeklyReportDay: Math.max(0, Math.min(6, row.weeklyReportDay ?? 6)),
    weeklyReportHour: clampHour(row.weeklyReportHour, 20),
    monthlyReportEnabled: Boolean(row.monthlyReportEnabled),
    monthlyReportHour: clampHour(row.monthlyReportHour, 20),
    lastWeeklySentOn: row.lastWeeklySentOn ?? null,
    lastMonthlySentOn: row.lastMonthlySentOn ?? null,
  };
}

export async function saveBotConfig(
  db: AppDb,
  input: Partial<BotConfigRow>,
  now = new Date(),
): Promise<BotConfigRow> {
  const current = await getBotConfig(db);
  const next: BotConfigRow = {
    ...current,
    ...input,
    defaultLanguage: isBotLanguage(input.defaultLanguage) ? input.defaultLanguage : current.defaultLanguage,
    quietHoursStart: clampHour(input.quietHoursStart ?? current.quietHoursStart, current.quietHoursStart),
    quietHoursEnd: clampHour(input.quietHoursEnd ?? current.quietHoursEnd, current.quietHoursEnd),
    digestIntervalMinutes: Math.max(
      5,
      Math.min(24 * 60, Math.trunc(input.digestIntervalMinutes ?? current.digestIntervalMinutes)),
    ),
    weeklyReportDay: Math.max(0, Math.min(6, Math.trunc(input.weeklyReportDay ?? current.weeklyReportDay))),
    weeklyReportHour: clampHour(input.weeklyReportHour ?? current.weeklyReportHour, current.weeklyReportHour),
    monthlyReportHour: clampHour(input.monthlyReportHour ?? current.monthlyReportHour, current.monthlyReportHour),
  };
  const timestamp = now.toISOString();
  await db
    .insert(telegramBotConfig)
    .values({
      id: "default",
      enabled: next.enabled,
      defaultLanguage: next.defaultLanguage,
      quietHoursStart: next.quietHoursStart,
      quietHoursEnd: next.quietHoursEnd,
      digestIntervalMinutes: next.digestIntervalMinutes,
      weeklyReportEnabled: next.weeklyReportEnabled,
      weeklyReportDay: next.weeklyReportDay,
      weeklyReportHour: next.weeklyReportHour,
      monthlyReportEnabled: next.monthlyReportEnabled,
      monthlyReportHour: next.monthlyReportHour,
      lastWeeklySentOn: next.lastWeeklySentOn,
      lastMonthlySentOn: next.lastMonthlySentOn,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: telegramBotConfig.id,
      set: {
        enabled: next.enabled,
        defaultLanguage: next.defaultLanguage,
        quietHoursStart: next.quietHoursStart,
        quietHoursEnd: next.quietHoursEnd,
        digestIntervalMinutes: next.digestIntervalMinutes,
        weeklyReportEnabled: next.weeklyReportEnabled,
        weeklyReportDay: next.weeklyReportDay,
        weeklyReportHour: next.weeklyReportHour,
        monthlyReportEnabled: next.monthlyReportEnabled,
        monthlyReportHour: next.monthlyReportHour,
        lastWeeklySentOn: next.lastWeeklySentOn,
        lastMonthlySentOn: next.lastMonthlySentOn,
        updatedAt: timestamp,
      },
    });
  return next;
}

// ─── Account links ───────────────────────────────────────────────────────────

export async function findLinkByTelegramId(db: AppDb, telegramUserId: string): Promise<TelegramLinkRow | null> {
  const row = await db
    .select()
    .from(telegramUserLinks)
    .where(and(eq(telegramUserLinks.telegramUserId, String(telegramUserId)), isNull(telegramUserLinks.revokedAt)))
    .get();
  return row ?? null;
}

export async function findLinkByChatId(db: AppDb, chatId: string): Promise<TelegramLinkRow | null> {
  const row = await db
    .select()
    .from(telegramUserLinks)
    .where(and(eq(telegramUserLinks.chatId, String(chatId)), isNull(telegramUserLinks.revokedAt)))
    .get();
  return row ?? null;
}

export async function loadLinkedUser(db: AppDb, link: TelegramLinkRow): Promise<LinkedUser | null> {
  const row = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      status: users.status,
      language: users.language,
    })
    .from(users)
    .where(eq(users.id, link.userId))
    .get();
  if (!row || row.status !== "active") return null;
  const scopes =
    row.role === "admin"
      ? ["*"]
      : (await db.select({ scope: userScopes.scope }).from(userScopes).where(eq(userScopes.userId, row.id)).all()).map(
          (item) => item.scope,
        );
  return { link, user: row, scopes };
}

export async function linkAccount(
  db: AppDb,
  input: {
    telegramUserId: string;
    chatId: string;
    userId: string;
    username?: string | null;
    firstName?: string | null;
    language?: BotLanguage;
  },
  now = new Date(),
): Promise<TelegramLinkRow> {
  const timestamp = now.toISOString();
  const existingForTelegram = await db
    .select({ userId: telegramUserLinks.userId })
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.telegramUserId, input.telegramUserId))
    .get();
  if (existingForTelegram && existingForTelegram.userId !== input.userId) {
    // Re-binding a Telegram account to a different CodFlow user revokes the
    // previous link instead of silently overwriting its audit identity.
    await db
      .update(telegramUserLinks)
      .set({ revokedAt: timestamp })
      .where(eq(telegramUserLinks.telegramUserId, input.telegramUserId));
  }
  await db
    .insert(telegramUserLinks)
    .values({
      telegramUserId: input.telegramUserId,
      chatId: input.chatId,
      userId: input.userId,
      username: input.username ?? null,
      firstName: input.firstName ?? null,
      language: input.language ?? "ar",
      linkedAt: timestamp,
      lastSeenAt: timestamp,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: telegramUserLinks.telegramUserId,
      set: {
        chatId: input.chatId,
        userId: input.userId,
        username: input.username ?? null,
        firstName: input.firstName ?? null,
        language: input.language ?? "ar",
        linkedAt: timestamp,
        lastSeenAt: timestamp,
        revokedAt: null,
      },
    });
  const link = await findLinkByTelegramId(db, input.telegramUserId);
  if (!link) throw new Error("Failed to persist Telegram link");
  return link;
}

export async function revokeLink(db: AppDb, telegramUserId: string, now = new Date()): Promise<boolean> {
  const existing = await findLinkByTelegramId(db, telegramUserId);
  if (!existing) return false;
  await db
    .update(telegramUserLinks)
    .set({ revokedAt: now.toISOString() })
    .where(eq(telegramUserLinks.telegramUserId, telegramUserId));
  return true;
}

export async function updateLink(
  db: AppDb,
  telegramUserId: string,
  patch: Partial<{
    language: BotLanguage;
    notifyOrders: boolean;
    notifyShipping: boolean;
    notifyStock: boolean;
    notifyFinance: boolean;
    notifySupport: boolean;
    notifyApprovals: boolean;
    notifyReports: boolean;
    digestMode: "instant" | "hourly" | "daily";
    mutedUntil: string | null;
    lastSeenAt: string;
  }>,
): Promise<TelegramLinkRow | null> {
  if (Object.keys(patch).length) {
    await db.update(telegramUserLinks).set(patch).where(eq(telegramUserLinks.telegramUserId, telegramUserId));
  }
  return findLinkByTelegramId(db, telegramUserId);
}

export async function touchLink(db: AppDb, telegramUserId: string, now = new Date()): Promise<void> {
  await db
    .update(telegramUserLinks)
    .set({ lastSeenAt: now.toISOString() })
    .where(eq(telegramUserLinks.telegramUserId, telegramUserId));
}

export async function listLinkedUsers(db: AppDb) {
  return db
    .select({
      telegramUserId: telegramUserLinks.telegramUserId,
      chatId: telegramUserLinks.chatId,
      userId: telegramUserLinks.userId,
      username: telegramUserLinks.username,
      firstName: telegramUserLinks.firstName,
      language: telegramUserLinks.language,
      digestMode: telegramUserLinks.digestMode,
      linkedAt: telegramUserLinks.linkedAt,
      lastSeenAt: telegramUserLinks.lastSeenAt,
      revokedAt: telegramUserLinks.revokedAt,
      userName: users.name,
      userEmail: users.email,
      userRole: users.role,
    })
    .from(telegramUserLinks)
    .leftJoin(users, eq(users.id, telegramUserLinks.userId))
    .orderBy(desc(telegramUserLinks.linkedAt))
    .all();
}

/** Links that should receive a given alert category (active + role-aware). */
export async function recipientsForCategory(
  db: AppDb,
  category: "orders" | "shipping" | "stock" | "finance" | "support" | "approvals" | "reports",
): Promise<Array<{ link: TelegramLinkRow; user: { id: string; role: string; name: string } }>> {
  const rows = await db
    .select({
      link: telegramUserLinks,
      userId: users.id,
      role: users.role,
      name: users.name,
      status: users.status,
    })
    .from(telegramUserLinks)
    .innerJoin(users, eq(users.id, telegramUserLinks.userId))
    .where(and(isNull(telegramUserLinks.revokedAt), eq(users.status, "active")))
    .all();

  return rows
    .filter((row) => roleCanReceive(category, row.role))
    .filter((row) => isCategoryEnabled(row.link, category))
    .map((row) => ({ link: row.link, user: { id: row.userId, role: row.role, name: row.name } }));
}

export function isCategoryEnabled(link: TelegramLinkRow, category: string): boolean {
  switch (category) {
    case "orders":
      return link.notifyOrders;
    case "shipping":
      return link.notifyShipping;
    case "stock":
      return link.notifyStock;
    case "finance":
      return link.notifyFinance;
    case "support":
      return link.notifySupport;
    case "approvals":
      return link.notifyApprovals;
    case "reports":
      return link.notifyReports;
    default:
      return false;
  }
}

/**
 * Which roles are interested in a category. Keeps operators from receiving
 * payroll details and keeps drivers out of the approvals inbox.
 */
export function roleCanReceive(category: string, role: string): boolean {
  if (role === "admin") return true;
  switch (category) {
    case "approvals":
    case "finance":
      return false; // admin-only by design
    case "orders":
    case "shipping":
      return role === "staff" || role === "confirmer" || role === "driver";
    case "stock":
      return role === "staff";
    case "support":
      return role === "staff";
    case "reports":
      return role === "staff" || role === "confirmer";
    default:
      return false;
  }
}

// ─── One-time link codes ─────────────────────────────────────────────────────

const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateLinkCode(random: () => number = Math.random): string {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += LINK_CODE_ALPHABET[Math.floor(random() * LINK_CODE_ALPHABET.length)];
  }
  return code;
}

export async function createLinkCode(
  db: AppDb,
  input: { userId: string; createdBy: string | null; ttlMinutes?: number },
  now = new Date(),
) {
  const ttl = Math.max(5, Math.min(input.ttlMinutes ?? 60, 24 * 60));
  const code = generateLinkCode();
  const expiresAt = new Date(now.getTime() + ttl * 60_000).toISOString();
  await db.insert(telegramLinkCodes).values({
    code,
    userId: input.userId,
    createdBy: input.createdBy,
    expiresAt,
    createdAt: now.toISOString(),
  });
  return { code, expiresAt };
}

export async function peekLinkCode(db: AppDb, code: string) {
  return db.select().from(telegramLinkCodes).where(eq(telegramLinkCodes.code, code.trim().toUpperCase())).get();
}

export async function markLinkCodeUsed(
  db: AppDb,
  code: string,
  telegramUserId: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(telegramLinkCodes)
    .set({ usedAt: now.toISOString(), usedByTelegramId: telegramUserId })
    .where(eq(telegramLinkCodes.code, code));
}

// ─── Conversation state ──────────────────────────────────────────────────────

export type SessionState =
  | "idle"
  | "awaiting_link_code"
  | "awaiting_order_search"
  | "awaiting_rejection_reason"
  | "awaiting_customer_search"
  | "awaiting_unlink_confirm";

export interface SessionPayload {
  approvalId?: string;
  orderId?: string;
  customerId?: string;
  filter?: string;
  page?: number;
}

export async function getSession(db: AppDb, telegramUserId: string) {
  const row = await db
    .select()
    .from(telegramBotSessions)
    .where(eq(telegramBotSessions.telegramUserId, telegramUserId))
    .get();
  let payload: SessionPayload = {};
  try {
    payload = row?.payload ? (JSON.parse(row.payload) as SessionPayload) : {};
  } catch {
    payload = {};
  }
  return { state: (row?.state ?? "idle") as SessionState, payload };
}

export async function setSession(
  db: AppDb,
  telegramUserId: string,
  state: SessionState,
  payload: SessionPayload = {},
  now = new Date(),
): Promise<void> {
  await db
    .insert(telegramBotSessions)
    .values({
      telegramUserId,
      state,
      payload: JSON.stringify(payload),
      updatedAt: now.toISOString(),
    })
    .onConflictDoUpdate({
      target: telegramBotSessions.telegramUserId,
      set: { state, payload: JSON.stringify(payload), updatedAt: now.toISOString() },
    });
}

export async function clearSession(db: AppDb, telegramUserId: string): Promise<void> {
  await setSession(db, telegramUserId, "idle", {});
}

// ─── Update dedupe ───────────────────────────────────────────────────────────

/**
 * Reserves an update id. Returns false when the update was already processed
 * (Telegram retries the same update when the webhook is slow).
 */
export async function claimUpdate(
  db: AppDb,
  updateId: number | string | undefined,
  telegramUserId: string | null,
  kind: string,
  now = new Date(),
): Promise<boolean> {
  if (updateId == null) return true;
  const id = String(updateId);
  // Atomic claim: the INSERT either wins or conflicts. Reading first would let
  // two concurrent deliveries both proceed and apply a status change twice.
  const inserted = await db
    .insert(telegramUpdateLog)
    .values({ updateId: id, telegramUserId, kind, receivedAt: now.toISOString() })
    .onConflictDoNothing()
    .returning({ updateId: telegramUpdateLog.updateId })
    .all();
  return inserted.length > 0;
}

/** Keeps the dedupe table from growing forever. */
export async function pruneBotHousekeeping(db: AppDb, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
  await db.delete(telegramUpdateLog).where(sql`${telegramUpdateLog.receivedAt} < ${cutoff}`);
  await db.delete(telegramDigestQueue).where(sql`${telegramDigestQueue.sentAt} IS NOT NULL AND ${telegramDigestQueue.sentAt} < ${cutoff}`);
  await db
    .delete(telegramLinkCodes)
    .where(sql`${telegramLinkCodes.expiresAt} < ${new Date(now.getTime() - 24 * 3_600_000).toISOString()}`);
}

// ─── Audit events ────────────────────────────────────────────────────────────

export async function recordBotEvent(
  db: AppDb,
  input: {
    telegramUserId?: string | null;
    userId?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    status?: "ok" | "denied" | "failed";
    detail?: string | null;
  },
  now = new Date(),
): Promise<void> {
  await db.insert(telegramBotEvents).values({
    id: crypto.randomUUID(),
    telegramUserId: input.telegramUserId ?? null,
    userId: input.userId ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    status: input.status ?? "ok",
    detail: input.detail ?? null,
    createdAt: now.toISOString(),
  });
}

export async function listBotEvents(db: AppDb, limit = 50) {
  return db
    .select({
      id: telegramBotEvents.id,
      telegramUserId: telegramBotEvents.telegramUserId,
      userId: telegramBotEvents.userId,
      action: telegramBotEvents.action,
      targetType: telegramBotEvents.targetType,
      targetId: telegramBotEvents.targetId,
      status: telegramBotEvents.status,
      detail: telegramBotEvents.detail,
      createdAt: telegramBotEvents.createdAt,
      userName: users.name,
    })
    .from(telegramBotEvents)
    .leftJoin(users, eq(users.id, telegramBotEvents.userId))
    .orderBy(desc(telegramBotEvents.createdAt))
    .limit(Math.max(1, Math.min(limit, 200)))
    .all();
}

// ─── Digest queue ────────────────────────────────────────────────────────────

export async function queueDigest(
  db: AppDb,
  input: { telegramUserId: string; kind: string; text: string },
  now = new Date(),
): Promise<void> {
  await db.insert(telegramDigestQueue).values({
    id: crypto.randomUUID(),
    telegramUserId: input.telegramUserId,
    kind: input.kind,
    text: input.text,
    createdAt: now.toISOString(),
  });
}

export async function pendingDigest(
  db: AppDb,
  telegramUserId: string,
  limit = 20,
): Promise<Array<{ id: string; kind: string; text: string; createdAt: string }>> {
  return db
    .select({
      id: telegramDigestQueue.id,
      kind: telegramDigestQueue.kind,
      text: telegramDigestQueue.text,
      createdAt: telegramDigestQueue.createdAt,
    })
    .from(telegramDigestQueue)
    .where(and(eq(telegramDigestQueue.telegramUserId, telegramUserId), isNull(telegramDigestQueue.sentAt)))
    .orderBy(asc(telegramDigestQueue.createdAt))
    .limit(limit)
    .all();
}

export async function markDigestSent(db: AppDb, ids: string[], now = new Date()): Promise<void> {
  if (!ids.length) return;
  const timestamp = now.toISOString();
  for (const id of ids) {
    await db.update(telegramDigestQueue).set({ sentAt: timestamp }).where(eq(telegramDigestQueue.id, id));
  }
}

// ─── Alert dedupe ────────────────────────────────────────────────────────────

/**
 * True when the alert key may be sent now. `minIntervalMinutes` prevents the
 * hourly cron from repeating the same stuck-shipment notice.
 */
export async function shouldSendAlert(
  db: AppDb,
  key: string,
  minIntervalMinutes: number,
  now = new Date(),
): Promise<boolean> {
  const row = await db.select().from(telegramAlertState).where(eq(telegramAlertState.key, key)).get();
  if (!row) return true;
  return now.getTime() - new Date(row.lastSentAt).getTime() >= minIntervalMinutes * 60_000;
}

export async function markAlertSent(
  db: AppDb,
  key: string,
  severity: "info" | "warning" | "critical",
  detail: string | null = null,
  now = new Date(),
): Promise<void> {
  await db
    .insert(telegramAlertState)
    .values({ key, severity, lastSentAt: now.toISOString(), detail })
    .onConflictDoUpdate({
      target: telegramAlertState.key,
      set: { severity, lastSentAt: now.toISOString(), detail },
    });
}
