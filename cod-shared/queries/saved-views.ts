/**
 * Saved views — named list state stored server-side.
 *
 * Two kinds share one table:
 *   • "orders-filter"   — a filter/sort preset ("طلبات وهران غير المؤكدة").
 *   • "export-template" — a carrier file preset: which columns, in which
 *     order, with which header wording, optionally bound to one carrier.
 *
 * Server-side storage (rather than localStorage) is what makes a view
 * shareable with the team and durable across devices: `shared = 1` publishes
 * it to everyone who can read orders, and the owner name travels with the row
 * so a confirmer knows whose preset they just applied.
 */

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { deliveryCompanies, savedViews, users } from "../db/schema";
import type { AppDb } from "../db/client";

export type SavedViewKind = "orders-filter" | "export-template";
export type SavedViewSortDirection = "asc" | "desc";

export interface SavedViewRow {
  id: string;
  kind: SavedViewKind;
  name: string;
  ownerId: string;
  ownerName: string | null;
  shared: boolean;
  filters: Record<string, unknown>;
  sortKey: string | null;
  sortDirection: SavedViewSortDirection | null;
  columns: string[] | null;
  headers: Record<string, string> | null;
  carrierId: string | null;
  carrierName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedViewInput {
  kind: SavedViewKind;
  name: string;
  ownerId: string;
  shared?: boolean;
  filters?: Record<string, unknown>;
  sortKey?: string | null;
  sortDirection?: SavedViewSortDirection | null;
  columns?: string[] | null;
  headers?: Record<string, string> | null;
  carrierId?: string | null;
}

/** Parse a JSON text column, falling back instead of throwing on bad data. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function toViewRow(row: {
  id: string;
  kind: string;
  name: string;
  ownerId: string;
  shared: boolean;
  filters: string;
  sortKey: string | null;
  sortDirection: string | null;
  columns: string | null;
  headers: string | null;
  carrierId: string | null;
  createdAt: string;
  updatedAt: string;
  ownerName?: string | null;
  carrierName?: string | null;
}): SavedViewRow {
  return {
    id: row.id,
    kind: row.kind as SavedViewKind,
    name: row.name,
    ownerId: row.ownerId,
    ownerName: row.ownerName ?? null,
    shared: Boolean(row.shared),
    filters: parseJson<Record<string, unknown>>(row.filters, {}),
    sortKey: row.sortKey,
    sortDirection: (row.sortDirection as SavedViewSortDirection | null) ?? null,
    columns: row.columns ? parseJson<string[] | null>(row.columns, null) : null,
    headers: row.headers
      ? parseJson<Record<string, string> | null>(row.headers, null)
      : null,
    carrierId: row.carrierId,
    carrierName: row.carrierName ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const viewSelection = {
  id: savedViews.id,
  kind: savedViews.kind,
  name: savedViews.name,
  ownerId: savedViews.ownerId,
  shared: savedViews.shared,
  filters: savedViews.filters,
  sortKey: savedViews.sortKey,
  sortDirection: savedViews.sortDirection,
  columns: savedViews.columns,
  headers: savedViews.headers,
  carrierId: savedViews.carrierId,
  createdAt: savedViews.createdAt,
  updatedAt: savedViews.updatedAt,
  ownerName: users.name,
  carrierName: deliveryCompanies.name,
};

/**
 * Everything a user may apply: their own views plus the team's shared ones.
 * `admin` sees the same set — sharing, not role, decides visibility.
 */
export async function listSavedViews(
  db: AppDb,
  opts: { kind: SavedViewKind; userId: string; limit?: number },
): Promise<SavedViewRow[]> {
  const rows = await db
    .select(viewSelection)
    .from(savedViews)
    .leftJoin(users, eq(savedViews.ownerId, users.id))
    .leftJoin(deliveryCompanies, eq(savedViews.carrierId, deliveryCompanies.id))
    .where(
      and(
        eq(savedViews.kind, opts.kind),
        or(eq(savedViews.ownerId, opts.userId), eq(savedViews.shared, true)),
      ),
    )
    .orderBy(desc(savedViews.shared), desc(savedViews.updatedAt))
    .limit(opts.limit ?? 100)
    .all();

  return rows.map(toViewRow);
}

export async function getSavedView(
  db: AppDb,
  id: string,
): Promise<SavedViewRow | null> {
  const row = await db
    .select(viewSelection)
    .from(savedViews)
    .leftJoin(users, eq(savedViews.ownerId, users.id))
    .leftJoin(deliveryCompanies, eq(savedViews.carrierId, deliveryCompanies.id))
    .where(eq(savedViews.id, id))
    .get();

  return row ? toViewRow(row) : null;
}

export async function createSavedView(
  db: AppDb,
  input: SavedViewInput,
): Promise<SavedViewRow | null> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(savedViews).values({
    id,
    kind: input.kind,
    name: input.name.trim(),
    ownerId: input.ownerId,
    shared: input.shared ?? false,
    filters: JSON.stringify(input.filters ?? {}),
    sortKey: input.sortKey ?? null,
    sortDirection: input.sortDirection ?? null,
    columns: input.columns ? JSON.stringify(input.columns) : null,
    headers: input.headers ? JSON.stringify(input.headers) : null,
    carrierId: input.carrierId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return getSavedView(db, id);
}

export interface SavedViewUpdate {
  name?: string;
  shared?: boolean;
  filters?: Record<string, unknown>;
  sortKey?: string | null;
  sortDirection?: SavedViewSortDirection | null;
  columns?: string[] | null;
  headers?: Record<string, string> | null;
  carrierId?: string | null;
}

export async function updateSavedView(
  db: AppDb,
  id: string,
  patch: SavedViewUpdate,
): Promise<SavedViewRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.shared !== undefined) set.shared = patch.shared;
  if (patch.filters !== undefined) set.filters = JSON.stringify(patch.filters);
  if (patch.sortKey !== undefined) set.sortKey = patch.sortKey;
  if (patch.sortDirection !== undefined) set.sortDirection = patch.sortDirection;
  if (patch.columns !== undefined) {
    set.columns = patch.columns ? JSON.stringify(patch.columns) : null;
  }
  if (patch.headers !== undefined) {
    set.headers = patch.headers ? JSON.stringify(patch.headers) : null;
  }
  if (patch.carrierId !== undefined) set.carrierId = patch.carrierId;

