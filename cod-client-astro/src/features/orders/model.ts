import type { Locale } from "@/i18n/config";
import type {
  AbandonedOrder,
  AbandonedOrderStatus,
  OrderListItem,
  OrderStatus,
} from "./types";

export const FILTER_STATUSES: OrderStatus[] = [
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
];

export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ["confirmed", "unreachable", "cancelled"],
  confirmed: ["preparing", "unreachable", "cancelled"],
  unreachable: ["confirmed", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["out_for_delivery", "dispatched", "cancelled"],
  assigned: ["out_for_delivery", "dispatched", "cancelled"],
  dispatched: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "returned"],
  delivered: [],
  returned: [],
  cancelled: [],
};

export function orderStatusOptions(status: OrderStatus): OrderStatus[] {
  return [status, ...ALLOWED_TRANSITIONS[status]];
}

export interface OrderFilters {
  query: string;
  status: string;
  delivery: string;
  wilaya: string;
  type: string;
  confirmationAssignment?: string;
  confirmerId?: string;
}

export type DetailStatusAction = {
  status: OrderStatus;
  emphasis: "primary" | "secondary" | "danger";
};

export function detailStatusActions(
  status: OrderStatus,
  order?: Pick<OrderListItem, "deliveryMethod" | "trackingNumber">,
): DetailStatusAction[] {
  const actions: Partial<Record<OrderStatus, DetailStatusAction[]>> = {
    new: [
      { status: "confirmed", emphasis: "primary" },
      { status: "unreachable", emphasis: "secondary" },
    ],
    confirmed: [
      { status: "preparing", emphasis: "primary" },
      { status: "unreachable", emphasis: "secondary" },
    ],
    unreachable: [
      { status: "confirmed", emphasis: "primary" },
      { status: "cancelled", emphasis: "danger" },
    ],
    preparing: [{ status: "ready", emphasis: "primary" }],
    assigned: [{ status: "out_for_delivery", emphasis: "primary" }],
    dispatched: [{ status: "out_for_delivery", emphasis: "primary" }],
    out_for_delivery: [{ status: "delivered", emphasis: "primary" }],
  };
  if (status === "ready") {
    return order?.trackingNumber
      ? [{ status: "dispatched", emphasis: "primary" }]
      : [];
  }
  return actions[status] ?? [];
}

export function dispatchFieldSupport(companyCode: string): {
  remarks: boolean;
  weight: boolean;
  fragile: boolean;
} {
  const isEcotrack =
    companyCode === "ecotrack" || companyCode.endsWith("_ecotrack");
  if (isEcotrack) return { remarks: true, weight: true, fragile: true };
  if (companyCode === "noest")
    return { remarks: true, weight: true, fragile: false };
  // Yalidine takes a per-parcel weight (official create contract; the
  // adapter forwards it) — over 5kg billable weight an oversize fee applies,
  // so the merchant needs the input. No remarks endpoint, no fragile field.
  if (companyCode === "yalidine")
    return { remarks: false, weight: true, fragile: false };
  return { remarks: false, weight: false, fragile: false };
}

export function shipmentCapabilities(
  companyCode: string,
  status: OrderStatus,
  dispatched: boolean,
): {
  canValidate: boolean;
  canUpdate: boolean;
  canCancel: boolean;
  canRemark: boolean;
  canTrack: boolean;
} {
  const isEcotrack =
    companyCode === "ecotrack" || companyCode.endsWith("_ecotrack");
  const supportsUpdate =
    isEcotrack || ["noest", "yalidine", "zr_express"].includes(companyCode);
  // ZR Express deletion works via DELETE /parcels/bulk/by-tracking-number
  // (live-verified 2026-09-10; the earlier 405 came from a wrong POST).
  const supportsCancel =
    isEcotrack || ["noest", "yalidine", "zr_express"].includes(companyCode);
  const canUpdate =
    isEcotrack || companyCode === "zr_express"
      ? !isTerminalStatus(status)
      : companyCode === "yalidine"
        ? ["dispatched", "out_for_delivery"].includes(status)
        : companyCode === "noest"
          ? status === "dispatched"
          : false;
  const canCancel =
    supportsCancel &&
    (companyCode === "yalidine"
      ? ["dispatched", "out_for_delivery"].includes(status)
      : status === "dispatched");

  return {
    canValidate: dispatched && status === "dispatched",
    canUpdate: dispatched && supportsUpdate && canUpdate,
    canCancel: dispatched && canCancel,
    canRemark: dispatched && (isEcotrack || companyCode === "noest"),
    canTrack: dispatched && Boolean(companyCode),
  };
}

