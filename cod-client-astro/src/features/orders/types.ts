import type {
  ContactChannel,
  ContactOutcome,
  ContactSummary,
} from "../../../../cod-shared/lib/order-contact";

export const ORDER_STATUSES = [
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
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type DeliveryMethod = "unassigned" | "driver" | "company";
export type DeliveryType = "home" | "stop_desk";
export type OrderType = "online" | "offline";

export interface StatusHistoryItem {
  id: string;
  orderId?: string;
  status: OrderStatus;
  timestamp: string;
  by: string | null;
  byName: string | null;
}

export interface OrderProduct {
  id: string;
  orderId: string;
  productId: string;
  productName: string;
  variantId: string | null;
  variantLabel: string | null;
  sku?: string | null;
  quantity: number;
  pricePerUnit: number;
  lineTotal: number;
  status: "fulfilled" | "partially_returned" | "returned";
  returnedQuantity: number;
  createdAt: string;
}

export interface OrderBase {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  phone: string;
  wilayaId: number | null;
  wilaya: string | null;
  communeId: string | null;
  commune: string | null;
  city: string | null;
  address: string | null;
  price: number;
  deliveryFee: number;
  driverFee: number;
  codAmount: number | null;
  status: OrderStatus;
  orderType: OrderType;
  deliveryMethod: DeliveryMethod;
  deliveryType: DeliveryType;
  driverId: string | null;
  driverName: string | null;
  companyId: string | null;
  assignedAt: string | null;
  assignedBy: string | null;
  assignmentNotes: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  externalOrderId: string | null;
  stationCode: string | null;
  pickupTime: string | null;
  deliveryTime: string | null;
  deliveryAttempts: number | null;
  notes: string | null;
  photos: string | null;
  weight: number | null;
  isFragile: boolean | null;
  codPaymentId?: string | null;
  feePaymentId?: string | null;
  /** Carrier auto-sync bookkeeping (migration 0035). */
  lastTrackingSyncAt?: string | null;
  lastCarrierStatus?: string | null;
  trackingSyncFails?: number | null;
  createdAt: string;
  updatedAt: string;
  confirmationAssigneeId?: string | null;
  confirmationAssigneeName?: string | null;
}

export interface OrderListItem extends OrderBase {
  hasReview?: number;
  lastUpdatedBy?: string | null;
  unansweredCallsToday?: number;
  lastContactAt?: string | null;
}

export interface OrderDetail extends OrderBase {
  products: OrderProduct[];
  statusHistory: StatusHistoryItem[];
  labelUrl?: string | null;
}

export interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  phone2: string | null;
  vehicleType: "motorcycle" | "car" | "van" | null;
  status: "available" | "busy" | "inactive";
}

export interface DeliveryCompany {
  id: string;
  name: string;
  nameAr: string;
  code: string;
  active: boolean;
  isConnected: boolean;
  supportsHomeDelivery: boolean;
  supportsStopDesk: boolean;
  supportsTracking: boolean;
  autoValidate: boolean | null;
  /** Poll the carrier tracking API on the cron tick (migration 0035). */
  autoSyncEnabled?: boolean | null;
  autoSyncIntervalMin?: number | null;
}

export interface CarrierSyncCounters {
  scanned: number;
  polled: number;
  updated: number;
  unchanged: number;
  unmapped: number;
  errors: number;
}

export interface CarrierSyncDetail {
  orderId: string;
  orderNumber: string;
  trackingNumber: string;
  outcome: "updated" | "unchanged" | "unmapped" | "error";
  from: string;
  to?: string;
  carrierStatus?: string | null;
  error?: string;
}

export interface CarrierSyncCompanyResult extends CarrierSyncCounters {
  companyId: string;
  companyCode: string;
  companyName: string;
  runId: string;
  unmappedStatuses: string[];
  error: string | null;
}

export interface BulkCarrierSyncResult {
  companies: CarrierSyncCompanyResult[];
  totals: CarrierSyncCounters;
  details: CarrierSyncDetail[];
}

export interface OrderCarrierSyncResult {
  orderId: string;
  outcome: "updated" | "unchanged" | "unmapped" | "error";
  from: string;
  to: string;
  carrierStatus: string | null;
  companyId: string;
  companyCode: string;
  runId: string;
}

