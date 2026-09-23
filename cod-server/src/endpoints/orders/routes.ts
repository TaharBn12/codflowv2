/**
 * Orders Routes
 *
 * CRUD, lifecycle transitions, carrier dispatch, and shipment operations.
 */

import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "@/types";
import { defineRoute } from "@/lib/route-builder";
import { SCOPES } from "../../../../cod-shared/rbac/scopes";
import { getDb } from "@/db";
import { orderConfirmationAssignments } from "@/db/schema";
import { and, eq } from "drizzle-orm";

import * as handlers from "./handlers";
import * as statusTransitions from "./status-transitions";
import * as dispatch from "./dispatch";
import * as shipmentOps from "./shipment-operations";
import * as carrierSync from "./carrier-sync";
import * as bulk from "./bulk";
import * as duplicates from "./duplicates";
import * as importer from "./import";

import {
  createOrderSchema,
  updateOrderStatusSchema,
  assignDriverSchema,
  returnOrderProductSchema,
  orderFiltersSchema,
  bulkDispatchSchema,
  bulkCancelSchema,
  bulkDeleteSchema,
  duplicatesQuerySchema,
} from "./validation";

import {
  SuccessResponseSchema,
  SuccessWithMessageSchema,
  MessageResponseSchema,
  ListResponseSchema,
  IdParamSchema,
  OrderListItemSchema,
  OrderDetailSchema,
  OrderCreatedDataSchema,
  ShipmentCreatedDataSchema,
  BulkDispatchDataSchema,
  BulkDispatchResultItemSchema,
  ReturnProductDataSchema,
  CarrierRecordsArraySchema,
} from "@/openapi/schemas";

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  "application/json": { schema },
});

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const listOrdersRoute = defineRoute({
  method: "get",
  path: "/",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Orders"],
  summary: "List orders",
  operationId: "listOrders",
  query: orderFiltersSchema,
  responses: {
    200: {
      description:
        "List of orders (each item includes wilaya/commune/driverName joins plus hasReview and lastUpdatedBy)",
      content: jsonContent(ListResponseSchema(OrderListItemSchema)),
    },
  },
  handler: handlers.listOrders,
});

const getOrderRoute = defineRoute({
  method: "get",
  path: "/{id}",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Orders"],
  summary: "Get order",
  description: "Returns full order detail including products and status history.",
  operationId: "getOrder",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Order details",
      content: jsonContent(SuccessResponseSchema(OrderDetailSchema)),
    },
  },
  handler: handlers.getOrder,
});

const createOrderRoute = defineRoute({
  method: "post",
  path: "/",
  auth: { scope: SCOPES.ORDERS_CREATE },
  tags: ["Orders"],
  summary: "Create order",
  description: `Creates a new order.

**Auto-customer creation:** If \`customerId\` is not found in the customers table (e.g. walk-in / manual entry), the customer is automatically created using \`customerName\`, \`phone\`, \`wilayaId\`, and \`address\`. Pass a client-generated UUID (e.g. \`crypto.randomUUID()\`) as \`customerId\` in this case.

**Inventory:** Products with \`trackInventory\` enabled will have their stock decremented automatically.

**Delivery fee:** auto-resolved from shipping profiles for online orders; offline/dashboard orders may pass an explicit \`deliveryFee\` override.

**companyId:** If provided, the delivery company must exist — returns 404 if not found.`,
  operationId: "createOrder",
  body: createOrderSchema,
  responses: {
    201: {
      description: "Order created successfully",
      content: jsonContent(SuccessWithMessageSchema(OrderCreatedDataSchema)),
    },
    404: {
      description: "Delivery company not found when companyId provided",
    },
  },
  handler: handlers.createOrder,
});

const deleteOrderRoute = defineRoute({
  method: "delete",
  path: "/{id}",
  auth: { scope: SCOPES.ORDERS_DELETE },
  tags: ["Orders"],
  summary: "Delete order",
  description:
    "Permanently deletes the order and all child records (order products, shipments) from the database.",
  operationId: "deleteOrder",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Order deleted",
      content: jsonContent(MessageResponseSchema),
    },
  },
  handler: handlers.deleteOrder,
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const updateStatusRoute = defineRoute({
  method: "patch",
  path: "/{id}/status",
  auth: { scope: SCOPES.ORDERS_UPDATE },
  tags: ["Orders"],
  summary: "Update order status",
  description: `Updates the order status and appends a record to status history.

**Main flow:** \`new\` → \`confirmed\` → \`preparing\` → \`ready\` → (\`assigned\` | \`dispatched\`) → \`out_for_delivery\` → \`delivered\` / \`returned\`

**Branching statuses:**
- \`unreachable\`: customer didn't answer — parks the order. Can retry back to \`confirmed\` or cancel

**Transition guard:** Only forward moves in the flow are accepted. Invalid moves (e.g. \`delivered → new\`, \`cancelled → preparing\`) return \`400 INVALID_STATUS_TRANSITION\` with the list of allowed next statuses.

**Side effects:**
- **delivered**: sets \`deliveryTime\`; increments driver's \`totalDelivered\` and \`totalEarnings\` if assigned
- **cancelled / returned**: restores inventory for products with \`trackInventory\` enabled (double-cancel/return is safe)
- **delivered**: fires the Meta CAPI Purchase workflow when the store has tracking enabled`,
  operationId: "updateOrderStatus",
  params: IdParamSchema,
  body: updateOrderStatusSchema,
  responses: {
    200: {
      description: "Status updated",
      content: jsonContent(MessageResponseSchema),
    },
    400: {
      description:
        "Unknown status value (VALIDATION_FAILED) or transition not allowed by the flow guard (INVALID_STATUS_TRANSITION with currentStatus/targetStatus/allowedTransitions context)",
    },
  },
  handler: statusTransitions.updateStatus,
});

