/**
 * Customer blacklist queries.
 *
 * The blacklist is the merchant's "never again" list: phones and IPs that keep
 * returning parcels, ordering fraudulently, or abusing the confirmation line.
 *
 * Enforcement model — DERIVED, not copied:
 *   • an order is blacklisted when its phone (or the shopper's IP) matches an
 *     `active` row here, so lifting a ban instantly stops flagging that
 *     customer's entire order history;
 *   • a blacklisted order is still created (the merchant wants the record and
 *     the evidence) but is skipped by confirmation auto-assignment, so it never
 *     lands in a confirmer's queue;
 *   • every creation that matches bumps `hit_count` / `last_hit_at`, which is
 *     how the merchant sees what a ban actually saved.
 *
 * `value` is always the canonical match key. For phones that is the local
 * Algerian mobile form ("0551234567") — the same shape orders.phone is
 * validated into on both the storefront and dashboard paths, which is what
 * makes an exact-match lookup correct (and index-backed).
 */

import { and, desc, eq, like, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { customerBlacklist, users } from "../db/schema";
import type { AppDb } from "../db/client";
import { toLocalAlgerianMobile } from "../lib/phone";

// ─── Reusable SQL fragments ───────────────────────────────────────────────────
// The badge on an orders-list row, the flag on an order detail, and the
// confirmation auto-assign exclusion all ask the same question. Keeping the SQL
// in one place is what stops those three answers from drifting apart.

/** 1 when an active ban covers this phone column, else 0. */
export function blacklistedFlag(phone: SQLWrapper): SQL<number> {
  return sql`EXISTS (SELECT 1 FROM customer_blacklist bl WHERE bl.status = 'active' AND bl.kind = 'phone' AND bl.value = ${phone})`;
}

/** The reason on the newest active ban for this phone (null = not banned). */
export function blacklistReasonSubselect(phone: SQLWrapper): SQL<string | null> {
  return sql`(SELECT bl.reason FROM customer_blacklist bl WHERE bl.status = 'active' AND bl.kind = 'phone' AND bl.value = ${phone} ORDER BY bl.created_at DESC LIMIT 1)`;
}

/** WHERE-able guard: no active ban covers this phone. */
export function notBlacklistedPhone(phone: SQLWrapper): SQL<unknown> {
  return sql`NOT EXISTS (SELECT 1 FROM customer_blacklist bl WHERE bl.status = 'active' AND bl.kind = 'phone' AND bl.value = ${phone})`;
}

export type BlacklistKind = "phone" | "ip";
export type BlacklistStatus = "active" | "lifted";

export interface BlacklistFilters {
  kind?: BlacklistKind | "all";
  status?: BlacklistStatus | "all";
  search?: string;
  limit?: number;
  offset?: number;
}

export interface BlacklistEntryInput {
  kind: BlacklistKind;
  value: string;
  reason?: string | null;
  createdBy?: string | null;
  createdAt?: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

function normalizeIp(raw: string): string | null {
  // Strip an optional ":port" suffix and IPv6 zone/brackets — merchants copy
  // IPs out of logs, and "1.2.3.4:52344" must still ban "1.2.3.4".
  let value = raw.trim().replace(/^\[|\]$/g, "");
  const v4WithPort = value.match(IPV4);
  if (!v4WithPort) {
    const portSplit = value.match(/^(.*):(\d{1,5})$/);
    if (portSplit && portSplit[1].includes(".")) value = portSplit[1];
  }
  if (IPV4.test(value)) {
    return value
      .split(".")
      .every((octet) => Number(octet) <= 255)
      ? value
      : null;
  }
  if (value.includes(":") && IPV6.test(value) && value.length <= 45) {
    return value.toLowerCase();
  }
  return null;
}

/**
 * Canonical match key for a ban, or null when the input cannot identify a
 * customer. Rejecting here (rather than storing garbage) is the point: a
 * blacklist row that can never match is worse than no row, because the
 * merchant believes they are protected.
 */
export function blacklistMatchKey(
  kind: BlacklistKind,
  raw: string,
): string | null {
  if (typeof raw !== "string") return null;
  return kind === "phone" ? toLocalAlgerianMobile(raw) : normalizeIp(raw);
}

/**
 * The active ban covering this phone / IP, if any. Both keys may be supplied —
 * the storefront knows the shopper's IP, the dashboard usually only the phone.
 * Phone is checked first: it is the stronger signal.
 */
export async function findActiveBlacklistEntry(
  db: AppDb,
  match: { phone?: string | null; ip?: string | null },
) {
  const phone = match.phone ? toLocalAlgerianMobile(match.phone) : null;
  const ip = match.ip ? normalizeIp(match.ip) : null;
  if (!phone && !ip) return null;

  const conditions = [eq(customerBlacklist.status, "active")];
  const keyConditions = [];
  if (phone) {
    keyConditions.push(
      and(eq(customerBlacklist.kind, "phone"), eq(customerBlacklist.value, phone)),
    );
  }
  if (ip) {
    keyConditions.push(
      and(eq(customerBlacklist.kind, "ip"), eq(customerBlacklist.value, ip)),
    );
  }

  return (
    (await db
      .select()
      .from(customerBlacklist)
      .where(and(...conditions, or(...keyConditions)))
      .orderBy(desc(customerBlacklist.createdAt))
      .limit(1)
      .get()) ?? null
  );
}

/**
 * Blacklist reasons for a batch of phones — one query for a whole list page.
 * Returns a map of canonical phone → reason, so the orders list can badge rows
 * without an N+1 lookup.
 */
export async function findActiveBlacklistReasonsByPhone(
  db: AppDb,
  phones: string[],
): Promise<Map<string, string>> {
  const keys = [
    ...new Set(
      phones
        .map((phone) => toLocalAlgerianMobile(phone))
        .filter((phone): phone is string => Boolean(phone)),
    ),
  ];
  if (keys.length === 0) return new Map();

  const rows = await db
    .select({
      value: customerBlacklist.value,
      reason: customerBlacklist.reason,
    })
    .from(customerBlacklist)
    .where(
      and(
        eq(customerBlacklist.status, "active"),
        eq(customerBlacklist.kind, "phone"),
        sql`${customerBlacklist.value} IN (${sql.join(
          keys.map((key) => sql`${key}`),
          sql`, `,
        )})`,
      ),
    )
    .all();

  return new Map(rows.map((row) => [row.value, row.reason ?? ""]));
}

export async function listBlacklist(db: AppDb, filters: BlacklistFilters = {}) {
  const conditions = [];
  if (filters.kind && filters.kind !== "all") {
    conditions.push(eq(customerBlacklist.kind, filters.kind));
  }
  if (filters.status && filters.status !== "all") {
    conditions.push(eq(customerBlacklist.status, filters.status));
  } else {
    conditions.push(eq(customerBlacklist.status, "active"));
  }
  if (filters.search) {
    const term = `%${filters.search.replace(/[%_]/g, "")}%`;
    conditions.push(
      or(
        like(customerBlacklist.value, term),
        like(customerBlacklist.rawValue, term),
        like(customerBlacklist.reason, term),
      )!,
    );
  }

  const where = and(...conditions);
  const [rows, countRows] = await db.batch([
    db
      .select({
        id: customerBlacklist.id,
        kind: customerBlacklist.kind,
        value: customerBlacklist.value,
        rawValue: customerBlacklist.rawValue,
        reason: customerBlacklist.reason,
        status: customerBlacklist.status,
        hitCount: customerBlacklist.hitCount,
        lastHitAt: customerBlacklist.lastHitAt,
        createdAt: customerBlacklist.createdAt,
        liftedAt: customerBlacklist.liftedAt,
        liftedReason: customerBlacklist.liftedReason,
        createdByName: users.name,
      })
      .from(customerBlacklist)
      .leftJoin(users, eq(customerBlacklist.createdBy, users.id))
      .where(where)
      .orderBy(desc(customerBlacklist.createdAt))
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    db
      .select({ count: sql<number>`count(*)` })
      .from(customerBlacklist)
      .where(where),
  ]);

  return { rows, total: countRows[0]?.count ?? 0 };
}

export async function getBlacklistEntry(db: AppDb, id: string) {
  return (
    (await db
      .select()
      .from(customerBlacklist)
      .where(eq(customerBlacklist.id, id))
      .get()) ?? null
  );
}

/**
 * Add a ban. Idempotent by design: re-banning a value that is already active
 * refreshes the reason instead of violating the partial unique index, and a
 * value that was previously lifted gets a fresh row (the old one stays as the
 * audit trail of the first ban).
 */
export async function addBlacklistEntry(db: AppDb, input: BlacklistEntryInput) {
  const value = blacklistMatchKey(input.kind, input.value);
  if (!value) return { error: "invalid_value" as const, entry: null };

  const now = input.createdAt ?? new Date().toISOString();

  const existing = await db
    .select()
    .from(customerBlacklist)
    .where(
      and(
        eq(customerBlacklist.kind, input.kind),
        eq(customerBlacklist.value, value),
        eq(customerBlacklist.status, "active"),
      ),
    )
    .get();

  if (existing) {
    await db
      .update(customerBlacklist)
      .set({ reason: input.reason ?? existing.reason })
      .where(eq(customerBlacklist.id, existing.id));
    return { error: null, entry: { ...existing, reason: input.reason ?? existing.reason }, alreadyActive: true };
  }

  const id = crypto.randomUUID();
  await db.insert(customerBlacklist).values({
    id,
    kind: input.kind,
    value,
    rawValue: input.value.trim(),
    reason: input.reason ?? null,
    status: "active",
    hitCount: 0,
    lastHitAt: null,
    createdBy: input.createdBy ?? null,
    createdAt: now,
  });

  return { error: null, entry: await getBlacklistEntry(db, id), alreadyActive: false };
}

/** Lift a ban — keeps the row (who banned, who lifted, why, how many hits). */
export async function liftBlacklistEntry(
  db: AppDb,
  id: string,
  opts: { reason?: string | null; liftedBy?: string | null; liftedAt?: string } = {},
) {
  const existing = await getBlacklistEntry(db, id);
  if (!existing) return { error: "not_found" as const, entry: null };
  if (existing.status === "lifted") return { error: null, entry: existing };

  await db
    .update(customerBlacklist)
    .set({
      status: "lifted",
      liftedAt: opts.liftedAt ?? new Date().toISOString(),
      liftedBy: opts.liftedBy ?? null,
      liftedReason: opts.reason ?? null,
    })
    .where(eq(customerBlacklist.id, id));

  return { error: null, entry: await getBlacklistEntry(db, id) };
}

/** Edit the reason on a live ban (typo / more detail after a call). */
export async function updateBlacklistReason(
  db: AppDb,
  id: string,
  reason: string | null,
) {
  const existing = await getBlacklistEntry(db, id);
  if (!existing) return { error: "not_found" as const, entry: null };
  await db
    .update(customerBlacklist)
    .set({ reason })
    .where(eq(customerBlacklist.id, id));
  return { error: null, entry: await getBlacklistEntry(db, id) };
}

/** Hard-delete a row — for entries added by mistake, not for unbanning. */
export async function deleteBlacklistEntry(db: AppDb, id: string) {
  const existing = await getBlacklistEntry(db, id);
  if (!existing) return false;
  await db.delete(customerBlacklist).where(eq(customerBlacklist.id, id));
  return true;
}

/** Count an order that was placed despite the ban (fire-and-forget audit). */
export async function recordBlacklistHit(
  db: AppDb,
  entryId: string,
  at: string = new Date().toISOString(),
) {
  await db
    .update(customerBlacklist)
    .set({
      hitCount: sql`${customerBlacklist.hitCount} + 1`,
      lastHitAt: at,
    })
    .where(eq(customerBlacklist.id, entryId));
}
