import { Clock, MapPin, MessageCircle, PackageOpen, Phone, Star } from "lucide-react";
import { useState } from "react";
import { useLocale, useT } from "@/i18n/react";
import { Select, TableCell, TableRow } from "@/components/ui";
import {
  formatMoney,
  orderSla,
  orderTotal,
  telLink,
  whatsappLink,
} from "@/features/orders/model";
import type {
  DeliveryCompany,
  Driver,
  OrderListItem,
} from "@/features/orders/types";
import { OrderStatus } from "@/features/orders/components/OrderStatus";
import { OrderDelivery } from "@/features/orders/components/OrderDelivery";
import { OrderRowActions } from "@/features/orders/components/OrderFulfillmentActions";
import {
  bulkAssignConfirmationOrders,
  type OperationAgent,
} from "@/features/operations/api";

interface RowProps {
  order: OrderListItem;
  drivers: Driver[];
  companies: DeliveryCompany[];
  onChanged: () => void | Promise<void>;
  onError: (message: string) => void;
  agents?: OperationAgent[];
  isAdmin?: boolean;
  selected?: boolean;
  onSelected?: (selected: boolean) => void;
}

function ConfirmationAssignment({
  order,
  agents = [],
  isAdmin,
  onChanged,
  onError,
}: Pick<RowProps, "order" | "agents" | "isAdmin" | "onChanged" | "onError">) {
  const t = useT("orders");
  const [busy, setBusy] = useState(false);
  const isConfirmation =
    order.status === "new" || order.status === "unreachable";
  const label = isConfirmation
    ? t("assignment.confirmation_agent")
    : t("assignment.follow_up_agent");
  if (!isAdmin)
    return (
      <div className="text-xs">
        <span className="block text-muted-foreground">{label}</span>
        <span className="font-medium">
          {order.confirmationAssigneeName ?? t("assignment.unassigned")}
        </span>
      </div>
    );
  return (
    <label className="block min-w-36 text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <Select
        value={order.confirmationAssigneeId ?? ""}
        disabled={busy}
        aria-label={label}
        onChange={async (event) => {
          const assigneeId = event.target.value;
          if (!assigneeId) return;
          setBusy(true);
          try {
            await bulkAssignConfirmationOrders([order.id], assigneeId);
            await onChanged();
          } catch (cause) {
            onError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        }}
        className="h-8 text-xs"
      >
        <option value="" disabled>
          {t("assignment.unassigned")}
        </option>
        {agents
          .filter((agent) => agent.status === "active")
          .map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
      </Select>
    </label>
  );
}


/** Red/amber dot when an order sits too long in a state the merchant owns. */
export function OrderSlaBadge({ order }: { order: OrderListItem }) {
  const t = useT("orders");
  const sla = orderSla(order);
  if (sla.level === "ok") return null;

  const label =
    sla.stage === "new"
      ? t("sla.new_overdue").replace("{hours}", String(sla.hours))
      : t("sla.delivery_overdue").replace("{days}", String(sla.days));
  const tone =
    sla.level === "breach"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : "border-warning/40 bg-warning/10 text-warning";

  return (
    <span
      title={label}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}
    >
      <Clock size={11} aria-hidden="true" />
      {label}
    </span>
  );
}

/** tel: / wa.me shortcuts straight from the row — the confirmer's main tools. */
export function OrderQuickContact({ order }: { order: OrderListItem }) {
  const t = useT("orders");
  const tel = telLink(order.phone);
  const message = t("quick_contact.whatsapp_message").replace(
    "{order}",
    order.orderNumber,
  );
  const wa = whatsappLink(order.phone, message);
  if (!tel && !wa) {
    return <span className="text-xs text-muted-foreground">{t("quick_contact.no_phone")}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-xs text-muted-foreground" dir="ltr">
        {order.phone}
      </span>
      {tel && (
        <a
          href={tel}
          aria-label={t("quick_contact.call")}
          title={t("quick_contact.call")}
          className="grid size-7 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <Phone size={13} />
        </a>
      )}
      {wa && (
        <a
          href={wa}
          target="_blank"
          rel="noreferrer"
          aria-label={t("quick_contact.whatsapp")}
          title={t("quick_contact.whatsapp")}
          className="grid size-7 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <MessageCircle size={13} />
        </a>
      )}
    </span>
  );
}

export function OrderDesktopRow({
  order,
  drivers,
  companies,
  onChanged,
  onError,
  agents,
  isAdmin,
  selected,
  onSelected,
}: RowProps) {
  const locale = useLocale();
  return (
    <TableRow className="border-b border-border last:border-0 transition-colors hover:bg-muted/40">
      {onSelected && (
        <TableCell>
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelected(event.target.checked)}
            aria-label={`Select ${order.orderNumber}`}
          />
        </TableCell>
      )}
      <TableCell>
        <a
          href={`/orders/${order.id}`}
          className="inline-flex items-center gap-2 font-semibold text-link underline-offset-4 hover:underline"
        >
          <span className="grid size-7 place-items-center rounded-lg bg-accent text-accent-foreground">
            <PackageOpen size={14} />
          </span>
          {order.orderNumber}
          {(order.hasReview ?? 0) > 0 && (
            <Star size={12} className="fill-warning text-warning" />
          )}
        </a>
        <OrderSlaBadge order={order} />
      </TableCell>
      <TableCell>
        <p className="font-medium text-foreground">{order.customerName}</p>
      </TableCell>
      <TableCell>
        <OrderQuickContact order={order} />
      </TableCell>
      <TableCell>
        <OrderStatus order={order} onChanged={onChanged} onError={onError} />
      </TableCell>
      <TableCell>
        <ConfirmationAssignment
          order={order}
          agents={agents}
          isAdmin={isAdmin}
          onChanged={onChanged}
          onError={onError}
        />
      </TableCell>
      <TableCell>
        <span className="inline-flex max-w-44 items-start gap-1.5 truncate text-xs font-medium">
          <MapPin size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
          {order.wilaya}
          {order.commune ? ` · ${order.commune}` : ""}
        </span>
      </TableCell>
      <TableCell>
        <OrderDelivery order={order} companies={companies} />
      </TableCell>
      <TableCell className="text-end font-bold tabular-nums text-foreground">
        {formatMoney(orderTotal(order), locale)}
      </TableCell>
      <TableCell className="text-end">
        <OrderRowActions
          order={order}
          drivers={drivers}
          companies={companies}
          onChanged={onChanged}
          onError={onError}
        />
      </TableCell>
    </TableRow>
  );
}