const assignDriverRoute = defineRoute({
  method: "patch",
  path: "/{id}/assign-driver",
  auth: { scope: SCOPES.ORDERS_ASSIGN },
  tags: ["Orders"],
  summary: "Assign driver to order",
  description: `Assigns a driver for manual delivery.

**Business rules — returns 422 if:**
- The order already has a tracking number (dispatched to a company)
- The order's \`deliveryMethod\` is \`"company"\`
- The order status is \`out_for_delivery\`, \`delivered\`, \`returned\`, or \`cancelled\`
- The driver does not exist (404)`,
  operationId: "assignDriver",
  params: IdParamSchema,
  body: assignDriverSchema,
  responses: {
    200: {
      description: "Driver assigned",
      content: jsonContent(MessageResponseSchema),
    },
    422: {
      description:
        "Business rule violation — already dispatched / company-assigned / locked status",
    },
  },
  handler: statusTransitions.assignDriver,
});

const unassignDriverRoute = defineRoute({
  method: "patch",
  path: "/{id}/unassign",
  auth: { scope: SCOPES.ORDERS_ASSIGN },
  tags: ["Orders"],
  summary: "Unassign driver from order",
  description: `Removes the driver currently assigned to an order. Clears driverId and driverFee, resets deliveryMethod to "unassigned", and rolls the status back from "assigned" → "ready" when applicable.

**Rejected when:**
- order has no driver assigned
- order has already progressed past dispatch (out_for_delivery, delivered, returned, cancelled) — at that point clearing the driver would erase payroll/handoff history.`,
  operationId: "unassignDriver",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Driver unassigned",
      content: jsonContent(MessageResponseSchema),
    },
    422: {
      description: "Order has no driver assigned, or status is locked",
    },
  },
  handler: statusTransitions.unassignDriver,
});

const returnOrderProductRoute = defineRoute({
  method: "patch",
  path: "/{id}/products/{productLineId}/return",
  auth: { scope: SCOPES.ORDERS_UPDATE },
  tags: ["Orders"],
  summary: "Record a product line return",
  description: `Records how many units on a single order line the customer refused at the door. Used for the Algerian "open the box at delivery" workflow where a customer may accept part of an order and return the rest.

The server computes the line status ("fulfilled" | "partially_returned" | "returned") from returnedQuantity vs. the line quantity, restocks the delta (repeated calls are idempotent), and logs an ORDER_RETURNED stock movement.

Rejected with 422 while the overall order is already \`returned\` or \`cancelled\` — stock was already reconciled.`,
  operationId: "returnOrderProduct",
  params: IdParamSchema.extend({
    productLineId: z.string().openapi({ description: "Order product line ID" }),
  }),
  body: returnOrderProductSchema,
  responses: {
    200: {
      description: "Return recorded",
      content: jsonContent(SuccessWithMessageSchema(ReturnProductDataSchema)),
    },
    400: {
      description: "Validation error (VALIDATION_FAILED / VALUE_OUT_OF_RANGE)",
    },
    422: {
      description:
        "Order is in a terminal state (returned/cancelled) — returns already reconciled",
    },
  },
  handler: handlers.returnOrderProduct,
});

// ─── Carrier dispatch ─────────────────────────────────────────────────────────

const bulkDispatchRoute = defineRoute({
  method: "post",
  path: "/bulk-dispatch",
  auth: { scope: SCOPES.DELIVERY_DISPATCH },
  tags: ["Orders"],
  summary: "Bulk dispatch orders to a delivery company",
  description: `Dispatch multiple existing orders to a delivery company in one API call using the provider's bulk creation endpoint (up to 100 orders per request).

⚠️ Provider support: ecotrack adapter implemented (Packers' bulk endpoint currently returns 500 — confirmed server-side bug); others return OPERATION_NOT_SUPPORTED.

Per-order results are returned; partial success is possible (HTTP 201 when at least one order dispatched, 400 when none did).`,
  operationId: "bulkDispatch",
  body: bulkDispatchSchema,
  responses: {
    201: {
      description: "Bulk dispatch executed (at least one order dispatched)",
      content: jsonContent(SuccessWithMessageSchema(BulkDispatchDataSchema)),
    },
    400: {
      description:
        "Validation error, or no valid orders to dispatch (returns per-order results)",
      content: jsonContent(
        z.object({
          success: z.boolean(),
          message: z.string(),
          results: z.array(BulkDispatchResultItemSchema).optional(),
        })
      ),
    },
    422: {
      description: "Provider does not support bulk creation (OPERATION_NOT_SUPPORTED)",
    },
  },
  handler: dispatch.bulkDispatch,
});