export function shipmentUpdateFieldSupport(companyCode: string): {
  name: boolean;
  phone: boolean;
  phone2: boolean;
  address: boolean;
  amount: boolean;
  weight: boolean;
  fragile: boolean;
  remarks: boolean;
} {
  const isEcotrack =
    companyCode === "ecotrack" || companyCode.endsWith("_ecotrack");
  if (isEcotrack || companyCode === "noest") {
    return {
      name: true,
      phone: true,
      phone2: true,
      address: true,
      amount: true,
      weight: true,
      fragile: true,
      remarks: true,
    };
  }
  if (companyCode === "yalidine") {
    return {
      name: true,
      phone: true,
      phone2: false,
      address: true,
      amount: true,
      weight: true,
      fragile: false,
      remarks: false,
    };
  }
  if (companyCode === "zr_express") {
    return {
      name: true,
      phone: true,
      phone2: false,
      address: true,
      amount: true,
      weight: false,
      fragile: false,
      remarks: false,
    };
  }
  return {
    name: false,
    phone: false,
    phone2: false,
    address: false,
    amount: false,
    weight: false,
    fragile: false,
    remarks: false,
  };
}

export function canAssignOrder(
  order: Pick<OrderListItem, "status" | "trackingNumber" | "deliveryMethod">,
): boolean {
  return (
    !order.trackingNumber &&
    order.deliveryMethod !== "company" &&
    ![
      "unreachable",
      "out_for_delivery",
      "delivered",
      "returned",
      "cancelled",
    ].includes(order.status)
  );
}

export function canDispatchOrder(
  order: Pick<
    OrderListItem,
    "status" | "trackingNumber" | "driverId" | "deliveryMethod"
  >,
): boolean {
  const driverCommitted =
    order.deliveryMethod === "driver" && Boolean(order.driverId);
  return (
    !order.trackingNumber &&
    !driverCommitted &&
    ![
      "unreachable",
      "out_for_delivery",
      "delivered",
      "returned",
      "cancelled",
    ].includes(order.status)
  );
}

export function canDeleteOrderFromDetail(status: OrderStatus): boolean {
  return status === "new" || status === "preparing";
}

export function orderStatusFlow(
  order: Pick<OrderListItem, "deliveryMethod" | "driverId" | "trackingNumber">,
): OrderStatus[] {
  const companyDelivery =
    Boolean(order.trackingNumber) || order.deliveryMethod === "company";
  return companyDelivery
    ? [
        "new",
        "confirmed",
        "preparing",
        "ready",
        "dispatched",
        "out_for_delivery",
        "delivered",
      ]
    : [
        "new",
        "confirmed",
        "preparing",
        "ready",
        "assigned",
        "out_for_delivery",
        "delivered",
      ];
}

export function filterOrders(
  orders: OrderListItem[],
  filters: OrderFilters,
): OrderListItem[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return orders.filter((order) => {
    if (
      query &&
      !`${order.orderNumber} ${order.customerName} ${order.phone}`
        .toLocaleLowerCase()
        .includes(query)
    ) {
      return false;
    }
    if (filters.status !== "all" && order.status !== filters.status)
      return false;
    if (filters.type !== "all" && order.orderType !== filters.type)
      return false;
    if (
      filters.confirmationAssignment === "assigned" &&
      !order.confirmationAssigneeId
    )
      return false;
    if (
      filters.confirmationAssignment === "unassigned" &&
      order.confirmationAssigneeId
    )
      return false;
    if (
      filters.confirmerId !== "all" &&
      order.confirmationAssigneeId !== filters.confirmerId
    )
      return false;
    if (filters.wilaya !== "all" && order.wilaya !== filters.wilaya)
      return false;
    if (
      filters.delivery === "driver" &&
      (!order.driverId || order.trackingNumber)
    )
      return false;
    if (filters.delivery === "company" && !order.trackingNumber) return false;
    if (
      filters.delivery === "unassigned" &&
      (order.driverId || order.trackingNumber)
    )
      return false;
    return true;
  });
}

export function formatMoney(
  amount: number | null | undefined,
  locale: Locale,
  currency = "DA",
): string {
  if (amount == null) return "-";
  return `${new Intl.NumberFormat(locale === "ar" ? "ar-DZ" : `${locale}-DZ`).format(amount)} ${currency}`;
}

export function orderTotal(
  order: Pick<OrderListItem, "price" | "deliveryFee">,
): number {
  return order.price + order.deliveryFee;
}

export type OrderSortKey =
  "createdAt" | "orderNumber" | "customerName" | "status" | "wilaya" | "total";

export function sortOrders(
  orders: OrderListItem[],
  key: OrderSortKey,
  direction: "asc" | "desc",
): OrderListItem[] {
  return [...orders].sort((left, right) => {
    const leftValue = key === "total" ? orderTotal(left) : left[key];
    const rightValue = key === "total" ? orderTotal(right) : right[key];
    const comparison = String(leftValue ?? "").localeCompare(
      String(rightValue ?? ""),
      undefined,
      {
        numeric: true,
        sensitivity: "base",
      },
    );
    return direction === "asc" ? comparison : -comparison;
  });
}

