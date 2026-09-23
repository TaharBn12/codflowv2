/**
 * Saved Views Validation Schemas
 *
 * A saved view is either a filter preset or a carrier export template. The
 * filter shape is validated loosely on purpose: the orders list gains filter
 * keys over time, and a view saved six months ago must still apply rather than
 * 422 because a new key appeared.
 */

import { z } from "zod";

export const SAVED_VIEW_KINDS = ["orders-filter", "export-template"] as const;

/** The orders-list filter state (mirrors OrderFilters in the dashboard). */
export const orderViewFiltersSchema = z.looseObject({
  query: z.string().max(200).optional(),
  status: z.string().max(40).optional(),
  delivery: z.string().max(40).optional(),
  wilaya: z.string().max(120).optional(),
  type: z.string().max(40).optional(),
  confirmationAssignment: z.string().max(40).optional(),
  confirmerId: z.string().max(120).optional(),
});

export const savedViewFiltersQuerySchema = z.object({
  kind: z.enum(SAVED_VIEW_KINDS).default("orders-filter"),
  limit: z.coerce.number().int().positive().max(200).default(100),
});

export const createSavedViewSchema = z
  .object({
    kind: z.enum(SAVED_VIEW_KINDS).default("orders-filter"),
    name: z.string().trim().min(1, "Name is required").max(80),
    shared: z.boolean().optional(),
    filters: orderViewFiltersSchema.optional(),
    sortKey: z.string().trim().max(40).nullish(),
    sortDirection: z.enum(["asc", "desc"]).nullish(),
    columns: z.array(z.string().trim().min(1).max(60)).max(60).nullish(),
    headers: z.record(z.string().trim().max(60), z.string().trim().max(120)).nullish(),
    carrierId: z.string().trim().min(1).max(120).nullish(),
  })
  .superRefine((view, ctx) => {
    if (view.kind === "orders-filter" && !view.filters) {
      ctx.addIssue({
        code: "custom",
        path: ["filters"],
        message: "An orders-filter view needs the filter state to restore",
      });
    }
    if (view.kind === "export-template" && (!view.columns || view.columns.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["columns"],
        message: "An export template needs at least one column",
      });
    }
  });

export const updateSavedViewSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    shared: z.boolean().optional(),
    filters: orderViewFiltersSchema.optional(),
    sortKey: z.string().trim().max(40).nullish(),
    sortDirection: z.enum(["asc", "desc"]).nullish(),
    columns: z.array(z.string().trim().min(1).max(60)).max(60).nullish(),
    headers: z.record(z.string().trim().max(60), z.string().trim().max(120)).nullish(),
    carrierId: z.string().trim().min(1).max(120).nullish(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nothing to update",
  });

export type SavedViewKindInput = z.infer<typeof savedViewFiltersQuerySchema>;
export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
export type UpdateSavedViewInput = z.infer<typeof updateSavedViewSchema>;