const dispatchToCompanyRoute = defineRoute({
  method: "post",
  path: "/{id}/dispatch",
  auth: { scope: SCOPES.DELIVERY_DISPATCH },
  tags: ["Orders"],
  summary: "Dispatch order to delivery company",
  description: `Creates a shipment via the assigned delivery company's API (NOEST, ZR Express, Yalidine, Packers/EcoTrack).

**What happens:**
1. Validates business rules (not already dispatched, wilaya + commune set, station code for stop-desk)
2. Calls the provider adapter to create the shipment
3. Records the tracking number on the order
4. Auto-validates where supported (NOEST) — advances status to out_for_delivery; otherwise status becomes dispatched
5. Logs the API call for audit

**Body fields are all optional** — they override values stored on the order.`,
  operationId: "dispatchToCompany",
  params: IdParamSchema,
  body: z.object({
    companyId: z.string().optional().openapi({
      description: "Override the order's assigned company",
    }),
    deliveryType: z.enum(["home", "stop_desk"]).optional().openapi({
      description:
        "Override the order's delivery type. Resolves the stop-desk dead end: a stop-desk " +
        "order can be dispatched as home delivery (no station required), and a home order " +
        "can be dispatched to a stop desk (station required). Persisted on the order on " +
        "successful dispatch. The charged COD is unchanged — it was confirmed by the customer " +
        "with the original type.",
    }),
    stationCode: z.string().optional().openapi({
      description: "Stop-desk station code. Required when the effective deliveryType is stop_desk",
    }),
    remarks: z.string().optional().openapi({
      description: "Delivery remarks passed to the provider",
    }),
    weight: z.number().optional().openapi({
      description: "Parcel weight in kg override",
    }),
    fragile: z.boolean().optional().openapi({
      description: "Fragile parcel flag override",
    }),
  }),
  responses: {
    201: {
      description: "Shipment created successfully",
      content: jsonContent(SuccessWithMessageSchema(ShipmentCreatedDataSchema)),
    },
    400: {
      description:
        "Validation error — no delivery company, missing wilaya/commune, or missing station code",
    },
    422: {
      description:
        "Already dispatched (ORDER_ALREADY_DISPATCHED), driver assigned (DRIVER_ALREADY_ASSIGNED), inactive company, unsupported provider, or shipment creation failed (SHIPMENT_CREATION_FAILED)",
    },
  },
  handler: dispatch.dispatchToCompany,
});

const validateShipmentRoute = defineRoute({
  method: "post",
  path: "/{id}/validate-shipment",
  auth: { scope: SCOPES.DELIVERY_DISPATCH },
  tags: ["Orders"],
  summary: "Manually validate a dispatched shipment",
  description: `Manually validate a dispatched order at the carrier API. Only meaningful when company.auto_validate=false (e.g. Packers). Advances status dispatched → out_for_delivery.`,
  operationId: "validateShipmentManually",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Shipment validated — order is now out for delivery",
      content: jsonContent(MessageResponseSchema),
    },
    400: {
      description: "Carrier validation returned false",
      content: jsonContent(
        z.object({
          success: z.boolean().openapi({ example: false }),
          message: z.string(),
        })
      ),
    },
    422: {
      description:
        "Order not in dispatched state (INVALID_STATUS_TRANSITION), inactive company, unsupported provider, or external API error (502 EXTERNAL_API_ERROR)",
    },
    500: {
      description: "External API error",
    },
  },
  handler: dispatch.validateShipmentManually,
});

// ─── Shipment operations ──────────────────────────────────────────────────────

