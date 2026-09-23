import { sqliteTable, text, integer, real, uniqueIndex, index, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const authNow = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  role: text("role", { enum: ["admin", "staff", "confirmer", "driver"] })
    .notNull()
    .default("staff"),
  status: text("status", { enum: ["active", "inactive"] })
    .notNull()
    .default("active"),
  apiKey: text("api_key").unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
  /** UI language preference for emails: "ar" | "en" */
  language: text("language").notNull().default("en"),
});

export const userScopes = sqliteTable("user_scopes", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  grantedBy: text("granted_by"),
  grantedAt: text("granted_at").notNull(),
});

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  phone2: text("phone2"),
  /** Wilaya FK — authority for wilaya. Kept in sync with `wilaya` text column. */
  wilayaId: integer("wilaya_id").references(() => wilayas.id),
  /** Commune FK — authority for commune. Kept in sync with `commune` text column. */
  communeId: text("commune_id").references(() => communes.id),
  wilaya: text("wilaya").notNull(),
  commune: text("commune"),
  address: text("address"),
  totalOrders: integer("total_orders").notNull().default(0),
  totalSpent: real("total_spent").notNull().default(0),
  createdAt: text("created_at").notNull(),
  lastOrderAt: text("last_order_at"),
});

// ─── Customer Groups ──────────────────────────────────────────────────────────

/**
 * Named customer segments (e.g. "VIP", "Wholesale", "Problematic").
 * Customers are linked via customer_group_members.
 */
export const customerGroups = sqliteTable("customer_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  /** Hex color for UI display, e.g. "#6366f1" */
  color: text("color").notNull().default("#6366f1"),
  /** Denormalised count — incremented/decremented on member add/remove. */
  memberCount: integer("member_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Junction table linking customers to groups.
 * A customer can belong to multiple groups.
 */
export const customerGroupMembers = sqliteTable("customer_group_members", {
  id: text("id").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  groupId: text("group_id")
    .notNull()
    .references(() => customerGroups.id, { onDelete: "cascade" }),
  assignedAt: text("assigned_at").notNull(),
}, (t) => ({
  customerGroupUnique: uniqueIndex("customer_group_members_customer_group_unique").on(t.customerId, t.groupId),
}));

/**
 * Named labels for customers (e.g. "vip", "returner", "wholesale").
 * Lighter than groups — no description, just name + color.
 * assignmentCount is denormalised for fast display.
 */
export const customerTags = sqliteTable("customer_tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("#64748b"),
  assignmentCount: integer("assignment_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Junction table linking customers to tags.
 * A customer can have multiple tags.
 */
export const customerTagAssignments = sqliteTable("customer_tag_assignments", {
  id: text("id").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  tagId: text("tag_id")
    .notNull()
    .references(() => customerTags.id, { onDelete: "cascade" }),
  assignedAt: text("assigned_at").notNull(),
}, (t) => ({
  customerTagUnique: uniqueIndex("customer_tag_assignments_customer_tag_unique").on(t.customerId, t.tagId),
}));

// ─── Algeria Reference Data ───────────────────────────────────────────────────

/**
 * Algeria's 58 official wilayas.
 * Integer PK matches the official wilaya number (1–58) used by logistics APIs
 * like NOEST, Yalidine, and ZR Express.
 */
export const wilayas = sqliteTable("wilayas", {
  id: integer("id").primaryKey(), // Official wilaya number 1-58
  name: text("name").notNull(),   // "Alger"
  nameAr: text("name_ar").notNull(), // "الجزائر"
});

/**
 * Communes (municipalities) within each wilaya.
 * Seeded with major communes; postal codes for stop-desk lookups.
 */
export const communes = sqliteTable("communes", {
  id: text("id").primaryKey(),
  wilayaId: integer("wilaya_id")
    .notNull()
    .references(() => wilayas.id),
  name: text("name").notNull(),
  nameAr: text("name_ar").notNull(),
  postalCode: text("postal_code"),
});

// ─── Carrier geo names ─────────────────────────────────────────────────────────

/**
 * Per-carrier exact wilaya name strings. Carriers that match addresses by
 * name (Yalidine) reject parcels whose strings differ from their own
 * spellings; these rows carry the carrier's exact string for our wilaya IDs.
 * Carriers absent here keep the reference-table name.
 */
export const carrierWilayas = sqliteTable("carrier_wilayas", {
  carrierCode: text("carrier_code").notNull(),
  wilayaId: integer("wilaya_id")
    .notNull()
    .references(() => wilayas.id),
  carrierName: text("carrier_name").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.carrierCode, t.wilayaId] }),
}));

/** Same contract as carrier_wilayas, one level down. */
export const carrierCommunes = sqliteTable("carrier_communes", {
  carrierCode: text("carrier_code").notNull(),
  communeId: text("commune_id")
    .notNull()
    .references(() => communes.id),
  carrierName: text("carrier_name").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.carrierCode, t.communeId] }),
}));

// ─── Shipping Profiles ────────────────────────────────────────────────────────

/**
 * Customer shipping rate cards.
 *
 * Defines what the CUSTOMER pays (deliveryFee on orders) per wilaya/commune.
 * Used by: store default (isDefault=true) and product-level overrides
 * (products.shippingProfileId). Drivers and delivery companies do NOT
 * reference these profiles — driver pay lives in driver_compensations.
 */