  await db.update(savedViews).set(set).where(eq(savedViews.id, id));
  return getSavedView(db, id);
}

export async function deleteSavedView(db: AppDb, id: string): Promise<boolean> {
  const existing = await db
    .select({ id: savedViews.id })
    .from(savedViews)
    .where(eq(savedViews.id, id))
    .get();
  if (!existing) return false;
  await db.delete(savedViews).where(eq(savedViews.id, id));
  return true;
}

/** Does this name already exist for the same owner + kind? (friendly errors) */
export async function savedViewNameTaken(
  db: AppDb,
  opts: { kind: SavedViewKind; ownerId: string; name: string; exceptId?: string },
): Promise<boolean> {
  const conditions = [
    eq(savedViews.kind, opts.kind),
    eq(savedViews.ownerId, opts.ownerId),
    sql`lower(${savedViews.name}) = lower(${opts.name.trim()})`,
  ];
  if (opts.exceptId) {
    conditions.push(sql`${savedViews.id} <> ${opts.exceptId}`);
  }
  const row = await db
    .select({ id: savedViews.id })
    .from(savedViews)
    .where(and(...conditions))
    .get();
  return Boolean(row);
}

/** Resolve several views at once (used by the export dialog's template list). */
export async function getSavedViewsByIds(
  db: AppDb,
  ids: string[],
): Promise<SavedViewRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(viewSelection)
    .from(savedViews)
    .leftJoin(users, eq(savedViews.ownerId, users.id))
    .leftJoin(deliveryCompanies, eq(savedViews.carrierId, deliveryCompanies.id))
    .where(inArray(savedViews.id, ids))
    .all();
  return rows.map(toViewRow);
}
