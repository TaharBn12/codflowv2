/**
 * Blacklist Validation Schemas
 *
 * Zod schemas for the customer blacklist endpoints. Phone values are accepted in
 * any shape a merchant pastes from a call log ("+213 551-234 567", "00213…",
 * "0551234567") and canonicalized by the query layer — the schema only rejects
 * values that cannot identify anyone at all.
 */

import { z } from "zod";

export const BLACKLIST_KINDS = ["phone", "ip"] as const;
export const BLACKLIST_STATUSES = ["active", "lifted"] as const;

export const blacklistFiltersSchema = z.object({
  kind: z.enum(BLACKLIST_KINDS).optional(),
  status: z.enum(BLACKLIST_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const blacklistCheckSchema = z
  .object({
    phone: z.string().trim().min(6).max(25).optional(),
    ip: z.string().trim().min(7).max(45).optional(),
  })
  .refine((value) => Boolean(value.phone || value.ip), {
    message: "Provide a phone or an ip to check",
  });

export const createBlacklistEntrySchema = z.object({
  kind: z.enum(BLACKLIST_KINDS),
  value: z.string().trim().min(6).max(64),
  reason: z.string().trim().max(300).nullish(),
});

export const updateBlacklistEntrySchema = z
  .object({
    reason: z.string().trim().max(300).nullish(),
    /** "lifted" unbans the customer; "active" re-arms a lifted entry's reason. */
    status: z.enum(BLACKLIST_STATUSES).optional(),
    liftReason: z.string().trim().max(300).nullish(),
  })
  .refine((value) => value.reason !== undefined || value.status !== undefined, {
    message: "Nothing to update",
  });

export type BlacklistFiltersInput = z.infer<typeof blacklistFiltersSchema>;
export type BlacklistCheckInput = z.infer<typeof blacklistCheckSchema>;
export type CreateBlacklistEntryInput = z.infer<typeof createBlacklistEntrySchema>;
export type UpdateBlacklistEntryInput = z.infer<typeof updateBlacklistEntrySchema>;