export const shippingProfiles = sqliteTable("shipping_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** When true, rates from this profile are auto-applied on order creation. */
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Per-wilaya customer delivery rates within a shipping profile.
 *
 * homePrice/stopDeskPrice = what the customer pays for home / stop-desk delivery.
 * homeEnabled / stopDeskEnabled control whether orders can be placed for this
 * wilaya in that delivery mode. Defaults: home=true (open), stopDesk=false
 * (must be explicitly enabled once a carrier with stop desks is connected).
 *
 * Commune-level price + availability overrides live in shipping_rule_communes
 * (sparse — only exceptions; NULL = inherit from wilaya rule).
 *
 * Driver payroll is NOT stored here — see driver_compensations.
 */
export const shippingRules = sqliteTable("shipping_rules", {
  id: text("id").primaryKey(),
  profileId: text("profile_id")
    .notNull()
    .references(() => shippingProfiles.id, { onDelete: "cascade" }),
  wilayaId: integer("wilaya_id")
    .notNull()
    .references(() => wilayas.id),
  homePrice: real("home_price").notNull().default(0),
  stopDeskPrice: real("stop_desk_price").notNull().default(0),
  /** Whether home delivery is offered to this wilaya under this profile. */
  homeEnabled: integer("home_enabled", { mode: "boolean" }).notNull().default(true),
  /** Whether stop-desk pickup is offered to this wilaya under this profile. */
  stopDeskEnabled: integer("stop_desk_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

/**
 * Commune-level delivery mode + price overrides within a shipping rule.
 *
 * SPARSE table — only rows where a commune differs from its wilaya rule default.
 * NULL in any column = "inherit from the wilaya rule".
 *
 * Resolution logic:
 *   effective.homeEnabled     = commune.homeEnabled     ?? wilayaRule.homeEnabled
 *   effective.stopDeskEnabled = commune.stopDeskEnabled ?? wilayaRule.stopDeskEnabled
 *   effective.homePrice       = commune.homePrice       ?? wilayaRule.homePrice
 *   effective.stopDeskPrice   = commune.stopDeskPrice   ?? wilayaRule.stopDeskPrice
 */
export const shippingRuleCommunes = sqliteTable("shipping_rule_communes", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id")
    .notNull()
    .references(() => shippingRules.id, { onDelete: "cascade" }),
  communeId: text("commune_id")
    .notNull()
    .references(() => communes.id, { onDelete: "cascade" }),
  /** null = inherit from wilaya rule. */
  homeEnabled: integer("home_enabled", { mode: "boolean" }),
  /** null = inherit from wilaya rule. */
  stopDeskEnabled: integer("stop_desk_enabled", { mode: "boolean" }),
  /** null = inherit price from wilaya rule. */
  homePrice: real("home_price"),
  /** null = inherit price from wilaya rule. */
  stopDeskPrice: real("stop_desk_price"),
}, (t) => ({
  ruleCommuneUnique: uniqueIndex("shipping_rule_communes_unique").on(t.ruleId, t.communeId),
}));

// ─── Drivers ─────────────────────────────────────────────────────────────────

/**
 * In-house delivery drivers managed by the store.
 * Per-wilaya payroll lives in driver_compensations — what the driver earns
 * per delivery in each wilaya (independent of what the customer was charged).
 */
export const drivers = sqliteTable("drivers", {
  id: text("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phone: text("phone").notNull(),
  phone2: text("phone2"),
  vehicleType: text("vehicle_type", { enum: ["motorcycle", "car", "van"] }),
  status: text("status", { enum: ["available", "busy", "inactive"] })
    .notNull()
    .default("available"),
  /** Cumulative deliveries completed (incremented on status → delivered). */
  totalDelivered: integer("total_delivered").notNull().default(0),
  /** Cumulative delivery fees earned (incremented on status → delivered). */
  totalEarnings: real("total_earnings").notNull().default(0),
  /** COD cash collected by driver but not yet remitted to the business. */
  pendingCash: real("pending_cash").notNull().default(0),
  /** Total COD cash remitted to the business. */
  totalPaid: real("total_paid").notNull().default(0),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Driver payroll: per-wilaya delivery fee the store pays the driver.
 *
 * Completely independent of what the customer was charged (shipping_rules).
 * When a driver is assigned to an order, the system looks up the matching
 * (driverId, wilayaId) row here to set orders.driverFee.
 *
 * Sparse: no row = the store doesn't pay this driver for deliveries in that wilaya
 * (assignment still works with driverFee = 0; admin should fill the row).
 */
export const driverCompensations = sqliteTable("driver_compensations", {
  id: text("id").primaryKey(),
  driverId: text("driver_id")
    .notNull()
    .references(() => drivers.id, { onDelete: "cascade" }),
  wilayaId: integer("wilaya_id")
    .notNull()
    .references(() => wilayas.id),
  /** What the store pays this driver per delivery in this wilaya. */
  feePerDelivery: real("fee_per_delivery").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => ({
  driverWilayaUnique: uniqueIndex("driver_compensations_driver_wilaya_unique").on(t.driverId, t.wilayaId),
}));

// ─── Driver Payments ─────────────────────────────────────────────────────────

/**
 * Tracks COD remittances and fee payments for in-house drivers.
 * Each record represents one payment event (settled for a batch of orders).
 * Types:
 *   cod_remittance  — driver hands collected COD cash back to shop
 *   fee_payment     — shop pays driver his earned delivery fees
 *   net_settlement  — hybrid: driver hands (COD − fees) net; both settled together
 */
export const driverPayments = sqliteTable("driver_payments", {
  id: text("id").primaryKey(),
  driverId: text("driver_id")
    .notNull()
    .references(() => drivers.id, { onDelete: "cascade" }),
  type: text("type", {
    enum: ["cod_remittance", "fee_payment", "net_settlement"],
  }).notNull(),
  /** Settled amount (COD total, fee total, or net COD−fees depending on type). */
  amount: real("amount").notNull(),
  /** Number of orders included in this payment batch. */
  orderCount: integer("order_count").notNull().default(0),
  notes: text("notes"),
  /** User ID of the team member who recorded this payment. */
  createdBy: text("created_by").notNull(),
  /** Denormalised display name for audit trail. */
  createdByName: text("created_by_name").notNull(),
  createdAt: text("created_at").notNull(),
});

// ─── Delivery Companies ───────────────────────────────────────────────────────

/**
 * Third-party delivery companies (Yalidine, NOEST, ZR Express, etc.).
 *
 * Stores API credentials + capabilities only — no pricing. What the customer
 * pays always comes from shipping_rules; what the store pays the carrier is
 * whatever the carrier invoices out-of-band.
 */
export const deliveryCompanies = sqliteTable("delivery_companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),       // "Yalidine"
  nameAr: text("name_ar").notNull(),  // "ياليدين"
  /** Short unique code used in API calls and display. e.g. "yalidine" */
  code: text("code").notNull().unique(),
  website: text("website"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),

  // ── API Integration ──────────────────────────────────────────────────────
  /** Base URL of the company's REST API. */
  apiEndpoint: text("api_endpoint"),
  /** Bearer token or API key for authentication. */
  apiToken: text("api_token"),
  /** NOEST-specific user GUID required for shipment creation. */
  apiUserGuid: text("api_user_guid"),

  // ── Capabilities ─────────────────────────────────────────────────────────
  supportsHomeDelivery: integer("supports_home_delivery", { mode: "boolean" })
    .notNull()
    .default(true),
  supportsStopDesk: integer("supports_stop_desk", { mode: "boolean" })
    .notNull()
    .default(true),
  supportsTracking: integer("supports_tracking", { mode: "boolean" })
    .notNull()
    .default(false),

  // ── Webhook Integration ───────────────────────────────────────────────────
  /**
   * ZR Express: "whsec_xxx" Svix secret fetched from ZR webhook endpoint API.
   * Yalidine: secret key from Yalidine Webhooks Dashboard.
   * null = signature verification skipped (warn in logs).
   */
  webhookSecret: text("webhook_secret"),
  /**
   * ZR Express only: registered endpoint UUID returned by ZR webhook registration API.
   * Used for unregister calls. null for Yalidine (manual setup, no endpoint ID).
   */
  webhookEndpointId: text("webhook_endpoint_id"),
  /**
   * ZR Express only: custom state name → our status mapping stored as JSON.
   * Format: { ourStatus: [zrStateName, ...] }
   * null = use code defaults only. null for Yalidine (statuses are hardcoded).
   */
  webhookStatusMapping: text("webhook_status_mapping"),

  // ── Carrier status auto-sync (polling) ──────────────────────────────────
  /**
   * Poll this company's tracking API on the cron tick and apply status
   * changes through the shared forward-only rank guard. ON by default:
   * it is the only status source for NOEST/EcoTrack (no inbound webhooks)
   * and the catch-up path when a Yalidine/ZR webhook is missed.
   */
  autoSyncEnabled: integer("auto_sync_enabled", { mode: "boolean" }).notNull().default(true),
  /** Minimum minutes between two polls of the same order for this company. */
  autoSyncIntervalMin: integer("auto_sync_interval_min").notNull().default(30),

  /**
   * If true, our dispatcher calls valid/order immediately after create/order (default).
   * If false, the team must manually validate via POST /orders/:id/validate-shipment.
   * Set false for Packers (ecotrack) — team controls when parcel enters courier flow.
   */
  autoValidate: integer("auto_validate", { mode: "boolean" }).notNull().default(true),

  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ─── Orders ───────────────────────────────────────────────────────────────────

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  orderNumber: text("order_number").notNull().unique(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id),
  customerName: text("customer_name").notNull(),
  phone: text("phone").notNull(),
  /** Wilaya ID (integer 1-58) — authority for wilaya. Names derived at query/dispatch time. */
  wilayaId: integer("wilaya_id").references(() => wilayas.id),
  /** Commune FK — authority for commune. Names derived at query/dispatch time. */
  communeId: text("commune_id").references(() => communes.id),
  city: text("city"),
  address: text("address"),
  price: real("price").notNull(),
  notes: text("notes"),
  status: text("status", {
    enum: [
      "new",
      "confirmed",
      "unreachable",
      "preparing",
      "ready",
      "assigned",
      "dispatched",
      "out_for_delivery",
      "delivered",
      "returned",
      "cancelled",
    ],
  }).notNull().default("new"),
  orderType: text("order_type", { enum: ["online", "offline"] })
    .notNull()
    .default("online"),

  // ── Delivery assignment ──────────────────────────────────────────────────
  /**
   * "unassigned" at creation — the customer only picks a price tier; the admin
   * later picks how to fulfil (driver vs company). Writes to driver/company
   * assignment endpoints flip this automatically.
   */
  deliveryMethod: text("delivery_method", { enum: ["unassigned", "driver", "company"] })
    .notNull()
    .default("unassigned"),
  driverId: text("driver_id").references(() => drivers.id),
  companyId: text("company_id").references(() => deliveryCompanies.id),

  assignedAt: text("assigned_at"),
  assignedBy: text("assigned_by"),
  assignmentNotes: text("assignment_notes"),

  // ── Tracking ─────────────────────────────────────────────────────────────
  trackingNumber: text("tracking_number"),
  trackingUrl: text("tracking_url"),
  externalOrderId: text("external_order_id"),

  // ── Delivery specifics ────────────────────────────────────────────────────
  deliveryType: text("delivery_type", { enum: ["home", "stop_desk"] })
    .notNull()
    .default("home"),
  /**
   * Stop-desk / pickup-point station code.
   * Required when deliveryType = "stop_desk".
   * NOEST: alphanumeric station code (e.g. "16A").
   * ZR Express: territory UUID of the pickup-point (detected by UUID format in adapter).
   * Both providers use this single field — adapter auto-detects the format.
   */
  stationCode: text("station_code"),
  /**
   * Delivery fee charged to the customer (from the store's shipping profile).
   * Set at order creation and NEVER changed after that.
   */
  deliveryFee: real("delivery_fee").notNull().default(0),
  /**
   * The driver's cut for this delivery (from the driver's shipping profile for this wilaya).
   * Set when a driver is assigned.
   */
  driverFee: real("driver_fee").notNull().default(0),
  /**
   * Cash-on-delivery amount the driver must collect from the customer.
   * Set to order.price + delivery_fee on creation. Added to driver.pendingCash when delivered.
   */
  codAmount: real("cod_amount").notNull().default(0),

  /** Parcel weight in kg — sent to carrier API when set (optional). */
  weight: real("weight"),
  /** Fragile parcel flag — sent to carrier API when set (optional). */
  isFragile: integer("is_fragile", { mode: "boolean" }),

  pickupTime: text("pickup_time"),
  deliveryTime: text("delivery_time"),
  deliveryAttempts: integer("delivery_attempts").default(0),

  photos: text("photos"), // JSON array

  // ── Payment settlement tracking ───────────────────────────────────────────
  /** Set when the COD amount of this order has been remitted to the shop. */
  codPaymentId: text("cod_payment_id"),
  /** Set when the driver's delivery fee for this order has been paid out. */
  feePaymentId: text("fee_payment_id"),

  // ── Meta Pixel / CAPI attribution ────────────────────────────────────────
  /** _fbc cookie captured at placement — links the sale back to the ad click. */
  fbc: text("fbc"),
  /** _fbp cookie captured at placement — browser identity for EMQ. */
  fbp: text("fbp"),
  /** CF-Connecting-IP at placement — sent as client_ip_address in CAPI event. */
  ipAddress: text("ip_address"),
  /** User-Agent at placement — sent as client_user_agent in CAPI event. */
  userAgent: text("user_agent"),

  // ── Landing page attribution (appended by migration 0019 — keep last) ────
  /** Landing page the order was placed from (best-effort attribution — never blocks an order). */
  landingPageId: text("landing_page_id"),

  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),

  // ── Carrier status auto-sync (migration 0035 appends these — keep last) ──
  /** When the tracking API was last polled for this order (throttle cursor). */
  lastTrackingSyncAt: text("last_tracking_sync_at"),
  /** Raw carrier status string seen at the last poll — audit for unmapped values. */
  lastCarrierStatus: text("last_carrier_status"),
  /** Consecutive poll failures; the engine backs off and surfaces this in the UI. */
  trackingSyncFails: integer("tracking_sync_fails").notNull().default(0),
});

export const adminApprovalRequests = sqliteTable("admin_approval_requests", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  title: text("title").notNull(),
  payload: text("payload").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "expired", "failed"] }).notNull().default("pending"),
  requestedBy: text("requested_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  requestedByName: text("requested_by_name").notNull(),
  decidedByTelegramId: text("decided_by_telegram_id"),
  decisionNote: text("decision_note"),
  telegramMessageId: text("telegram_message_id"),
  expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => ({ statusExpiryIdx: index("admin_approvals_status_expiry_idx").on(t.status, t.expiresAt) }));

export const orderConfirmationAssignments = sqliteTable("order_confirmation_assignments", {
  orderId: text("order_id").primaryKey().references(() => orders.id, { onDelete: "cascade" }),
  assigneeId: text("assignee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  assignedBy: text("assigned_by").references(() => users.id, { onDelete: "set null" }),
  assignedAt: text("assigned_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => ({ assigneeIdx: index("order_confirmation_assignee_idx").on(t.assigneeId, t.assignedAt) }));

export const operationAutomationSettings = sqliteTable("operation_automation_settings", {
  id: text("id").primaryKey().default("default"),
  autoAssignEnabled: integer("auto_assign_enabled", { mode: "boolean" }).notNull().default(true),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const operationAgentSettings = sqliteTable("operation_agent_settings", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  autoAssignEnabled: integer("auto_assign_enabled", { mode: "boolean" }).notNull().default(true),
  maxOpenOrders: integer("max_open_orders").notNull().default(25),
  maxDailyOrders: integer("max_daily_orders").notNull().default(50),
  commissionType: text("commission_type", { enum: ["fixed", "percentage"] }).notNull().default("fixed"),
  commissionValue: real("commission_value").notNull().default(0),
  confirmationCommissionType: text("confirmation_commission_type", { enum: ["fixed", "percentage"] }).notNull().default("fixed"),
  confirmationCommissionValue: real("confirmation_commission_value").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const operationTasks = sqliteTable("operation_tasks", {
  id: text("id").primaryKey(), title: text("title").notNull(), description: text("description"),
  type: text("type", { enum: ["confirmation", "callback", "address_review", "shipment_follow_up", "follow_up"] }).notNull().default("follow_up"),
  status: text("status", { enum: ["open", "in_progress", "completed", "cancelled"] }).notNull().default("open"),
  priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull().default("normal"),
  orderId: text("order_id").references(() => orders.id, { onDelete: "cascade" }),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  assigneeId: text("assignee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  dueAt: text("due_at"), completedAt: text("completed_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => ({ assigneeStatusDueIdx: index("operation_tasks_assignee_status_due_idx").on(t.assigneeId, t.status, t.dueAt), orderIdx: index("operation_tasks_order_idx").on(t.orderId) }));

export const staffCommissions = sqliteTable("staff_commission_events", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  category: text("category", { enum: ["confirmation", "follow_up"] }).notNull(),
  amount: real("amount").notNull(),
  rateType: text("rate_type", { enum: ["fixed", "percentage"] }).notNull(),
  rateValue: real("rate_value").notNull(),
  status: text("status", { enum: ["pending", "earned", "paid", "reversed"] }).notNull().default("pending"),
  earnedAt: text("earned_at"), paidAt: text("paid_at"), reversedAt: text("reversed_at"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => ({
  orderCategoryIdx: uniqueIndex("staff_commission_events_order_category_idx").on(t.orderId, t.category),
  userStatusIdx: index("staff_commission_events_user_status_idx").on(t.userId, t.status, t.createdAt),
}));

export const telegramApprovalConfig = sqliteTable("telegram_approval_config", {
  id: text("id").primaryKey().default("default"),
  botToken: text("bot_token").notNull(), chatId: text("chat_id").notNull(), webhookSecret: text("webhook_secret").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});

export const telegramApprovalPolicies = sqliteTable("telegram_approval_policies", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.action] }),
  userIdx: index("telegram_approval_policies_user_idx").on(t.userId, t.enabled),
}));

export const supportChannels = sqliteTable("support_channels", {
  id: text("id").primaryKey(), type: text("type", { enum: ["whatsapp", "email"] }).notNull(), name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true), provider: text("provider").notNull(), senderId: text("sender_id"),
  accessToken: text("access_token"), verifyToken: text("verify_token"), appSecret: text("app_secret"), webhookSecret: text("webhook_secret"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => ({ typeIdx: uniqueIndex("support_channels_type_idx").on(t.type) }));

export const supportConversations = sqliteTable("support_conversations", {
  id: text("id").primaryKey(), channelId: text("channel_id").notNull().references(() => supportChannels.id, { onDelete: "cascade" }),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }), orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
  contact: text("contact").notNull(), contactName: text("contact_name"), subject: text("subject"),
  status: text("status", { enum: ["open", "pending", "resolved", "closed"] }).notNull().default("open"),
  priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull().default("normal"),
  assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }), unreadCount: integer("unread_count").notNull().default(0),
  lastMessageAt: text("last_message_at").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => ({ statusLastIdx: index("support_conversations_status_last_idx").on(t.status, t.lastMessageAt), assigneeIdx: index("support_conversations_assignee_idx").on(t.assigneeId, t.status), contactIdx: index("support_conversations_contact_idx").on(t.contact) }));

export const supportMessages = sqliteTable("support_messages", {
  id: text("id").primaryKey(), conversationId: text("conversation_id").notNull().references(() => supportConversations.id, { onDelete: "cascade" }),
  direction: text("direction", { enum: ["inbound", "outbound", "internal"] }).notNull(), channelType: text("channel_type", { enum: ["whatsapp", "email"] }).notNull(),
  senderId: text("sender_id").references(() => users.id, { onDelete: "set null" }), body: text("body").notNull(), externalId: text("external_id"),
  deliveryStatus: text("delivery_status", { enum: ["queued", "sent", "delivered", "read", "failed", "received"] }).notNull().default("queued"), errorCode: text("error_code"), createdAt: text("created_at").notNull(),
}, (t) => ({ externalIdx: uniqueIndex("support_messages_external_idx").on(t.channelType, t.externalId), conversationIdx: index("support_messages_conversation_idx").on(t.conversationId, t.createdAt) }));

export const supportTickets = sqliteTable("support_tickets", {
  id: text("id").primaryKey(), ticketNumber: text("ticket_number").notNull().unique(), conversationId: text("conversation_id").references(() => supportConversations.id, { onDelete: "set null" }),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }), orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
  subject: text("subject").notNull(), description: text("description"), status: text("status", { enum: ["open", "in_progress", "waiting_customer", "resolved", "closed"] }).notNull().default("open"),
  priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull().default("normal"), assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
  createdBy: text("created_by").notNull().references(() => users.id), dueAt: text("due_at"), resolvedAt: text("resolved_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => ({ statusPriorityIdx: index("support_tickets_status_priority_idx").on(t.status, t.priority, t.createdAt), assigneeIdx: index("support_tickets_assignee_idx").on(t.assigneeId, t.status) }));

export const customerOrderLinks = sqliteTable("customer_order_links", {
  id: text("id").primaryKey(), orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }), tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(), revokedAt: text("revoked_at"), lastViewedAt: text("last_viewed_at"), createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }), createdAt: text("created_at").notNull(),
}, (t) => ({ orderIdx: index("customer_order_links_order_idx").on(t.orderId, t.expiresAt) }));

export const orderAssignments = sqliteTable("order_assignments", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),

  assigneeType: text("assignee_type", { enum: ["driver", "company"] }).notNull(),
  assigneeId: text("assignee_id").notNull(),
  assigneeName: text("assignee_name").notNull(),

  assignedBy: text("assigned_by").notNull(),
  assignedAt: text("assigned_at").notNull(),
  unassignedAt: text("unassigned_at"),
  reason: text("reason"),

  acceptedAt: text("accepted_at"),
  pickupAt: text("pickup_at"),
  deliveredAt: text("delivered_at"),
  status: text("status", {
    enum: ["assigned", "accepted", "picked_up", "delivered", "returned", "cancelled"],
  })
    .notNull()
    .default("assigned"),
});

export const orderStatusHistory = sqliteTable("order_status_history", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  status: text("status", {
    enum: [
      "new",
      "confirmed",
      "unreachable",
      "preparing",
      "ready",
      "assigned",
      "dispatched",
      "out_for_delivery",
      "delivered",
      "returned",
      "cancelled",
    ],
  }).notNull(),
  timestamp: text("timestamp").notNull(),
  by: text("by"),
});

