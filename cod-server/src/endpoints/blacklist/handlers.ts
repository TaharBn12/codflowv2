/**
 * Blacklist Handlers
 *
 * HTTP layer for the customer blacklist. The rules live in
 * `cod-shared/queries/blacklist.ts` so order creation (storefront + dashboard +
 * import) enforces exactly the same list this endpoint manages.
 */

import { Context } from "hono";
import type { AppContext } from "@/types";
import { getDb } from "@/db";
import * as queries from "../../../../cod-shared/queries/blacklist";
import * as validation from "./validation";
import { logActivity, ACTIONS } from "@/lib/activity";
import { NotFoundError, ValidationError } from "@/lib/errors/classes";
import { ERROR_CODES } from "../../../../cod-shared/errors/codes";

/** GET /blacklist */
export async function listBlacklist(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const queryData: any = (c.req as any).valid?.("query");
  const filters =
    queryData ??
    validation.blacklistFiltersSchema.parse({
      kind: c.req.query("kind"),
      status: c.req.query("status"),
      search: c.req.query("search"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });

  const { rows, total } = await queries.listBlacklist(db, filters);
  return c.json({ success: true, data: rows, count: rows.length, total }, 200);
}

/**
 * GET /blacklist/check?phone=…&ip=…
 *
 * The instant warning behind the manual order form and the customer profile:
 * "this number is banned, here is why". Read-only and cheap enough to call on
 * every keystroke pause.
 */
export async function checkBlacklist(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const queryData: any = (c.req as any).valid?.("query");
  const input =
    queryData ??
    validation.blacklistCheckSchema.parse({
      phone: c.req.query("phone"),
      ip: c.req.query("ip"),
    });

  const entry = await queries.findActiveBlacklistEntry(db, {
    phone: input.phone ?? null,
    ip: input.ip ?? null,
  });

  return c.json(
    {
      success: true,
      data: {
        blacklisted: Boolean(entry),
        kind: entry?.kind ?? null,
        value: entry?.value ?? null,
        reason: entry?.reason ?? null,
        bannedAt: entry?.createdAt ?? null,
        hitCount: entry?.hitCount ?? 0,
      },
    },
    200,
  );
}

/** POST /blacklist */
export async function addBlacklistEntry(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const bodyData: any = (c.req as any).valid?.("json");
  const validated: validation.CreateBlacklistEntryInput =
    bodyData ?? validation.createBlacklistEntrySchema.parse(await c.req.json());

  const canonical = queries.blacklistMatchKey(validated.kind, validated.value);
  if (!canonical) {
    throw new ValidationError(
      validated.kind === "phone"
        ? "Value is not a valid Algerian mobile number"
        : "Value is not a valid IP address",
      validated.kind === "phone"
        ? ERROR_CODES.INVALID_PHONE_FORMAT
        : ERROR_CODES.INVALID_FORMAT,
      { kind: validated.kind, value: validated.value },
    );
  }

  const actor = c.get("user");
  const result = await queries.addBlacklistEntry(db, {
    kind: validated.kind,
    value: validated.value,
    reason: validated.reason ?? null,
    createdBy: actor?.id ?? null,
  });

  if (result.error || !result.entry) {
    throw new ValidationError(
      "Could not store this blacklist entry",
      ERROR_CODES.INVALID_FORMAT,
      { kind: validated.kind, value: validated.value },
    );
  }

  await logActivity(
    db,
    actor,
    ACTIONS.BLACKLIST_ENTRY_ADDED,
    { type: "customer", id: result.entry.id, label: result.entry.value },
    { kind: result.entry.kind, reason: result.entry.reason, alreadyActive: result.alreadyActive },
  );

  return c.json(
    {
      success: true,
      data: result.entry,
      message: result.alreadyActive
        ? "Already banned — reason updated"
        : "Customer banned",
    },
    result.alreadyActive ? 200 : 201,
  );
}

/**
 * PATCH /blacklist/:id
 *
 * Edit the reason, lift the ban, or re-arm a lifted one. Lifting keeps the row
 * (who banned, who lifted, why, how many orders it stopped) — that history is
 * the only defence against "why did we ban this person?" six months later.
 */
export async function updateBlacklistEntry(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const id = c.req.param("id")!;
  const bodyData: any = (c.req as any).valid?.("json");
  const validated: validation.UpdateBlacklistEntryInput =
    bodyData ?? validation.updateBlacklistEntrySchema.parse(await c.req.json());

  const existing = await queries.getBlacklistEntry(db, id);
  if (!existing) throw new NotFoundError("Blacklist entry", id);

  const actor = c.get("user");

  // Re-arming a lifted ban is a NEW ban: the lifted row stays as the record of
  // the first one, which is what the partial unique index is built for.
  if (validated.status === "active" && existing.status === "lifted") {
    const reban = await queries.addBlacklistEntry(db, {
      kind: existing.kind,
      value: existing.value,
      reason: validated.reason ?? existing.reason,
      createdBy: actor?.id ?? null,
    });
    await logActivity(
      db,
      actor,
      ACTIONS.BLACKLIST_ENTRY_ADDED,
      { type: "customer", id: reban.entry?.id ?? id, label: existing.value },
      { kind: existing.kind, rebannedFrom: id },
    );
    return c.json({ success: true, data: reban.entry, message: "Customer banned again" }, 200);
  }

  if (validated.status === "lifted" && existing.status === "active") {
    const lifted = await queries.liftBlacklistEntry(db, id, {
      reason: validated.liftReason ?? null,
      liftedBy: actor?.id ?? null,
    });
    await logActivity(
      db,
      actor,
      ACTIONS.BLACKLIST_ENTRY_LIFTED,
      { type: "customer", id, label: existing.value },
      { kind: existing.kind, liftReason: validated.liftReason ?? null, hitCount: existing.hitCount },
    );
    return c.json({ success: true, data: lifted.entry, message: "Ban lifted" }, 200);
  }

  if (validated.reason !== undefined) {
    const updated = await queries.updateBlacklistReason(db, id, validated.reason);
    return c.json({ success: true, data: updated.entry, message: "Reason updated" }, 200);
  }

  return c.json({ success: true, data: existing, message: "No change" }, 200);
}

/**
 * DELETE /blacklist/:id
 *
 * Hard-delete — for entries added by mistake (a typo'd digit bans an innocent
 * customer). Unbanning a real ban is PATCH status="lifted", which keeps the
 * audit trail; that is why this route is admin-only.
 */
export async function deleteBlacklistEntry(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const id = c.req.param("id")!;

  const existing = await queries.getBlacklistEntry(db, id);
  if (!existing) throw new NotFoundError("Blacklist entry", id);

  await queries.deleteBlacklistEntry(db, id);
  await logActivity(
    db,
    c.get("user"),
    ACTIONS.BLACKLIST_ENTRY_DELETED,
    { type: "customer", id, label: existing.value },
    { kind: existing.kind, status: existing.status },
  );

  return c.json({ success: true, message: "Blacklist entry deleted" }, 200);
}
