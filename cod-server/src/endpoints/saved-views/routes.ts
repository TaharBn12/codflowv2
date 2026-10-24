/**
 * Saved Views Routes
 *
 * Mounted at `/api/saved-views`. Two kinds share the surface:
 *   • `orders-filter`   — a filter/sort preset for the orders list
 *   • `export-template` — a carrier file preset (columns, order, header wording)
 *
 * Scope: `orders:read`. A view is the caller's own list state — reading orders
 * is the permission that matters, and ownership (not a scope) decides who may
 * edit or delete which row. That is also why a confirmer can keep views without
 * being granted anything new.
 */

import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "@/types";
import { defineRoute } from "@/lib/route-builder";
import { SCOPES } from "../../../../cod-shared/rbac/scopes";
import * as h from "./handlers";
import * as validation from "./validation";
import {
  IdParamSchema,
  ListResponseSchema,
  MessageResponseSchema,
  SuccessResponseSchema,
  SuccessWithMessageSchema,
} from "@/openapi/schemas";

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  "application/json": { schema },
});

const SavedViewSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["orders-filter", "export-template"]),
    name: z.string(),
    ownerId: z.string(),
    ownerName: z.string().nullable(),
    shared: z.boolean(),
    filters: z.record(z.string(), z.unknown()),
    sortKey: z.string().nullable(),
    sortDirection: z.enum(["asc", "desc"]).nullable(),
    columns: z.array(z.string()).nullable(),
    headers: z.record(z.string(), z.string()).nullable(),
    carrierId: z.string().nullable(),
    carrierName: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("SavedView");

const listRoute = defineRoute({
  method: "get",
  path: "/",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Saved Views"],
  summary: "List saved views",
  description:
    "The caller's own views plus every shared one, shared first then most recently updated.",
  operationId: "listSavedViews",
  query: validation.savedViewFiltersQuerySchema,
  responses: {
    200: {
      description: "Saved views",
      content: jsonContent(ListResponseSchema(SavedViewSchema)),
    },
  },
  handler: h.listSavedViews,
});

const createRoute = defineRoute({
  method: "post",
  path: "/",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Saved Views"],
  summary: "Save a view",
  description:
    "Names must be unique per owner and kind. An `orders-filter` view requires `filters`; an `export-template` requires `columns`.",
  operationId: "createSavedView",
  body: validation.createSavedViewSchema,
  responses: {
    201: {
      description: "View saved",
      content: jsonContent(SuccessWithMessageSchema(SavedViewSchema)),
    },
    409: { description: "A view with this name already exists for the caller" },
  },
  handler: h.createSavedView,
});

const updateRoute = defineRoute({
  method: "patch",
  path: "/{id}",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Saved Views"],
  summary: "Update a view",
  description:
    "Owner or admin only. Also the way to publish (`shared: true`) or unpublish a view.",
  operationId: "updateSavedView",
  params: IdParamSchema,
  body: validation.updateSavedViewSchema,
  responses: {
    200: {
      description: "View updated",
      content: jsonContent(SuccessWithMessageSchema(SavedViewSchema)),
    },
    403: { description: "Caller is neither the owner nor an admin" },
    404: { description: "View not found" },
    409: { description: "Another view of the same kind already uses this name" },
  },
  handler: h.updateSavedView,
});

const deleteRoute = defineRoute({
  method: "delete",
  path: "/{id}",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Saved Views"],
  summary: "Delete a view",
  description: "Owner or admin only.",
  operationId: "deleteSavedView",
  params: IdParamSchema,
  responses: {
    200: {
      description: "View deleted",
      content: jsonContent(MessageResponseSchema),
    },
    403: { description: "Caller is neither the owner nor an admin" },
    404: { description: "View not found" },
  },
  handler: h.deleteSavedView,
});

const getRoute = defineRoute({
  method: "get",
  path: "/{id}",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Saved Views"],
  summary: "Get one view",
  description: "Owner, admin, or anyone when the view is shared.",
  operationId: "getSavedView",
  params: IdParamSchema,
  responses: {
    200: {
      description: "The view",
      content: jsonContent(SuccessResponseSchema(SavedViewSchema)),
    },
    404: { description: "View not found" },
  },
  handler: h.getSavedView,
});

const router = new OpenAPIHono<AppContext>();
router.openapi(listRoute.route, listRoute.handler);
router.openapi(createRoute.route, createRoute.handler);
router.openapi(getRoute.route, getRoute.handler);
router.openapi(updateRoute.route, updateRoute.handler);
router.openapi(deleteRoute.route, deleteRoute.handler);

export default router;