// ─── Product Catalog ─────────────────────────────────────────────────────────

export const productCategories = sqliteTable("product_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  parentId: text("parent_id"), // self-reference at app level
  imageUrl: text("image_url"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  metaKeywords: text("meta_keywords"),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  handle: text("handle").notNull().unique(), // URL slug (was "slug")
  currency: text("currency").notNull().default("DZD"),
  price: integer("price").notNull(), // base price in DZD (whole number)
  compareAtPrice: integer("compare_at_price"),
  costPrice: integer("cost_price"),
  type: text("type", { enum: ["PHYSICAL", "DIGITAL"] }).notNull().default("PHYSICAL"),
  hasVariants: integer("has_variants", { mode: "boolean" }).notNull().default(false),
  variantOptions: text("variant_options"), // JSON: [{name: string, values: [{value: string, hexColor?: string}]}]
  sku: text("sku").unique(), // only for simple products (hasVariants=false)
  inventory: integer("inventory").notNull().default(0), // only for simple products
  /**
   * Master inventory toggle. When false, the product is excluded from stock
   * tracking entirely:
   *   - Simple: products.inventory is ignored; orders never deduct it.
   *   - Variant parent: ALL of its variants are excluded — orders never deduct
   *     from any variant, and stock alerts/overview hide the whole product.
   * Variant rows do not have their own toggle; the parent flag governs them.
   */
  trackInventory: integer("track_inventory", { mode: "boolean" }).notNull().default(true),
  /** Alert when inventory drops to or below this number (0 = disabled). */
  lowStockThreshold: integer("low_stock_threshold").notNull().default(5),
  categoryId: text("category_id").references(() => productCategories.id, { onDelete: "set null" }),
  tags: text("tags"), // JSON string[]
  visibility: integer("visibility", { mode: "boolean" }).notNull().default(true),
  status: text("status", { enum: ["DRAFT", "ACTIVE", "ARCHIVED"] }).notNull().default("ACTIVE"),
  showInStore: integer("show_in_store", { mode: "boolean" }).notNull().default(true),
  storeFeatured: integer("store_featured", { mode: "boolean" }).notNull().default(false),
  deletedAt: text("deleted_at"),
  publishedAt: text("published_at"),
  /**
   * Product-level shipping profile override.
   * When set: orders of this product use this profile for deliveryFee resolution.
   * When null: store default profile (isDefault=true) is used.
   */
  shippingProfileId: text("shipping_profile_id")
    .references(() => shippingProfiles.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const productVariants = sqliteTable("product_variants", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  variations: text("variations").notNull(), // JSON: {"Color": "Red", "Size": "M"}
  currency: text("currency").notNull().default("DZD"),
  price: integer("price").notNull(), // price in DZD
  compareAtPrice: integer("compare_at_price"),
  sku: text("sku").notNull().unique(),
  barcode: text("barcode"),
  inventory: integer("inventory").notNull().default(0),
  /** Alert when variant inventory drops to or below this number (0 = disabled). */
  lowStockThreshold: integer("low_stock_threshold").notNull().default(5),
  weightKg: real("weight_kg"),
  imageId: text("image_id"), // reference to productImages.id
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  position: integer("position").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const productImages = sqliteTable("product_images", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  src: text("src").notNull(), // original URL
  r2Key: text("r2_key"),
  srcSm: text("src_sm"),
  srcMd: text("src_md"),
  srcLg: text("src_lg"),
  altText: text("alt_text"),
  width: integer("width"),
  height: integer("height"),
  type: integer("type").notNull().default(1), // 1=image, 2=video
  position: integer("position").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Status lifecycle value for orders — derived from the column enum. */
export type OrderStatus = (typeof orders.$inferSelect)["status"];

export const orderProducts = sqliteTable("order_products", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  productId: text("product_id")
    .notNull()
    .references(() => products.id),
  productName: text("product_name").notNull(),
  variantId: text("variant_id").references(() => productVariants.id),
  variantLabel: text("variant_label"), // denormalized: "أحمر / XL"
  sku: text("sku"), // denormalized from products.sku / product_variants.sku at creation time
  quantity: integer("quantity").notNull(),
  pricePerUnit: real("price_per_unit").notNull(),
  lineTotal: real("line_total").notNull(),
  /**
   * Per-line fulfilment outcome — supports Algerian box-opening returns.
   *   fulfilled           — customer kept all units (returnedQuantity = 0)
   *   partially_returned  — customer kept some, returned some (0 < returnedQuantity < quantity)
   *   returned            — customer refused the whole line (returnedQuantity = quantity)
   */
  status: text("status", { enum: ["fulfilled", "partially_returned", "returned"] })
    .notNull()
    .default("fulfilled"),
  /** Units the customer refused at the door. 0 when status = fulfilled. */
  returnedQuantity: integer("returned_quantity").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

// ─── Delivery Provider Integration ───────────────────────────────────────────

/**
 * Carrier stop-desk / pickup-point cache and admin control table.
 *
 * Populated by POST /delivery-companies/:id/sync-stop-desks (calls provider.getStopDesks()).
 * The `active` flag survives re-syncs for desks still listed at the carrier — only the
 * admin can toggle it. A desk removed at the carrier is hard-deleted on sync (its flag
 * goes with it); if it reappears later it comes back active by default. This allows
 * the admin to deactivate specific communes for their account.
 *
 * `code` maps to what is sent as stationCode in the carrier API:
 *   EcoTrack/Packers → code_postal string (e.g. "16001")
 *   NOEST            → station code string (e.g. "16A")
 *   Yalidine         → center_id as string (e.g. "42")
 *   ZR Express       → territory UUID
 */
export const companyStopDesks = sqliteTable("company_stop_desks", {
  id:        text("id").primaryKey(),
  companyId: text("company_id")
               .notNull()
               .references(() => deliveryCompanies.id, { onDelete: "cascade" }),
  code:      text("code").notNull(),
  name:      text("name").notNull(),
  commune:   text("commune"),
  wilayaId:  integer("wilaya_id").references(() => wilayas.id),
  address:   text("address"),
  phones:    text("phones"),   // JSON: string[]
  /** Admin-controlled: false = hidden from dispatch dialog. Never reset by sync. */
  active:    integer("active", { mode: "boolean" }).notNull().default(true),
  syncedAt:  text("synced_at").notNull(),
}, (t) => ({
  companyCodeUnique: uniqueIndex("company_stop_desks_company_code_unique")
                       .on(t.companyId, t.code),
}));

/**
 * Tracks shipments created via third-party delivery company APIs.
 * One record per API-dispatched shipment, linked to the order.
 *
 * Intentionally carries NO status column — the order's lifecycle is owned by
 * orders.status (single source of truth). This table only stores the
 * carrier-side handle (tracking number, label, raw response) and the
 * validated flag for the provider's two-step create→validate flow.
 */
export const companyShipments = sqliteTable("company_shipments", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  companyId: text("company_id")
    .notNull()
    .references(() => deliveryCompanies.id),
  /** Tracking number returned by the company API (e.g. "ECS12345678"). */
  trackingNumber: text("tracking_number").notNull(),
  /** Whether the shipment has been validated via the company's validate endpoint. */
  validated: integer("validated", { mode: "boolean" }).notNull().default(false),
  /** URL to the printable shipping label PDF, if available. */
  labelUrl: text("label_url"),
  /** Raw JSON response from the create-shipment API call. */
  rawResponse: text("raw_response"), // JSON
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Audit log for every outbound API call to delivery company APIs.
 */
export const companyApiLogs = sqliteTable("company_api_logs", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => deliveryCompanies.id),
  /** The order this call was related to, if any. */
  orderId: text("order_id").references(() => orders.id),
  /** Short action name: "create_shipment", "validate", "track", "delete", "get_fees" */
  action: text("action").notNull(),
  method: text("method").notNull(), // "GET" | "POST" | "PATCH" | "DELETE"
  endpoint: text("endpoint").notNull(), // relative path, e.g. "/api/public/create/order"
  /** Serialised request payload (sensitive fields stripped). */
  requestBody: text("request_body"), // JSON
  httpStatus: integer("http_status"),
  /** Serialised response body (truncated if large). */
  responseBody: text("response_body"), // JSON
  success: integer("success", { mode: "boolean" }).notNull().default(false),
  errorMessage: text("error_message"),
  /** Round-trip time in milliseconds. */
  durationMs: integer("duration_ms"),
  createdAt: text("created_at").notNull(),
});

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * One store per deployment. Holds branding, theme, and SEO settings
 * editable from the dashboard.
 */
export const stores = sqliteTable("stores", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  domain: text("domain"),
  logoUrl: text("logo_url"),

  // ── Theme ─────────────────────────────────────────────────────────────────
  /** Active theme slug: "theme01", "theme02", etc. */
  themeId: text("theme_id").notNull().default("theme01"),
  /** Primary CTA color (hex, e.g. "#7c3aed") */
  primaryColor: text("primary_color").notNull().default("#7c3aed"),
  /** Accent / highlight color */
  accentColor: text("accent_color").notNull().default("#f59e0b"),
  /** Background color */
  bgColor: text("bg_color").notNull().default("#f8f8f8"),
  /** CSS font-family string */
  fontFamily: text("font_family").notNull().default("Cairo, sans-serif"),
  /** Google Fonts import URL (optional override) */
  fontUrl: text("font_url"),

  // ── Locale ────────────────────────────────────────────────────────────────
  /** Store UI language: "ar" | "en" */
  lang: text("lang", { enum: ["ar", "en"] }).notNull().default("ar"),
  currency: text("currency").notNull().default("DZD"),
  currencySymbol: text("currency_symbol").notNull().default("دج"),

  // ── Content (all user-facing text — no hardcoding in theme) ──────────────
  /**
   * JSON blob of every text string shown in the storefront.
   * Schema: StoreFrontContent (see cod-astro/theme01/src/lib/content.ts)
   * Editable from the dashboard Store Settings page.
   */
  contentJson: text("content_json"),

  // ── SEO ───────────────────────────────────────────────────────────────────
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  ogImage: text("og_image"),

  // ── Optional features ─────────────────────────────────────────────────────
  /** Top announcement bar text (null = hidden) */
  announcementBar: text("announcement_bar"),
  /** When false, reviews are hidden on the storefront and submission is disabled. */
  reviewsEnabled: integer("reviews_enabled", { mode: "boolean" }).notNull().default(true),

  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  /** Plaintext storefront API key — written on every provision so the merchant can view it in settings. */
  storeApiKey: text("store_api_key"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * API keys issued to Astro storefronts.
 * The raw key is never stored — only a SHA-256 hex digest.
 */
export const storeApiKeys = sqliteTable("store_api_keys", {
  id: text("id").primaryKey(),
  storeId: text("store_id")
    .notNull()
    .references(() => stores.id, { onDelete: "cascade" }),
  /** SHA-256 hex digest of the raw key */
  keyHash: text("key_hash").notNull().unique(),
  name: text("name").notNull().default("default"),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").notNull(),
});

// ─── Reviews ──────────────────────────────────────────────────────────────────

/**
 * Product reviews submitted by customers via the storefront.
 * Requires a valid order_id from the same store — identity comes from the order.
 * Moderated by the merchant: pending → approved | rejected.
 */
export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  storeId: text("store_id")
    .notNull()
    .references(() => stores.id, { onDelete: "cascade" }),
  productId: text("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  /** Denormalised order number for display (e.g. "ORD-0042"). */
  orderNumber: text("order_number").notNull(),
  /** Denormalised customer name from the order at submission time. */
  customerName: text("customer_name").notNull(),
  /** Star rating 1–5. Enforced at application layer and DB CHECK. */
  rating: integer("rating").notNull(),
  title: text("title"),
  body: text("body").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected"] })
    .notNull()
    .default("pending"),
  helpfulCount: integer("helpful_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => ({
  orderUnique: uniqueIndex("reviews_order_unique").on(t.orderId),
}));

// ─── Activity Logs ────────────────────────────────────────────────────────────

/**
 * Audit trail of all write actions performed by staff and admin users.
 * Only admins can query this table.
 */
export const activityLogs = sqliteTable("activity_logs", {
  id: text("id").primaryKey(),
  /** ID of the user who performed the action. */
  actorId: text("actor_id").notNull(),
  /** Denormalised name — preserved even if user is later deleted. */
  actorName: text("actor_name").notNull(),
  actorRole: text("actor_role", { enum: ["admin", "staff", "confirmer", "driver"] }).notNull(),
  /** Dot-notation action: "order.created", "user.role_changed", etc. */
  action: text("action").notNull(),
  /** Entity category: "order", "customer", "driver", "product", "user". */
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  /** Human-readable label at the time of action (order number, name, etc.). */
  entityLabel: text("entity_label"),
  /** Extra context as JSON (e.g. status transitions, amounts). */
  metadata: text("metadata"),
  createdAt: text("created_at").notNull(),
});

// ─── Stock Movements ──────────────────────────────────────────────────────────

/**
 * Every inventory change — regardless of source — creates one row here.
 * This is the audit trail and the backbone of all stock reporting.
 *
 * Movement types:
 *   PURCHASE          — stock received from supplier (delta > 0)
 *   ADJUSTMENT_ADD    — manual correction / count adjustment upward (delta > 0)
 *   ADJUSTMENT_REMOVE — manual correction / damage / loss (delta < 0)
 *   ORDER_DEDUCTED    — stock reserved when an order is confirmed (delta < 0)
 *   ORDER_CANCELLED   — stock restored when an order is cancelled (delta > 0)
 *   ORDER_RETURNED    — stock restored when a delivered order is returned (delta > 0)
 *   OFFLINE_SALE      — direct sale not via the online order system (delta < 0)
 */
export const stockMovements = sqliteTable("stock_movements", {
  id: text("id").primaryKey(),
  productId: text("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  /** NULL for simple products (hasVariants = false). */
  variantId: text("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  type: text("type", {
    enum: [
      "PURCHASE",
      "ADJUSTMENT_ADD",
      "ADJUSTMENT_REMOVE",
      "ORDER_DEDUCTED",
      "ORDER_CANCELLED",
      "ORDER_RETURNED",
      "OFFLINE_SALE",
    ],
  }).notNull(),
  /** Signed quantity change. Positive = stock in, negative = stock out. Never zero. */
  delta: integer("delta").notNull(),
  /** Inventory level immediately before this movement was applied. */
  qtyBefore: integer("qty_before").notNull(),
  /** Inventory level immediately after this movement was applied. */
  qtyAfter: integer("qty_after").notNull(),
  /** Human note explaining the reason (required for manual adjustments and offline sales). */
  reason: text("reason"),
  /** External reference — orderId for ORDER_* types, null otherwise. */
  reference: text("reference"),
  /** User ID of the team member who triggered this movement. */
  createdBy: text("created_by").notNull(),
  /** Denormalised name — preserved even if the user is later deleted. */
  createdByName: text("created_by_name").notNull(),
  createdAt: text("created_at").notNull(),
});


// ─── Webhook Events ───────────────────────────────────────────────────────────

/**
 * Idempotency + audit log for every inbound webhook delivery from ZR Express or Yalidine.
 * UNIQUE(provider, event_id) prevents the same event from being processed twice.
 *
 * result values:
 *   ok       — order status was updated
 *   ignored  — event received, logged, no status change (non-status event / terminal order / same status)
 *   unmapped — state/status name not found in any mapping; admin must add it
 *   error    — exception during processing; still returned 200 to provider
 */
export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(),
  /** 'zr_express' | 'yalidine' */
  provider: text("provider").notNull(),
  /** svix-id header (ZR) or event_id field (Yalidine) — idempotency key */
  eventId: text("event_id").notNull(),
  companyId: text("company_id")
    .notNull()
    .references(() => deliveryCompanies.id),
  /** null if order not found by tracking/reference */
  orderId: text("order_id").references(() => orders.id),
  /** raw tracking number from the provider payload */
  tracking: text("tracking"),
  /** 'parcel.state.updated' / 'parcel_status_updated' / etc. */
  eventType: text("event_type").notNull(),
  /** full JSON body for debugging and future reprocessing */
  rawPayload: text("raw_payload").notNull(),
  /** 'ok' | 'ignored' | 'unmapped' | 'error' */
  result: text("result").notNull().default("pending"),
  /** the status we set on the order (when result='ok') */
  newStatus: text("new_status"),
  /** Yalidine reason field / ZR situation name */
  reason: text("reason"),
  errorMsg: text("error_msg"),
  processedAt: text("processed_at"),
  createdAt: text("created_at").notNull(),
}, (t) => ({
  providerEventUnique: uniqueIndex("webhook_events_provider_event_unique").on(t.provider, t.eventId),
}));

/**
 * One row per auto-sync run (cron tick, manual trigger, or per-company trigger).
 *
 * Summary only — per-order outcomes live on orders (last_tracking_sync_at,
 * last_carrier_status, tracking_sync_fails) and per-call detail in
 * company_api_logs. `unmapped_statuses` keeps the distinct raw carrier
 * strings that had no mapping so the admin knows what to add.
 */
export const carrierSyncRuns = sqliteTable("carrier_sync_runs", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => deliveryCompanies.id, { onDelete: "cascade" }),
  /** 'cron' | 'manual' | 'company' */
  trigger: text("trigger").notNull().default("cron"),
  /** 'poll' = one tracking call per order; 'reconcile' = carrier list endpoint (EcoTrack). */
  mode: text("mode").notNull().default("poll"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  /** Orders with a tracking number that matched the run's selection. */
  scanned: integer("scanned").notNull().default(0),
  /** Orders actually polled at the carrier (scanned minus throttled/failed-adapter). */
  polled: integer("polled").notNull().default(0),
  /** Orders whose status actually advanced. */
  updated: integer("updated").notNull().default(0),
  /** Polled, no status change (same rank or non-status transit events). */
  unchanged: integer("unchanged").notNull().default(0),
  /** Orders whose newest carrier status had no mapping. */
  unmapped: integer("unmapped").notNull().default(0),
  /** Orders whose carrier call threw. */
  errors: integer("errors").notNull().default(0),
  /** JSON array of distinct raw carrier strings with no mapping. */
  unmappedStatuses: text("unmapped_statuses"),
  /** Run-level failure (adapter construction, DB) — the run aborted. */
  errorMessage: text("error_message"),
}, (t) => ({
  companyStartedIdx: index("idx_carrier_sync_runs_company").on(t.companyId, t.startedAt),
}));

// ─── Offers ───────────────────────────────────────────────────────────────────

/**
 * Buy X Get Y promotional offers.
 * Automatically applied server-side on storefront order creation.
 * No coupon code required — Algerian COD market.
 *
 * Trigger: customer orders >= triggerQuantity of triggerProduct
 *          (optionally restricted to a specific triggerVariant; null = any variant)
 *
 * Reward:  server auto-adds rewardQuantity of rewardProduct at pricePerUnit = 0
 *          (optionally a specific rewardVariant; null behaviour depends on whether
 *           rewardProduct === triggerProduct — see store/queries.ts for resolution logic)
 *
 * Scheduling: null startsAt = active immediately; null endsAt = never expires.
 * Multiple active offers on same product: the one with the HIGHEST satisfied
 * triggerQuantity wins (store.ts selectApplicableOffer orders by triggerQuantity DESC).
 * createdAt ASC ordering applies only to the storefront display list.
 */
export const offers = sqliteTable("offers", {
  id: text("id").primaryKey(),

  /** Human-readable name shown in dashboard, e.g. "اشترِ 2 واحصل على 1 مجاناً" */
  name: text("name").notNull(),

  // ── Trigger ──────────────────────────────────────────────────────────────────
  /** Product the customer must buy to trigger this offer. */
  triggerProductId: text("trigger_product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  /**
   * Optional: restrict trigger to a specific variant.
   * null = any variant (or simple product) of triggerProduct triggers the offer.
   */
  triggerVariantId: text("trigger_variant_id")
    .references(() => productVariants.id, { onDelete: "set null" }),
  /** Minimum quantity the customer must order to trigger the offer. */
  triggerQuantity: integer("trigger_quantity").notNull().default(2),

  // ── Reward ───────────────────────────────────────────────────────────────────
  /**
   * Product given as reward.
   * NULL when discountType = 'free_shipping' (no product reward — shipping is free instead).
   */
  rewardProductId: text("reward_product_id")
    .references(() => products.id, { onDelete: "cascade" }),
  /**
   * Optional: specific variant to give as reward.
   * null + rewardProductId === triggerProductId → same variantId the customer ordered.
   * null + rewardProductId !== triggerProductId → default/first active variant.
   * Set explicitly when rewardProduct has variants and differs from triggerProduct.
   */
  rewardVariantId: text("reward_variant_id")
    .references(() => productVariants.id, { onDelete: "set null" }),
  /** Quantity of reward items to add for free. 0 when discountType = 'free_shipping'. */
  rewardQuantity: integer("reward_quantity").notNull().default(1),

  // ── Discount ─────────────────────────────────────────────────────────────────
  /**
   * "free"          = reward items at pricePerUnit = 0 (Buy X Get Y free product).
   * "free_shipping" = delivery fee overridden to 0 (no reward product inserted).
   */
  discountType: text("discount_type", { enum: ["free", "free_shipping"] }).notNull().default("free"),

  // ── Schedule ─────────────────────────────────────────────────────────────────
  /** ISO 8601 datetime. null = active immediately. */
  startsAt: text("starts_at"),
  /** ISO 8601 datetime. null = never expires. */
  endsAt: text("ends_at"),

  status: text("status", { enum: ["active", "inactive"] })
    .notNull()
    .default("active"),

  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ─── Landing Pages ────────────────────────────────────────────────────────────

/**
 * A one-product marketing page: an ordered image stack with the COD order
 * form at the bottom. Merchants create several per product, run ads to each,
 * and compare which one converts. All marketing copy lives inside the images;
 * the engine charges the catalog price (no price override — see PR #90).
 */
export const landingPages = sqliteTable("landing_pages", {
  id: text("id").primaryKey(),
  /** Public URL identifier: [a-z0-9-]{3,60}. Auto-generated `lp-<8char>` default. */
  slug: text("slug").notNull().unique(),
  /** Internal label, e.g. "Zinc v3 — carousel ad". Never rendered publicly. */
  name: text("name").notNull(),
  /** The single product this page sells. */
  productId: text("product_id")
    .notNull()
    .references(() => products.id),
  status: text("status", { enum: ["draft", "published", "archived"] })
    .notNull()
    .default("draft"),

  // ── Spacing settings (the entire Studio right sidebar) ────────────────────
  /** Pixels between stacked images. 0 = flush stack. */
  imageGap: integer("image_gap").notNull().default(0),
  /** Pixels of page side padding. 0 = full-bleed. */
  sidePadding: integer("side_padding").notNull().default(0),
  /** Max content width in pixels. 0 = full width (mobile-first default). */
  contentMaxWidth: integer("content_max_width").notNull().default(0),

  // ── Visibility and presentation controls ─────────────────────────────────
  showImages: integer("show_images", { mode: "boolean" }).notNull().default(true),
  showOrderForm: integer("show_order_form", { mode: "boolean" }).notNull().default(true),
  showStickyCta: integer("show_sticky_cta", { mode: "boolean" }).notNull().default(true),
  backgroundColor: text("background_color").notNull().default("#ffffff"),
  buttonColor: text("button_color").notNull().default("#7c3aed"),
  buttonTextColor: text("button_text_color").notNull().default("#ffffff"),
  buttonRadius: integer("button_radius").notNull().default(12),

  // ── SEO ───────────────────────────────────────────────────────────────────
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),

  /** Render count of the published page (non-unique in v1). */
  views: integer("views").notNull().default(0),
  publishedAt: text("published_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One row of the landing page image stack. Mirrors product_images:
 * R2 object + alt text + position. `source` anticipates the AI-generation
 * future phase (upload | ai) without carrying any v1 behavior.
 * `width`/`height` (px, captured client-side at upload) let the storefront
 * reserve layout space before the bytes arrive — no form-jumping CLS.
 * Nullable: legacy rows and failed client measurements render without dims.
 */
export const landingPageImages = sqliteTable("landing_page_images", {
  id: text("id").primaryKey(),
  landingPageId: text("landing_page_id")
    .notNull()
    .references(() => landingPages.id, { onDelete: "cascade" }),
  r2Key: text("r2_key").notNull(),
  src: text("src").notNull(),
  altText: text("alt_text"),
  source: text("source", { enum: ["upload", "ai"] }).notNull().default("upload"),
  position: integer("position").notNull().default(1),
  width: integer("width"),
  height: integer("height"),
  createdAt: text("created_at").notNull(),
});

// ─── Dashboard branding ───────────────────────────────────────────────────────

/**
 * Single-row table (id = 'default') — written by the partner via push-brand,
 * read by the dashboard at request time through its D1 binding.
 */
export const dashboardBrand = sqliteTable("dashboard_brand", {
  id:           text("id").primaryKey().default("default"),
  brandName:    text("brand_name").notNull().default("Dashboard"),
  logoUrl:      text("logo_url"),
  primaryColor: text("primary_color").notNull().default("#7c3aed"),
  metaTitle:    text("meta_title"),
  faviconUrl:   text("favicon_url"),
  updatedAt:    text("updated_at").notNull(),
});

// ─── Meta Pixel / CAPI ───────────────────────────────────────────────────────

/**
 * Per-store Meta Pixel + Conversions API configuration.
 * One row per store. No row = tracking disabled (safe default).
 * Kept separate from `stores` — analytics config is a distinct concern.
 */
export const storePixelConfig = sqliteTable("store_pixel_config", {
  id: text("id").primaryKey(),
  storeId: text("store_id")
    .notNull()
    .unique()
    .references(() => stores.id, { onDelete: "cascade" }),
  pixelId: text("pixel_id").notNull(),
  /** Merchant's label for the Meta ad account this pixel belongs to — reference only, never sent to Meta. */
  adAccountName: text("ad_account_name"),
  accessToken: text("access_token").notNull(),
  /** Meta test event code — used during integration testing only. Set to null in production. */
  testEventCode: text("test_event_code"),
  /** Which CAPI event the merchant optimizes for — chosen explicitly in the dashboard, never defaulted by the UI. */
  conversionEvent: text("conversion_event", { enum: ["Lead", "Purchase", "Purchase_Confirmed", "Purchase_Delivered"] }).notNull().default("Purchase"),
  /** When true, CAPI events carry test_event_code to Meta's test stream instead of production measurement. */
  testMode: integer("test_mode", { mode: "boolean" }).notNull().default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Per-store WhatsApp OTP verification configuration (dzverify provider).
 * One row per store. No row = verification disabled (safe default).
 * Kept separate from `stores` — checkout verification is a distinct concern,
 * and the API key is merchant integration config (like carrier tokens), never
 * a worker secret.
 */
export const storeOtpConfig = sqliteTable("store_otp_config", {
  id: text("id").primaryKey(),
  storeId: text("store_id")
    .notNull()
    .unique()
    .references(() => stores.id, { onDelete: "cascade" }),
  apiKey: text("api_key").notNull(),
  /** WhatsApp message language for OTP sends: en | fr | ar. */
  language: text("language", { enum: ["en", "fr", "ar"] }).notNull().default("ar"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Per-store Sendili transactional email configuration.
 * One row per store. No row = email sending disabled (safe default).
 * Kept separate from `stores` — outbound email is a distinct concern, and
 * the API key is merchant integration config (like carrier tokens and the
 * dzverify key), never a worker secret.
 */
export const storeEmailConfig = sqliteTable("store_email_config", {
  id: text("id").primaryKey(),
  storeId: text("store_id")
    .notNull()
    .unique()
    .references(() => stores.id, { onDelete: "cascade" }),
  apiKey: text("api_key").notNull(),
  /** Verified sender address — its domain must be verified in the Sendili workspace. */
  fromEmail: text("from_email").notNull(),
  /** Optional sender display name (e.g. the store name). */
  fromName: text("from_name"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Per-store Cloudflare Turnstile configuration (checkout bot protection).
 * One row per store. No row = Turnstile disabled (safe default).
 * Kept separate from `stores` — checkout bot protection is a distinct concern,
 * and the secret key is merchant integration config (like the dzverify/Sendili
 * keys), never a worker secret. The site key is public by design (it is
 * rendered into storefront HTML); the secret key never leaves the server.
 */
export const storeTurnstileConfig = sqliteTable("store_turnstile_config", {
  id: text("id").primaryKey(),
  storeId: text("store_id")
    .notNull()
    .unique()
    .references(() => stores.id, { onDelete: "cascade" }),
  /** Public widget site key — safe to expose to the storefront. */
  siteKey: text("site_key").notNull(),
  /** Server-side siteverify secret — never returned to any client. */
  secretKey: text("secret_key").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Audit log for every CAPI event attempt sent by CodCapiWorkflow.
 * status: 'sent' | 'failed' | 'skipped'
 * metaEventId: fbtrace_id from Meta response (present on success only).
 */
export const capiEventLog = sqliteTable(
  "capi_event_log",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    eventName: text("event_name").notNull(),
    stage: text("stage").notNull().default("delivered"),
    status: text("status").notNull(),
    metaEventId: text("meta_event_id"),
    error: text("error"),
    sentAt: text("sent_at").notNull(),
  },
  (t) => ({
    orderIdx: index("idx_capi_event_log_order").on(t.orderId),
    claimUnique: uniqueIndex("idx_capi_event_log_claim").on(t.orderId, t.stage, t.eventName),
  })
);

// ─── better-auth tables ──────────────────────────────────────────────────────
// Declared so the dashboard's auth code can reference them via Drizzle. The D1
// schema itself is created by cod-server migrations (0000_complete.sql).

export const sessions = sqliteTable("sessions", {
  id:        text("id").primaryKey(),
  userId:    text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token:     text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
}, (t) => ({
  userIdIdx: index("sessions_user_id_idx").on(t.userId),
}));

export const accounts = sqliteTable("accounts", {
  id:                    text("id").primaryKey(),
  userId:                text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId:             text("account_id").notNull(),
  providerId:            text("provider_id").notNull(),
  issuer:                text("issuer"),
  accessToken:           text("access_token"),
  refreshToken:          text("refresh_token"),
  idToken:               text("id_token"),
  accessTokenExpiresAt:  integer("access_token_expires_at",  { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope:                 text("scope"),
  password:              text("password"),
  createdAt:             integer("created_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
  updatedAt:             integer("updated_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
}, (t) => ({
  userIdIdx: index("accounts_user_id_idx").on(t.userId),
}));

export const verifications = sqliteTable("verifications", {
  id:         text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value:      text("value").notNull(),
  expiresAt:  integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt:  integer("created_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
  updatedAt:  integer("updated_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
}, (t) => ({
  identifierIdx: index("verifications_identifier_idx").on(t.identifier),
}));

// ─── better-auth jwt() plugin ─────────────────────────────────────────────────
// RSA keypair storage for signing OAuth access tokens. The public half is
// exposed via /api/auth/jwks so cod-server can verify tokens offline.
// Added by the MCP rollout (MCP-5).
export const jwkss = sqliteTable("jwkss", {
  id:         text("id").primaryKey(),
  publicKey:  text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt:  integer("created_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
  expiresAt:  integer("expires_at", { mode: "timestamp_ms" }),
  alg:        text("alg"),
  crv:        text("crv"),
});

// ─── @better-auth/oauth-provider (LEGACY — no longer written) ────────────────
// These tables backed the decommissioned Better Auth OAuth 2.1 Authorization
// Server plugin that used to issue MCP tokens from the dashboards. MCP OAuth
// moved to `@cloudflare/workers-oauth-provider` on cod-server (clients, grants,
// tokens, and props now live in the OAUTH_KV namespace, not D1). The tables are
// kept for historical data; nothing writes to them anymore. Do not drop without
// confirming no deployment still references them.
//
// Array columns (`string[]` in Better Auth's model) are stored as JSON text.
// Better Auth's Drizzle adapter serialises/deserialises automatically.
//
// `plural` mode is ON globally so Better Auth maps `oauthClient` → `oauthClients`
// in queries — table names below must match.

export const oauthClients = sqliteTable("oauthClients", {
  id:                      text("id").primaryKey(),
  clientId:                text("client_id").notNull().unique(),
  clientSecret:            text("client_secret"),
  disabled:                integer("disabled", { mode: "boolean" }).default(false),
  skipConsent:             integer("skip_consent", { mode: "boolean" }),
  enableEndSession:        integer("enable_end_session", { mode: "boolean" }),
  subjectType:             text("subject_type"),
  scopes:                  text("scopes"),                   // JSON string[]
  userId:                  text("user_id").references(() => users.id, { onDelete: "cascade" }),
  name:                    text("name"),
  uri:                     text("uri"),
  icon:                    text("icon"),
  contacts:                text("contacts"),                 // JSON string[]
  tos:                     text("tos"),
  policy:                  text("policy"),
  softwareId:              text("software_id"),
  softwareVersion:         text("software_version"),
  softwareStatement:       text("software_statement"),
  redirectUris:            text("redirect_uris").notNull(),  // JSON string[]
  postLogoutRedirectUris:  text("post_logout_redirect_uris"),// JSON string[]
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  grantTypes:              text("grant_types"),              // JSON string[]
  responseTypes:           text("response_types"),           // JSON string[]
  type:                    text("type"),
  public:                  integer("public", { mode: "boolean" }),
  clientIdIssuedAt:        integer("client_id_issued_at",     { mode: "timestamp_ms" }),
  clientSecretExpiresAt:   integer("client_secret_expires_at",{ mode: "timestamp_ms" }),
  requirePkce:             integer("require_pkce", { mode: "boolean" }),
  referenceId:             text("reference_id"),
  metadata:                text("metadata"),                 // JSON
  createdAt:               integer("created_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
  updatedAt:               integer("updated_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
}, (t) => ({
  userIdIdx: index("oauthClients_user_id_idx").on(t.userId),
}));

export const oauthRefreshTokens = sqliteTable("oauthRefreshTokens", {
  id:          text("id").primaryKey(),
  token:       text("token").notNull(),
  clientId:    text("client_id").notNull().references(() => oauthClients.clientId),
  sessionId:   text("session_id").references(() => sessions.id, { onDelete: "set null" }),
  userId:      text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  expiresAt:   integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt:   integer("created_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
  revoked:     integer("revoked",    { mode: "timestamp_ms" }),
  authTime:    integer("auth_time",  { mode: "timestamp_ms" }),
  scopes:      text("scopes").notNull(),                     // JSON string[]
}, (t) => ({
  tokenIdx:    index("oauthRefreshTokens_token_idx").on(t.token),
  userIdIdx:   index("oauthRefreshTokens_user_id_idx").on(t.userId),
  clientIdIdx: index("oauthRefreshTokens_client_id_idx").on(t.clientId),
}));

export const oauthAccessTokens = sqliteTable("oauthAccessTokens", {
  id:          text("id").primaryKey(),
  token:       text("token").unique(),
  clientId:    text("client_id").notNull().references(() => oauthClients.clientId),
  sessionId:   text("session_id").references(() => sessions.id, { onDelete: "set null" }),
  userId:      text("user_id").references(() => users.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  refreshId:   text("refresh_id").references(() => oauthRefreshTokens.id, { onDelete: "set null" }),
  expiresAt:   integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt:   integer("created_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
  scopes:      text("scopes").notNull(),                     // JSON string[]
}, (t) => ({
  userIdIdx:   index("oauthAccessTokens_user_id_idx").on(t.userId),
  clientIdIdx: index("oauthAccessTokens_client_id_idx").on(t.clientId),
}));

export const oauthConsents = sqliteTable("oauthConsents", {
  id:          text("id").primaryKey(),
  clientId:    text("client_id").notNull().references(() => oauthClients.clientId),
  userId:      text("user_id").references(() => users.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  scopes:      text("scopes").notNull(),                     // JSON string[]
  createdAt:   integer("created_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
  updatedAt:   integer("updated_at", { mode: "timestamp_ms" }).default(authNow).notNull(),
}, (t) => ({
  userClientIdx: index("oauthConsents_user_client_idx").on(t.userId, t.clientId),
}));

// ─── Abandoned Orders ────────────────────────────────────────────────────────
// Recorded when a visitor fills name + phone in the storefront but never places an order.
// One record per browser session (sessionId UNIQUE). Status lifecycle:
//   pending  → created, < 30 min old (may still convert)
//   abandoned → 30+ min old with no order (Cron Trigger flips this)
//   converted → visitor placed an order (markConverted called synchronously)
//   contacted → merchant manually marked outreach done
export const abandonedOrders = sqliteTable("abandoned_orders", {
  id:                    text("id").primaryKey(),
  sessionId:             text("session_id").notNull().unique(),

  customerName:          text("customer_name").notNull(),
  phone:                 text("phone").notNull(),

  wilayaId:              integer("wilaya_id").references(() => wilayas.id),
  communeId:             text("commune_id").references(() => communes.id),
  wilayaName:            text("wilaya_name"),
  communeName:           text("commune_name"),

  productId:             text("product_id"),
  productName:           text("product_name"),
  variantId:             text("variant_id"),
  variantLabel:          text("variant_label"),
  price:                 real("price"),

  deliveryType: text("delivery_type", { enum: ["home", "stop_desk"] }),

  fbc:                   text("fbc"),
  fbp:                   text("fbp"),
  ipAddress:             text("ip_address"),
  userAgent:             text("user_agent"),

  status: text("status", {
    enum: ["pending", "abandoned", "contacted", "converted"],
  }).notNull().default("pending"),

  convertedOrderId:      text("converted_order_id"),
  convertedOrderNumber:  text("converted_order_number"),

  recoveryAttempts:      integer("recovery_attempts").notNull().default(0),
  lastRecoveryAt:        text("last_recovery_at"),

  createdAt:             text("created_at").notNull(),
  updatedAt:             text("updated_at").notNull(),
}, (t) => ({
  statusIdx:    index("abandoned_orders_status_idx").on(t.status),
  phoneIdx:     index("abandoned_orders_phone_idx").on(t.phone),
  createdAtIdx: index("abandoned_orders_created_at_idx").on(t.createdAt),
}));

// ─── Dashboard Analytics ─────────────────────────────────────────────────────

export const EXPENSE_CATEGORIES = ["ads", "carrier", "packaging", "salaries", "rent", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const AD_PLATFORMS = ["meta", "tiktok", "google", "snapchat", "other"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

/**
 * Money the business spends that the order tables cannot derive on their own:
 * ad budgets (ROAS), carrier invoices, packaging, salaries, rent. Feeds the
 * dashboard P&L and the ROAS widget. `date` is the store-local calendar day.
 */
export const businessExpenses = sqliteTable("business_expenses", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  category: text("category", { enum: EXPENSE_CATEGORIES }).notNull(),
  platform: text("platform"),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("DZD"),
  landingPageId: text("landing_page_id").references(() => landingPages.id, { onDelete: "set null" }),
  note: text("note"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => ({
  dateIdx: index("business_expenses_date_idx").on(t.date, t.category),
  landingPageIdx: index("business_expenses_landing_page_idx").on(t.landingPageId),
}));

/** Per-user dashboard widget order/visibility (JSON blob, versioned). */
export const dashboardLayouts = sqliteTable("dashboard_layouts", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  layout: text("layout").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Automated daily KPI report (Telegram / email) — single row, id = "default". */
export const dashboardReportConfig = sqliteTable("dashboard_report_config", {
  id: text("id").primaryKey().default("default"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  sendHour: integer("send_hour").notNull().default(20),
  timezone: text("timezone").notNull().default("Africa/Algiers"),
  telegramEnabled: integer("telegram_enabled", { mode: "boolean" }).notNull().default(true),
  emailEnabled: integer("email_enabled", { mode: "boolean" }).notNull().default(false),
  emailRecipients: text("email_recipients").notNull().default("[]"),
  lastSentOn: text("last_sent_on"),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ─── Risk control & saved views (migration 0036) ──────────────────────────────

/**
 * Banned customers: phones and IPs that must never enter the confirmation
 * queue again (serial returners, fraudulent COD, abusive callers).
 *
 * Membership is DERIVED, not copied: an order is "blacklisted" when its phone
 * (or the shopper's IP) matches an `active` row here. Lifting a ban therefore
 * stops flagging that customer's whole history at once, and no column has to
 * be added to `orders`.
 *
 * `value` is the canonical match key — the local Algerian mobile form
 * ("0551234567", the same shape orders.phone is validated into) for phones,
 * the trimmed literal for IPs. `rawValue` keeps what the operator typed.
 */
export const customerBlacklist = sqliteTable("customer_blacklist", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["phone", "ip"] }).notNull(),
  value: text("value").notNull(),
  rawValue: text("raw_value").notNull(),
  reason: text("reason"),
  status: text("status", { enum: ["active", "lifted"] }).notNull().default("active"),
  /** Orders created while the entry was active — what the ban actually saved. */
  hitCount: integer("hit_count").notNull().default(0),
  lastHitAt: text("last_hit_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  liftedAt: text("lifted_at"),
  liftedBy: text("lifted_by").references(() => users.id, { onDelete: "set null" }),
  liftedReason: text("lifted_reason"),
}, (t) => ({
  statusCreatedIdx: index("customer_blacklist_status_created_idx").on(t.status, t.createdAt),
}));

/**
 * Named, shareable list state. Two shapes share one table because they are
 * the same idea — "a saved answer to a question the merchant keeps asking":
 *
 *   kind = "orders-filter"   → filters + sortKey/sortDirection
 *   kind = "export-template" → columns + headers (+ optional carrierId)
 *
 * Stored server-side rather than in localStorage so a view can be shared with
 * the team (`shared = 1`) and survives a device or browser change.
 */
export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["orders-filter", "export-template"] })
    .notNull()
    .default("orders-filter"),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** 0 = private to the owner, 1 = visible to everyone who can read orders. */
  shared: integer("shared", { mode: "boolean" }).notNull().default(false),
  /** JSON — the orders-list filter state. */
  filters: text("filters").notNull().default("{}"),
  sortKey: text("sort_key"),
  sortDirection: text("sort_direction", { enum: ["asc", "desc"] }),
  /** JSON array of export column keys, in carrier-file order. */
  columns: text("columns"),
  /** JSON map: column key → header text override. */
  headers: text("headers"),
  carrierId: text("carrier_id").references(() => deliveryCompanies.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => ({
  ownerIdx: index("saved_views_owner_idx").on(t.kind, t.ownerId, t.updatedAt),
  sharedIdx: index("saved_views_shared_idx").on(t.kind, t.shared, t.updatedAt),
}));