const updateShipmentRoute = defineRoute({
  method: "patch",
  path: "/{id}/update-shipment",
  auth: { scope: SCOPES.DELIVERY_DISPATCH },
  tags: ["Orders"],
  summary: "Update shipment info at carrier",
  description: `Updates an existing shipment at the carrier API: customer info, COD amount, delivery preferences (fragile, weight, remarks). Changed fields sync back to the database.

All fields are optional — omitted fields use current order values. EcoTrack requires ALL fields on every update call, so the server pre-fills from the order record and applies overrides. The COD amount sent to the carrier defaults to the order's COD total (price + delivery fee); an explicit \`amount\` overrides it and syncs back onto the order's price.

**Update restrictions:** EcoTrack-family orders can only be updated before validation (status \`dispatched\`). NOEST rejects after validation; Yalidine after label print. ZR Express addresses parcels by internal parcel UUID.

**Returns 422** when there is no tracking number, the provider doesn't support updates, or the EcoTrack pre-validation guard trips. External carrier failures surface as 502 EXTERNAL_API_ERROR.`,
  operationId: "updateShipmentInfo",
  params: IdParamSchema,
  body: z.object({
    customerName: z.string().optional().openapi({ description: "Customer full name" }),
    phone: z.string().optional().openapi({
      description: "Algerian mobile number",
      example: "0551234567",
    }),
    phone2: z.string().optional().openapi({ description: "Secondary phone number" }),
    address: z.string().optional().openapi({ description: "Delivery address" }),
    commune: z.string().optional().openapi({
      description:
        "Commune name in French (required by Packers on every call — server pre-fills)",
    }),
    wilayaId: z.number().int().min(1).max(58).optional(),
    amount: z.number().positive().optional().openapi({
      description: "COD amount to collect",
    }),
    remarks: z.string().optional().openapi({ description: "Delivery remarks/notes" }),
    fragile: z.boolean().optional(),
    weight: z.number().min(0).optional().openapi({
      description: "Package weight in kg",
    }),
  }),
  responses: {
    200: {
      description: "Shipment updated successfully",
      content: jsonContent(MessageResponseSchema),
    },
    422: {
      description:
        "No tracking number, provider does not support updates, or EcoTrack pre-validation guard tripped",
    },
    500: {
      description: "External API error (EXTERNAL_API_ERROR)",
    },
  },
  handler: shipmentOps.updateShipmentInfo,
});

const cancelShipmentRoute = defineRoute({
  method: "post",
  path: "/{id}/cancel-shipment",
  auth: { scope: SCOPES.DELIVERY_DISPATCH },
  tags: ["Orders"],
  summary: "Cancel shipment at carrier",
  description: `Deletes/cancels a shipment at the carrier API (before validation only). On success: clears the tracking number from the order and resets status to "ready" so it can be re-dispatched.

Uses POST (not DELETE) to avoid routing ambiguity with DELETE /orders/{id}.

Provider support: ecotrack ✅ | others ❌ OPERATION_NOT_SUPPORTED.`,
  operationId: "cancelShipment",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Shipment cancelled — order reset to ready",
      content: jsonContent(MessageResponseSchema),
    },
    422: {
      description:
        "No tracking number (REQUIRED_FIELD_MISSING), or provider does not support cancelling (OPERATION_NOT_SUPPORTED)",
    },
    500: {
      description: "External API error (EXTERNAL_API_ERROR)",
    },
  },
  handler: shipmentOps.cancelShipment,
});

const addRemarkRoute = defineRoute({
  method: "post",
  path: "/{id}/add-remark",
  auth: { scope: SCOPES.DELIVERY_DISPATCH },
  tags: ["Orders"],
  summary: "Add remark to shipment at carrier",
  description: `Adds a remark/note to the shipment at the carrier API. Works at any time after dispatch; visible to carrier and sender.

Provider support: ecotrack ✅ | others ❌ OPERATION_NOT_SUPPORTED.`,
  operationId: "addShipmentRemark",
  params: IdParamSchema,
  body: z.object({
    content: z.string().min(1).openapi({
      description: "Remark text shown to the carrier and courier",
      example: "Appeler le client 30 minutes avant",
    }),
  }),
  responses: {
    200: {
      description: "Remark added",
      content: jsonContent(MessageResponseSchema),
    },
    400: {
      description: "Missing or empty remark content (REQUIRED_FIELD_MISSING)",
    },
    422: {
      description: "No tracking number, or provider does not support remarks",
    },
    500: {
      description: "External API error (EXTERNAL_API_ERROR)",
    },
  },
  handler: shipmentOps.addShipmentRemark,
});

const getRemarksRoute = defineRoute({
  method: "get",
  path: "/{id}/remarks",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Orders"],
  summary: "Fetch shipment remarks from carrier",
  description: `Fetches the list of remarks/notes for a shipment from the carrier API — entries from both sender and courier/driver.

Provider support: ecotrack ✅ (GET /api/v1/get/maj) | NOEST ❌ | Yalidine ❌ | ZR Express ❌.`,
  operationId: "getShipmentRemarks",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Remarks fetched successfully",
      content: jsonContent(
        z.object({
          success: z.boolean().openapi({ example: true }),
          data: CarrierRecordsArraySchema,
        })
      ),
    },
    422: {
      description: "No tracking number, or provider does not support fetching remarks",
    },
    500: {
      description: "External API error (EXTERNAL_API_ERROR)",
    },
  },
  handler: shipmentOps.getShipmentRemarks,
});