export function OrderMobileCard({
  order,
  drivers,
  companies,
  onChanged,
  onError,
  agents,
  isAdmin,
  selected,
  onSelected,
}: RowProps) {
  const locale = useLocale();
  return (
    <article className="p-4">
      <div className="flex items-start justify-between gap-3">
        {onSelected && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelected(event.target.checked)}
            aria-label={`Select ${order.orderNumber}`}
            className="mt-1"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <a
              href={`/orders/${order.id}`}
              className="text-sm font-semibold text-link hover:underline"
            >
              {order.orderNumber}
            </a>
            {(order.hasReview ?? 0) > 0 && (
              <Star size={12} className="fill-warning text-warning" />
            )}
            <OrderSlaBadge order={order} />
          </div>
          <p className="mt-0.5 truncate text-sm font-medium text-foreground">
            {order.customerName}
          </p>
          <p className="mt-0.5">
            <OrderQuickContact order={order} />
          </p>
        </div>
        <div className="flex items-start gap-1">
          <OrderStatus order={order} onChanged={onChanged} onError={onError} />
          <OrderRowActions
            order={order}
            drivers={drivers}
            companies={companies}
            onChanged={onChanged}
            onError={onError}
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1 truncate">
          <MapPin size={13} />
          {order.wilaya}
          {order.commune ? ` · ${order.commune}` : ""}
        </span>
        <span className="shrink-0 text-sm font-bold tabular-nums text-foreground">
          {formatMoney(orderTotal(order), locale)}
        </span>
      </div>
      <div className="mt-3">
        <ConfirmationAssignment
          order={order}
          agents={agents}
          isAdmin={isAdmin}
          onChanged={onChanged}
          onError={onError}
        />
      </div>
      <div className="mt-2">
        <OrderDelivery order={order} companies={companies} />
      </div>
    </article>
  );
}