/** Result of POST /delivery-companies/:id/sync-statuses. */
export interface CompanySyncResult extends CarrierSyncCounters {
  runId: string;
  companyCode: string;
  unmappedStatuses: string[];
  details: CarrierSyncDetail[];
}

export interface CarrierSyncRun {
  id: string;
  trigger: "cron" | "manual" | "company";
  mode: "poll" | "reconcile";
  startedAt: string;
  finishedAt: string | null;
  scanned: number;
  polled: number;
  updated: number;
  unchanged: number;
  unmapped: number;
  errors: number;
  unmappedStatuses: string[];
  error: string | null;
}

export interface CarrierAutoSyncStatus {
  companyId: string;
  companyCode: string;
  companyName: string;
  autoSyncEnabled: boolean;
  autoSyncIntervalMin: number;
  hasCredentials: boolean;
  hasWebhookSecret: boolean;
  shippedOrders: number;
  failingOrders: number;
  lastRun: (CarrierSyncRun & { id: string }) | null;
}

export interface StopDesk {
  id: string;
  companyId: string;
  code: string;
  name: string;
  commune: string | null;
  wilayaId: number | null;
  address: string | null;
  active: boolean;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  phone2: string | null;
  wilayaId: number | null;
  communeId: string | null;
  wilaya: string;
  commune: string | null;
  address: string | null;
}

export interface ProductVariant {
  id: string;
  productId: string;
  variations: Record<string, string>;
  price: number;
  sku: string;
  inventory: number;
  active: boolean;
}

export interface Product {
  id: string;
  name: string;
  price: number;
  hasVariants: boolean;
  variants: ProductVariant[];
  inventory: number;
  totalInventory: number;
  trackInventory: boolean;
  shippingProfileId: string | null;
}

export interface ShippingRule {
  id: string;
  profileId: string;
  wilayaId: number;
  wilayaName: string;
  wilayaNameAr: string;
  homePrice: number;
  stopDeskPrice: number;
  homeEnabled: boolean;
  stopDeskEnabled: boolean;
}

export interface Wilaya {
  id: number;
  name: string;
  nameAr: string;
}

export interface Commune {
  id: string;
  wilayaId: number;
  name: string;
  nameAr: string;
  postalCode: string | null;
}

export const ABANDONED_STATUSES = [
  "pending",
  "abandoned",
  "contacted",
  "converted",
] as const;

export type AbandonedOrderStatus = (typeof ABANDONED_STATUSES)[number];

export interface AbandonedOrder {
  id: string;
  sessionId: string;
  customerName: string;
  phone: string;
  wilayaId: number | null;
  communeId: string | null;
  wilayaName: string | null;
  communeName: string | null;
  productId: string | null;
  productName: string | null;
  variantId: string | null;
  variantLabel: string | null;
  price: number | null;
  deliveryType: DeliveryType | null;
  status: AbandonedOrderStatus;
  convertedOrderId: string | null;
  convertedOrderNumber: string | null;
  recoveryAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface AbandonedStats {
  totalAbandoned: number;
  totalConverted: number;
  conversionRate: number;
  estimatedLostRevenue: number;
}

export type { ContactChannel, ContactOutcome, ContactSummary };

export interface ContactAttempt {
  id: string;
  orderId: string;
  channel: ContactChannel;
  outcome: ContactOutcome;
  note: string | null;
  callbackAt: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

export interface ContactAttemptsData {
  attempts: ContactAttempt[];
  summary: ContactSummary;
}

export interface ContactAttemptResult extends ContactAttemptsData {
  attempt: ContactAttempt;
  statusChanged: { from: OrderStatus; to: OrderStatus } | null;
  callbackTaskId: string | null;
}

export type OrderActivityKind = "created" | "status" | "contact" | "note" | "event";

export interface OrderActivityEntry {
  id: string;
  kind: OrderActivityKind;
  action: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  source: string | null;
  createdAt: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  channel: ContactChannel | null;
  outcome: ContactOutcome | null;
  note: string | null;
  callbackAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface OrderActivityData {
  order: {
    id: string;
    orderNumber: string;
    customerName: string;
    phone: string;
    status: OrderStatus;
    orderType: OrderType;
    createdAt: string;
    confirmationAssigneeName: string | null;
  };
  summary: ContactSummary;
  entries: OrderActivityEntry[];
}