const getTrackingRoute = defineRoute({
  method: "get",
  path: "/{id}/tracking-events",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Orders"],
  summary: "Fetch tracking history from carrier",
  description: `Fetches the full chronological tracking history for a shipment from the carrier API (pickup, hub reception, transit, delivery attempts, delivered/returned).

Provider support: all four ✅ (ecotrack, noest, yalidine, zr_express).`,
  operationId: "getShipmentTracking",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Tracking events fetched successfully",
      content: jsonContent(
        z.object({
          success: z.boolean().openapi({ example: true }),
          data: CarrierRecordsArraySchema,
        })
      ),
    },
    422: {
      description: "No tracking number, or provider does not support live tracking",
    },
    500: {
      description: "External API error (EXTERNAL_API_ERROR)",
    },
  },
  handler: shipmentOps.getShipmentTracking,
});

const proxyLabelRoute = defineRoute({
  method: "get",
  path: "/{id}/label",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Orders"],
  summary: "Proxy shipment label PDF from carrier",
  description: `Proxies the shipment label PDF from the carrier API. Carrier label URLs require a Bearer token and are not publicly accessible — this endpoint fetches server-side (with the stored token, or a fresh SAS URL for ZR Express) and streams the PDF to the client.

Returns application/pdf with Content-Disposition: inline.`,
  operationId: "proxyShipmentLabel",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Label PDF stream",
      content: {
        "application/pdf": {
          schema: z.string().openapi({ format: "binary", type: "string" }),
        },
      },
    },
    422: {
      description:
        "No tracking number, no API token configured (MISSING_API_CREDENTIALS), or label not yet available",
    },
    500: {
      description: "Failed to fetch label from carrier (EXTERNAL_API_ERROR)",
    },
  },
  handler: shipmentOps.proxyShipmentLabel,
});

// ─── Router ───────────────────────────────────────────────────────────────────

const askReturnRoute = defineRoute({
  method: "post",
  path: "/{id}/ask-return",
  auth: { scope: SCOPES.DELIVERY_DISPATCH },
  tags: ["Orders"],
  summary: "Ask carrier to return the parcel",
  description: `Requests a parcel return at the carrier API (EcoTrack: POST /api/v1/ask/for/order/return). This is a REQUEST, not a state change — the courier may take up to a day to action it and can decline (platform-documented), so the order stays out_for_delivery until the return is confirmed.

Only callable while the order is out_for_delivery. Carrier error 10003 (not returnable) surfaces as 502 EXTERNAL_API_ERROR.

Provider support: ecotrack ✅ | others ❌ OPERATION_NOT_SUPPORTED.`,
  operationId: "askShipmentReturn",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Return requested at the carrier",
      content: jsonContent(MessageResponseSchema),
    },
    422: {
      description:
        "No tracking number, order not out_for_delivery, or provider does not support return requests",
    },
    500: {
      description: "External API error (EXTERNAL_API_ERROR)",
    },
  },
  handler: shipmentOps.askShipmentReturn,
});

const confirmReturnReceptionRoute = defineRoute({
  method: "post",
  path: "/{id}/confirm-return-reception",
  auth: { scope: SCOPES.DELIVERY_DISPATCH },
  tags: ["Orders"],
  summary: "Confirm return reception at carrier",
  description: `Confirms at the carrier that the merchant physically received the returned parcel (EcoTrack: POST /api/v1/valid/returns), then moves the order to "returned" through the normal status path (inventory restore, customer stats, history).

Forward-only: only callable from out_for_delivery. If the carrier reports nothing eligible (already confirmed, or parcel not in a return state), returns 422 without touching the order.

Provider support: ecotrack ✅ | others ❌ OPERATION_NOT_SUPPORTED.`,
  operationId: "confirmReturnReception",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Return reception confirmed — order marked returned",
      content: jsonContent(MessageResponseSchema),
    },
    422: {
      description:
        "No tracking number, order not out_for_delivery, provider unsupported, or carrier reports nothing eligible for confirmation",
    },
    500: {
      description: "External API error (EXTERNAL_API_ERROR)",
    },
  },
  handler: shipmentOps.confirmReturnReception,
});

// ─── Carrier status auto-sync ────────────────────────────────────────────────

const CarrierSyncOutcomeSchema = z.object({
  orderId: z.string(),
  orderNumber: z.string(),
  trackingNumber: z.string(),
  outcome: z.enum(["updated", "unchanged", "unmapped", "error"]),
  from: z.string(),
  to: z.string().optional(),
  carrierStatus: z.string().nullable().optional(),
  error: z.string().optional(),
});

const CarrierSyncCountersSchema = z.object({
  scanned: z.number(),
  polled: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  unmapped: z.number(),
  errors: z.number(),
});

