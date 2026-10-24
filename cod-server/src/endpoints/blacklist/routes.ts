/**
 * Customer Blacklist Routes
 *
 * Banned phones and IPs. Mounted at `/api/blacklist`.
 *
 * Scope split mirrors the rest of the platform: `blacklist:read` for the list
 * and the "is this customer banned?" check, `blacklist:manage` for banning and
 * lifting. Hard-deleting an entry destroys the audit trail, so that one is
 * admin-only.
 */

import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "@/types";
import { defineRoute } from "@/lib/route-builder";
import { SCOPES } from "../../../../cod-shared/rbac/scopes";
import * as h from "./handlers";
import * as validation from "./validation";
import {
  IdParamSchema,
  ListWithTotalResponseSchema,
  MessageResponseSchema,
  SuccessResponseSchema,
  SuccessWithMessageSchema,
} from "@/openapi/schemas";

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  "application/json": { schema },
});

const BlacklistEntrySchema = z
  .object({
    id: z.string(),
    kind: z.enum(["phone", "ip"]),
    /** Canonical match key — local Algerian mobile ("0551234567") or the IP. */
    value: z.string(),
    rawValue: z.string(),
    reason: z.string().nullable(),
    status: z.enum(["active", "lifted"]),
    hitCount: z.number().int(),
    lastHitAt: z.string().nullable(),
    createdAt: z.string(),
    liftedAt: z.string().nullable(),
    liftedReason: z.string().nullable(),
    createdByName: z.string().nullable().optional(),
  })
  .openapi("BlacklistEntry");

const BlacklistCheckSchema = z
  .object({
    blacklisted: z.boolean(),
    kind: z.enum(["phone", "ip"]).nullable(),
    value: z.string().nullable(),
    reason: z.string().nullable(),
    bannedAt: z.string().nullable(),
    hitCount: z.number().int(),
  })
  .openapi("BlacklistCheck");

// ─── Routes ───────────────────────────────────────────────────────────────────

const listRoute = defineRoute({
  method: "get",
  path: "/",
  auth: { scope: SCOPES.BLACKLIST_READ },
  tags: ["Blacklist"],
  summary: "List blacklist entries",
  description:
    "Banned phones and IPs, newest first. Defaults to active entries; pass `status=lifted` for the audit trail.",
  operationId: "listBlacklist",
  query: validation.blacklistFiltersSchema,
  responses: {
    200: {
      description: "Blacklist entries",
      content: jsonContent(ListWithTotalResponseSchema(BlacklistEntrySchema)),
    },
  },
  handler: h.listBlacklist,
});

const checkRoute = defineRoute({
  method: "get",
  path: "/check",
  auth: { scope: SCOPES.BLACKLIST_READ },
  tags: ["Blacklist"],
  summary: "Check a phone or IP against the blacklist",
  description:
    "Answers the instant warning on the manual order form and the customer profile. Requires at least one of `phone` / `ip`.",
  operationId: "checkBlacklist",
  query: validation.blacklistCheckSchema,
  responses: {
    200: {
      description: "Whether an active ban covers this customer",
      content: jsonContent(SuccessResponseSchema(BlacklistCheckSchema)),
    },
  },
  handler: h.checkBlacklist,
});

const createRoute = defineRoute({
  method: "post",
  path: "/",
  auth: { scope: SCOPES.BLACKLIST_MANAGE },
  tags: ["Blacklist"],
  summary: "Ban a phone or IP",
  description: `Adds an active ban. Phones are accepted in any shape ("+213 551-234 567", "00213551234567",
"0551234567") and stored in the canonical local form the orders table uses, so
the match is exact and index-backed.

Re-banning a value that is already active refreshes its reason instead of
failing — the merchant's intent ("keep this person out") is unambiguous.

Orders from a banned number are still created (the record is the evidence) but
are excluded from confirmation auto-assignment and badged in every list.`,
  operationId: "addBlacklistEntry",
  body: validation.createBlacklistEntrySchema,
  responses: {
    201: {
      description: "Ban created",
      content: jsonContent(SuccessWithMessageSchema(BlacklistEntrySchema)),
    },
    200: {
      description: "Value was already banned — reason refreshed",
      content: jsonContent(SuccessWithMessageSchema(BlacklistEntrySchema)),
    },
    422: {
      description: "Value cannot identify a customer (not an Algerian mobile / not an IP)",
    },
  },
  handler: h.addBlacklistEntry,
});

const updateRoute = defineRoute({
  method: "patch",
  path: "/{id}",
  auth: { scope: SCOPES.BLACKLIST_MANAGE },
  tags: ["Blacklist"],
  summary: "Edit, lift, or re-arm a ban",
  description:
    "Lifting keeps the row (who banned, who lifted, why, how many orders it stopped). Re-arming a lifted ban creates a fresh active row so the first ban stays on record.",
  operationId: "updateBlacklistEntry",
  params: IdParamSchema,
  body: validation.updateBlacklistEntrySchema,
  responses: {
    200: {
      description: "Entry updated",
      content: jsonContent(SuccessWithMessageSchema(BlacklistEntrySchema)),
    },
    404: { description: "Entry not found" },
  },
  handler: h.updateBlacklistEntry,
});

const deleteRoute = defineRoute({
  method: "delete",
  path: "/{id}",
  auth: "admin",
  tags: ["Blacklist"],
  summary: "Delete a blacklist entry",
  description:
    "Hard-delete, for entries added by mistake. Unbanning a real ban is PATCH `status: \"lifted\"`, which preserves the audit trail.",
  operationId: "deleteBlacklistEntry",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Entry deleted",
      content: jsonContent(MessageResponseSchema),
    },
    404: { description: "Entry not found" },
  },
  handler: h.deleteBlacklistEntry,
});

// /check must be registered before /{id} so it is not captured as an id.
const router = new OpenAPIHono<AppContext>();
router.openapi(listRoute.route, listRoute.handler);
router.openapi(checkRoute.route, checkRoute.handler);
router.openapi(createRoute.route, createRoute.handler);
router.openapi(updateRoute.route, updateRoute.handler);
router.openapi(deleteRoute.route, deleteRoute.handler);

export default router;