export function paginateOrders(
  orders: OrderListItem[],
  page: number,
  pageSize: number,
): OrderListItem[] {
  const safePage = Math.max(1, page);
  const safePageSize = Math.max(1, pageSize);
  const start = (safePage - 1) * safePageSize;
  return orders.slice(start, start + safePageSize);
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return (
    status === "delivered" || status === "returned" || status === "cancelled"
  );
}

const ABANDONED_TRANSITIONS: Record<
  AbandonedOrderStatus,
  AbandonedOrderStatus[]
> = {
  pending: ["contacted", "abandoned"],
  abandoned: ["contacted", "converted"],
  contacted: ["converted", "abandoned"],
  converted: [],
};

export function abandonedStatusOptions(
  status: AbandonedOrderStatus,
): AbandonedOrderStatus[] {
  return [status, ...ABANDONED_TRANSITIONS[status]];
}

export interface AbandonedFilters {
  query: string;
  status: string;
}

export function filterAbandonedOrders(
  rows: AbandonedOrder[],
  filters: AbandonedFilters,
): AbandonedOrder[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (
      query &&
      !`${row.customerName} ${row.phone} ${row.productName ?? ""}`
        .toLocaleLowerCase()
        .includes(query)
    ) {
      return false;
    }
    if (filters.status !== "all" && row.status !== filters.status) return false;
    return true;
  });
}

// ─── SLA indicator ───────────────────────────────────────────────────────────

/**
 * How long an order may sit in a state before the row turns red.
 * Hours for the confirmation stage (the merchant's own clock), days for the
 * carrier stage (once it is out for delivery the clock is the courier's).
 */
export const SLA_THRESHOLDS = {
  newHours: 12,
  outForDeliveryDays: 3,
} as const;

export type SlaLevel = "ok" | "warn" | "breach";

export interface OrderSla {
  level: SlaLevel;
  /** "new" | "out_for_delivery" | null — which clock is running. */
  stage: "new" | "out_for_delivery" | null;
  hours: number;
  days: number;
}

const DAY_MS = 86_400_000;

/**
 * SLA state for an orders-list row. Only the two states the merchant can act
 * on are timed: an unconfirmed "new" order and a parcel stuck out for
 * delivery. Everything else is "ok" — a warning on a state nobody owns is
 * noise, not a signal.
 */
export function orderSla(
  order: Pick<OrderListItem, "status" | "createdAt">,
  now: number = Date.now(),
  thresholds: { newHours?: number; outForDeliveryDays?: number } = {},
): OrderSla {
  const newHours = thresholds.newHours ?? SLA_THRESHOLDS.newHours;
  const outForDeliveryDays =
    thresholds.outForDeliveryDays ?? SLA_THRESHOLDS.outForDeliveryDays;

  const created = Date.parse(order.createdAt);
  if (Number.isNaN(created)) {
    return { level: "ok", stage: null, hours: 0, days: 0 };
  }

  const elapsedMs = Math.max(0, now - created);
  const hours = Math.floor(elapsedMs / 3_600_000);
  const days = Math.floor(elapsedMs / DAY_MS);

  if (order.status === "new") {
    return {
      level: hours >= newHours ? "breach" : hours >= newHours / 2 ? "warn" : "ok",
      stage: "new",
      hours,
      days,
    };
  }

  if (order.status === "out_for_delivery") {
    return {
      level:
        days >= outForDeliveryDays
          ? "breach"
          : days >= Math.max(1, outForDeliveryDays - 1)
            ? "warn"
            : "ok",
      stage: "out_for_delivery",
      hours,
      days,
    };
  }

  return { level: "ok", stage: null, hours, days };
}

// ─── Quick contact ───────────────────────────────────────────────────────────

/**
 * Algerian numbers are stored locally ("0551234567"). wa.me and tel: both need
 * the international form, so the leading 0 becomes +213. Numbers already in
 * international form are passed through untouched.
 */
export function toInternationalPhone(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("0") && digits.length === 10) return `+213${digits.slice(1)}`;
  if (digits.startsWith("213")) return `+${digits}`;
  return null;
}

export function telLink(phone: string): string | null {
  const international = toInternationalPhone(phone);
  return international ? `tel:${international}` : null;
}

/** wa.me takes the number without "+" and the message URL-encoded. */
export function whatsappLink(phone: string, message?: string): string | null {
  const international = toInternationalPhone(phone);
  if (!international) return null;
  const number = international.replace("+", "");
  const query = message ? `?text=${encodeURIComponent(message)}` : "";
  return `https://wa.me/${number}${query}`;
}