const bulkSyncCarrierRoute = defineRoute({
  method: "post",
  path: "/bulk-sync-carrier",
  auth: { scope: SCOPES.ORDERS_UPDATE },
  tags: ["Orders"],
  summary: "Pull order statuses from the delivery companies",
  description: `Polls the carrier tracking API and applies what it reports through the same
forward-only rank guard the inbound webhooks use — a sync can never move an
order backwards.

Two modes:
- \`orderIds\` given → only those orders are polled (throttle bypassed).
- no \`orderIds\` → every company with auto-sync enabled is swept, one batch
  (max 100 orders) per company, respecting each company's
  \`auto_sync_interval_min\` unless \`force\` is set.

This is the manual twin of the \`*/15 * * * *\` cron trigger.`,
  operationId: "bulkSyncCarrierStatus",
  body: z.object({
    orderIds: z.array(z.string()).max(100).optional().openapi({
      description: "Explicit selection. Omit to sweep everything currently due.",
    }),
    companyId: z.string().optional().openapi({
      description: "Restrict the sweep to one company (ignored when orderIds is set).",
    }),
    force: z.boolean().optional().openapi({
      description: "Ignore the per-order auto_sync_interval_min throttle.",
    }),
    limit: z.number().int().min(1).max(100).optional().openapi({
      description: "Max orders polled per company (default and maximum: 100).",
    }),
  }),
  responses: {
    200: {
      description: "Sync finished — per-company counters plus per-order detail",
      content: jsonContent(
        z.object({
          success: z.boolean().openapi({ example: true }),
          data: z.object({
            companies: z.array(
              z.object({
                companyId: z.string(),
                companyCode: z.string(),
                companyName: z.string(),
                runId: z.string(),
                scanned: z.number(),
                polled: z.number(),
                updated: z.number(),
                unchanged: z.number(),
                unmapped: z.number(),
                errors: z.number(),
                unmappedStatuses: z.array(z.string()),
                error: z.string().nullable(),
              })
            ),
            totals: CarrierSyncCountersSchema,
            details: z.array(CarrierSyncOutcomeSchema),
          }),
        })
      ),
    },
    401: { description: "Unauthorized" },
    403: { description: "Missing orders:update scope" },
  },
  handler: carrierSync.bulkSyncCarrierStatus,
});

const syncOrderCarrierRoute = defineRoute({
  method: "post",
  path: "/{id}/sync-carrier",
  auth: { scope: SCOPES.ORDERS_UPDATE },
  tags: ["Orders"],
  summary: "Sync one order's status from its carrier",
  description: `Polls the carrier tracking API for this order and applies the newest status it
reports, through the forward-only rank guard. Bypasses the auto-sync throttle.

Works even when the company's background auto-sync is switched off — an
explicit operator request only needs working API credentials.

Returns 422 when the order has no tracking number, the company has no
credentials, or the carrier returned no history for the tracking number.`,
  operationId: "syncOrderCarrierStatus",
  params: IdParamSchema,
  responses: {
    200: {
      description: "Sync result for this order",
      content: jsonContent(
        z.object({
          success: z.boolean().openapi({ example: true }),
          data: z.object({
            orderId: z.string(),
            outcome: z.enum(["updated", "unchanged", "unmapped", "error"]),
            from: z.string(),
            to: z.string(),
            carrierStatus: z.string().nullable(),
            companyId: z.string(),
            companyCode: z.string(),
            runId: z.string(),
          }),
        })
      ),
    },
    422: {
      description:
        "No tracking number, company not connected, or the carrier has no history for this tracking number",
    },
    500: { description: "Carrier API error (EXTERNAL_API_ERROR)" },
  },
  handler: carrierSync.syncOrderCarrierStatus,
});

// ─── Bulk cancel / delete, duplicates, spreadsheet import ─────────────────────

const BulkRowResultSchema = z.object({
  orderId: z.string(),
  orderNumber: z.string().nullable(),
  ok: z.boolean(),
  outcome: z.enum(["cancelled", "deleted", "not_found", "invalid_transition", "error"]),
  status: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

const BulkTotalsSchema = z.object({
  requested: z.number().int(),
  ok: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
});

const BulkActionDataSchema = z.object({
  totals: BulkTotalsSchema,
  results: z.array(BulkRowResultSchema),
});

const bulkCancelRoute = defineRoute({
  method: "post",
  path: "/bulk-cancel",
  auth: { scope: SCOPES.ORDERS_DELETE },
  tags: ["Orders"],
  summary: "Cancel up to 100 orders",
  description: `Cancels every selected order the status machine allows, through the same
single-order transition used by \`PATCH /orders/{id}/status\` — so stock is
restored, driver credit is reversed and the status history is written per order.

An order that cannot be cancelled (already \`out_for_delivery\`, \`delivered\`,
\`returned\`, or already \`cancelled\`) is reported as \`invalid_transition\` and
never aborts the batch: HTTP 200 with \`totals.skipped > 0\` is the honest answer.

\`reason\` is recorded on the batch's activity-log entry.`,
  operationId: "bulkCancelOrders",
  body: bulkCancelSchema,
  responses: {
    200: {
      description: "Batch executed — per-order results and tally",
      content: jsonContent(SuccessResponseSchema(BulkActionDataSchema)),
    },
  },
  handler: bulk.bulkCancelOrders,
});

const bulkDeleteRoute = defineRoute({
  method: "post",
  path: "/bulk-delete",
  auth: { scope: SCOPES.ORDERS_DELETE },
  tags: ["Orders"],
  summary: "Permanently delete up to 100 orders",
  description: `Irreversible: each order cascades to its lines, shipments and status history,
and customer/driver counters plus inventory are reversed by the same query the
single-order DELETE uses.

Requires \`confirm: true\` in the body — a mass delete should never happen by
accident from a stray request.`,
  operationId: "bulkDeleteOrders",
  body: bulkDeleteSchema,
  responses: {
    200: {
      description: "Batch executed — per-order results and tally",
      content: jsonContent(SuccessResponseSchema(BulkActionDataSchema)),
    },
  },
  handler: bulk.bulkDeleteOrders,
});

const DuplicateGroupOrderSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: z.string(),
  createdAt: z.string(),
  customerName: z.string(),
  price: z.number(),
  deliveryFee: z.number(),
  wilaya: z.string().nullable(),
  commune: z.string().nullable(),
  productName: z.string().nullable(),
  trackingNumber: z.string().nullable(),
});

