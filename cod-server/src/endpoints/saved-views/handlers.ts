/**
 * Saved Views Handlers
 *
 * Ownership model: everyone who can read orders sees their own views plus the
 * team's shared ones; only the owner (or an admin) may edit or delete a view.
 * Sharing is a property of the row, not a separate permission — a confirmer who
 * saves "my unreachable calls today" and shares it saves the next shift a
 * question, and nobody's data is exposed because a view is only filters.
 */

import { Context } from "hono";
import type { AppContext } from "@/types";
import type { AuthUser } from "@/types";
import { getDb } from "@/db";
import * as queries from "../../../../cod-shared/queries/saved-views";
import type { SavedViewRow } from "../../../../cod-shared/queries/saved-views";
import * as validation from "./validation";
import { ConflictError, NotFoundError, PermissionError, SystemError } from "@/lib/errors/classes";
import { ERROR_CODES } from "../../../../cod-shared/errors/codes";

function canManage(view: SavedViewRow, actor: AuthUser | undefined): boolean {
  if (!actor) return false;
  return actor.role === "admin" || view.ownerId === actor.id;
}

/** GET /saved-views?kind=orders-filter */
export async function listSavedViews(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const queryData: any = (c.req as any).valid?.("query");
  const filters =
    queryData ??
    validation.savedViewFiltersQuerySchema.parse({
      kind: c.req.query("kind"),
      limit: c.req.query("limit"),
    });

  const rows = await queries.listSavedViews(db, {
    kind: filters.kind ?? "orders-filter",
    userId: actor.id,
    limit: filters.limit ?? 100,
  });

  return c.json({ success: true, data: rows, count: rows.length }, 200);
}

/** GET /saved-views/:id */
export async function getSavedView(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const id = c.req.param("id")!;

  const view = await queries.getSavedView(db, id);
  if (!view) throw new NotFoundError("Saved view", id);
  // A private view is invisible to everyone but its owner and admins — same
  // 404 the list would give, so existence is not leaked either.
  if (!view.shared && !canManage(view, actor)) {
    throw new NotFoundError("Saved view", id);
  }

  return c.json({ success: true, data: view }, 200);
}

/** POST /saved-views */
export async function createSavedView(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const bodyData: any = (c.req as any).valid?.("json");
  const validated: validation.CreateSavedViewInput =
    bodyData ?? validation.createSavedViewSchema.parse(await c.req.json());

  const taken = await queries.savedViewNameTaken(db, {
    kind: validated.kind,
    ownerId: actor.id,
    name: validated.name,
  });
  if (taken) {
    throw new ConflictError(
      `You already have a ${validated.kind} named "${validated.name}"`,
      ERROR_CODES.DUPLICATE_ENTITY,
      { name: validated.name, kind: validated.kind },
    );
  }

  const view = await queries.createSavedView(db, {
    kind: validated.kind,
    name: validated.name,
    ownerId: actor.id,
    shared: validated.shared ?? false,
    filters: validated.filters ?? {},
    sortKey: validated.sortKey ?? null,
    sortDirection: validated.sortDirection ?? null,
    columns: validated.columns ?? null,
    headers: validated.headers ?? null,
    carrierId: validated.carrierId ?? null,
  });

  if (!view) throw new SystemError("Failed to save the view");
  return c.json({ success: true, data: view, message: "View saved" }, 201);
}

/** PATCH /saved-views/:id */
export async function updateSavedView(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const id = c.req.param("id")!;
  const bodyData: any = (c.req as any).valid?.("json");
  const validated: validation.UpdateSavedViewInput =
    bodyData ?? validation.updateSavedViewSchema.parse(await c.req.json());

  const existing = await queries.getSavedView(db, id);
  if (!existing) throw new NotFoundError("Saved view", id);
  if (!canManage(existing, actor)) {
    throw new PermissionError("Only the owner of a view can change it");
  }

  if (validated.name && validated.name !== existing.name) {
    const taken = await queries.savedViewNameTaken(db, {
      kind: existing.kind,
      ownerId: existing.ownerId,
      name: validated.name,
      exceptId: id,
    });
    if (taken) {
      throw new ConflictError(
        `You already have a ${existing.kind} named "${validated.name}"`,
        ERROR_CODES.DUPLICATE_ENTITY,
        { name: validated.name },
      );
    }
  }

  const view = await queries.updateSavedView(db, id, {
    ...(validated.name !== undefined ? { name: validated.name } : {}),
    ...(validated.shared !== undefined ? { shared: validated.shared } : {}),
    ...(validated.filters !== undefined ? { filters: validated.filters } : {}),
    ...(validated.sortKey !== undefined ? { sortKey: validated.sortKey } : {}),
    ...(validated.sortDirection !== undefined
      ? { sortDirection: validated.sortDirection }
      : {}),
    ...(validated.columns !== undefined ? { columns: validated.columns } : {}),
    ...(validated.headers !== undefined ? { headers: validated.headers } : {}),
    ...(validated.carrierId !== undefined ? { carrierId: validated.carrierId } : {}),
  });

  return c.json({ success: true, data: view, message: "View updated" }, 200);
}

/** DELETE /saved-views/:id */
export async function deleteSavedView(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const id = c.req.param("id")!;

  const existing = await queries.getSavedView(db, id);
  if (!existing) throw new NotFoundError("Saved view", id);
  if (!canManage(existing, actor)) {
    throw new PermissionError("Only the owner of a view can delete it");
  }

  await queries.deleteSavedView(db, id);
  return c.json({ success: true, message: "View deleted" }, 200);
}