const DuplicateGroupSchema = z.object({
  phone: z.string(),
  count: z.number().int(),
  sameProduct: z.boolean(),
  shipped: z.boolean(),
  totalCod: z.number(),
  lastCreatedAt: z.string(),
  orders: z.array(DuplicateGroupOrderSchema),
});

const duplicatesRoute = defineRoute({
  method: "get",
  path: "/duplicates",
  auth: { scope: SCOPES.ORDERS_READ },
  tags: ["Orders"],
  summary: "Detect duplicate orders by phone",
  description: `Groups orders placed on the same phone number inside a rolling window
(default 48h) and returns the orders behind each group.

\`sameProduct\` separates the two cases that need opposite reactions: the same
basket twice is almost always an accidental double submit (cancel one), while
different products on one number is usually a family sharing a phone (leave both
alone). \`shipped\` marks groups where at least one parcel already left — too late
to merge.

Confirmers are refused (403): a global duplicate list would expose every other
confirmer's queue.`,
  operationId: "listDuplicateOrders",
  query: duplicatesQuerySchema,
  responses: {
    200: {
      description: "Duplicate groups, biggest first",
      content: jsonContent(
        SuccessResponseSchema(
          z.object({
            windowHours: z.number().int(),
            groups: z.array(DuplicateGroupSchema),
            totalGroups: z.number().int(),
            totalOrders: z.number().int(),
            actionableCod: z.number(),
          }),
        ),
      ),
    },
    403: { description: "Caller is a confirmer (sees only their own queue)" },
  },
  handler: duplicates.listDuplicateOrders,
});

const ImportRowIssueSchema = z.object({
  row: z.number().int(),
  field: z.string(),
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  value: z.string().optional(),
});

const ImportRowPreviewSchema = z.object({
  row: z.number().int(),
  valid: z.boolean(),
  customerName: z.string().nullable(),
  phone: z.string().nullable(),
  wilayaId: z.number().int().nullable(),
  wilaya: z.string().nullable(),
  communeId: z.string().nullable(),
  commune: z.string().nullable(),
  address: z.string().nullable(),
  productId: z.string().nullable(),
  productName: z.string().nullable(),
  variantLabel: z.string().nullable(),
  quantity: z.number().int(),
  price: z.number().nullable(),
  deliveryFee: z.number().nullable(),
  deliveryType: z.enum(["home", "stop_desk"]),
  notes: z.string().nullable(),
  externalReference: z.string().nullable(),
  issues: z.array(ImportRowIssueSchema),
});

const ImportResultSchema = z.object({
  dryRun: z.boolean(),
  sheetName: z.string(),
  sheetNames: z.array(z.string()),
  truncated: z.boolean(),
  headers: z.array(z.string()),
  headerRow: z.number().int(),
  mapping: z.object({
    columns: z.record(z.string(), z.number().int()),
    headers: z.record(z.string(), z.string()),
    unmapped: z.array(z.object({ index: z.number().int(), header: z.string() })),
    missingRequired: z.array(z.string()),
  }),
  totals: z.object({
    rowsInSheet: z.number().int(),
    parsed: z.number().int(),
    valid: z.number().int(),
    invalid: z.number().int(),
    warnings: z.number().int(),
    created: z.number().int(),
    failed: z.number().int(),
  }),
  rows: z.array(ImportRowPreviewSchema),
  failures: z.array(ImportRowIssueSchema).optional(),
  createdOrders: z.array(
    z.object({ row: z.number().int(), orderId: z.string(), orderNumber: z.string() }),
  ),
  nextOffset: z.number().int().nullable(),
});

const importRoute = defineRoute({
  method: "post",
  path: "/import",
  auth: { scope: SCOPES.ORDERS_CREATE },
  tags: ["Orders"],
  summary: "Import orders from Excel / CSV / Google Sheets",
  description: `Uploads a spreadsheet (.xlsx, .xls, .csv — a Google Sheet exported or
published as either) and turns its rows into orders.

**Two phases.** \`dryRun=true\` parses, auto-maps the header row, resolves wilayas,
communes and catalog products, and reports every row's issues without writing
anything. \`dryRun=false\` then creates orders for the valid rows in
\`[offset, offset + limit)\` — paging keeps a large sheet inside one Worker
invocation, and \`nextOffset\` tells the caller whether more pages remain.

**Column detection** is by alias, in Arabic, French and English ("رقم الهاتف",
"Téléphone", "Phone Number" all map to \`phone\`); pass \`mapping\` (JSON of
field → column index) to override any guess the picker got wrong.

**Rules.** The sheet's price wins over the catalog price (imported orders carry
promo and negotiated totals). Rows whose product is not in the catalog are
rejected unless \`fallbackProductId\` names one. Blacklisted phones and phones
that already ordered recently come back as warnings, not errors — the merchant
decides.`,
  operationId: "importOrders",
  bodyContent: {
    "multipart/form-data": {
      schema: z.object({
        file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
        dryRun: z.string().optional().openapi({ example: "true" }),
        offset: z.string().optional().openapi({ example: "0" }),
        limit: z.string().optional().openapi({ example: "100", description: "Max 100 rows created per call" }),
        orderType: z.string().optional().openapi({ example: "offline", description: "offline (default) or online" }),
        fallbackProductId: z.string().optional(),
        sheetName: z.string().optional(),
        mapping: z.string().optional().openapi({ description: 'JSON object of field → column index, e.g. {"phone":3}' }),
      }),
    },
  },
  responses: {
    200: {
      description: "Preview (dryRun) or creation report",
      content: jsonContent(SuccessResponseSchema(ImportResultSchema)),
    },
    400: {
      description:
        "Missing file, unsupported type, unreadable workbook, empty sheet (INVALID_FILE_TYPE / REQUIRED_FIELD_MISSING / INVALID_FORMAT)",
    },
    422: {
      description: "A required column could not be detected — the response still carries the headers and mapping so the caller can fix it",
    },
  },
  handler: importer.importOrders,
});

// IMPORTANT: every static path (/bulk-dispatch, /bulk-cancel, /bulk-delete,
// /duplicates, /import) must come before the /{id} routes — otherwise the
// literal segment would be captured as an id param.
const router = new OpenAPIHono<AppContext>();

// Return 404 for every direct read or mutation of another confirmer's order.
const requireConfirmerOwnership = async (c: any, next: () => Promise<void>) => {
  const actor = c.get("user");
  if (actor?.role !== "confirmer") return next();
  const assignment = await getDb(c.env.DB).select({ orderId: orderConfirmationAssignments.orderId })
    .from(orderConfirmationAssignments)
    .where(and(eq(orderConfirmationAssignments.orderId, c.req.param("id")), eq(orderConfirmationAssignments.assigneeId, actor.id))).get();
  if (!assignment) return c.json({ success: false, error: "Order not found", code: "NOT_FOUND" }, 404);
  return next();
};
router.use("/:id", requireConfirmerOwnership);
router.use("/:id/*", requireConfirmerOwnership);

router.openapi(listOrdersRoute.route, listOrdersRoute.handler);
router.openapi(bulkDispatchRoute.route, bulkDispatchRoute.handler);
router.openapi(bulkSyncCarrierRoute.route, bulkSyncCarrierRoute.handler);
router.openapi(bulkCancelRoute.route, bulkCancelRoute.handler);
router.openapi(bulkDeleteRoute.route, bulkDeleteRoute.handler);
router.openapi(duplicatesRoute.route, duplicatesRoute.handler);
router.openapi(importRoute.route, importRoute.handler);

router.openapi(getOrderRoute.route, getOrderRoute.handler);
router.openapi(createOrderRoute.route, createOrderRoute.handler);
router.openapi(deleteOrderRoute.route, deleteOrderRoute.handler);
router.openapi(updateStatusRoute.route, updateStatusRoute.handler);
router.openapi(assignDriverRoute.route, assignDriverRoute.handler);
router.openapi(unassignDriverRoute.route, unassignDriverRoute.handler);
router.openapi(returnOrderProductRoute.route, returnOrderProductRoute.handler);
router.openapi(dispatchToCompanyRoute.route, dispatchToCompanyRoute.handler);
router.openapi(validateShipmentRoute.route, validateShipmentRoute.handler);
router.openapi(updateShipmentRoute.route, updateShipmentRoute.handler);
router.openapi(cancelShipmentRoute.route, cancelShipmentRoute.handler);
router.openapi(askReturnRoute.route, askReturnRoute.handler);
router.openapi(confirmReturnReceptionRoute.route, confirmReturnReceptionRoute.handler);
router.openapi(addRemarkRoute.route, addRemarkRoute.handler);
router.openapi(getRemarksRoute.route, getRemarksRoute.handler);
router.openapi(getTrackingRoute.route, getTrackingRoute.handler);
router.openapi(proxyLabelRoute.route, proxyLabelRoute.handler);
router.openapi(syncOrderCarrierRoute.route, syncOrderCarrierRoute.handler);

export default router;
