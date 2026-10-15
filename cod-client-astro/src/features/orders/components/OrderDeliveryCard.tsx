import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { canScope } from "@/features/auth/components/RequireAuth";
import { useLocale, useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import { syncOrderCarrierStatus } from "@/features/orders/api";
import type { DeliveryCompany, OrderDetail } from "@/features/orders/types";

interface OrderDeliveryCardProps {
  order: Pick<
    OrderDetail,
    | "id"
    | "deliveryType"
    | "stationCode"
    | "deliveryAttempts"
    | "trackingNumber"
    | "driverName"
    | "trackingUrl"
    | "notes"
    | "lastTrackingSyncAt"
    | "lastCarrierStatus"
    | "trackingSyncFails"
  >;
  company?: DeliveryCompany;
  identity?: Parameters<typeof canScope>[0];
  /** Called after a successful sync so the parent can reload the order. */
  onSynced?: () => void | Promise<void>;
}

export function OrderDeliveryCard({
  order,
  company,
  identity,
  onSynced,
}: OrderDeliveryCardProps) {
  const t = useT("orders");
  const locale = useLocale();
  const [syncBusy, setSyncBusy] = useState(false);

  const maySync =
    !!order.trackingNumber && canScope(identity ?? null, "orders:update");

  async function syncNow() {
    setSyncBusy(true);
    try {
      const result = await syncOrderCarrierStatus(order.id);
      if (result.outcome === "updated")
        notify.success(`${t("carrier_sync.updated_to")} ${t(`status.${result.to}`)}`);
      else if (result.outcome === "unmapped")
        notify.error(
          `${t("carrier_sync.unmapped_status")}: ${result.carrierStatus ?? "—"}`,
        );
      else if (result.outcome === "error") notify.error(t("carrier_sync.failed"));
      else notify.success(t("carrier_sync.unchanged"));
      await onSynced?.();
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Card title={t("detail.delivery_info")}>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">
              {t("detail.delivery_type")}
            </span>
            <span className="font-semibold">
              {order.deliveryType === "home"
                ? t("detail.home_delivery")
                : t("detail.stop_desk")}
            </span>
          </div>
          {order.stationCode && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                {t("dispatch_dialog.station_code_label")}
              </span>
              <span className="font-mono text-xs font-semibold">
                {order.stationCode}
              </span>
            </div>
          )}
          {order.deliveryAttempts != null && order.deliveryAttempts > 0 && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                {t("detail.delivery_attempts")}
              </span>
              <span className="font-semibold">
                {order.deliveryAttempts}
              </span>
            </div>
          )}
          {order.trackingNumber && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                {t("detail.tracking_number")}
              </span>
              <span dir="ltr" className="font-mono text-xs font-semibold">
                {order.trackingNumber}
              </span>
            </div>
          )}
          {company && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                {t("detail.company")}
              </span>
              <span className="font-semibold">{company.name}</span>
            </div>
          )}
          {order.lastCarrierStatus && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                {t("carrier_sync.last_status")}
              </span>
              <span className="max-w-52 truncate text-end font-semibold" title={order.lastCarrierStatus}>
                {order.lastCarrierStatus}
              </span>
            </div>
          )}
          {order.trackingNumber && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                {t("carrier_sync.last_sync")}
              </span>
              <span className="text-end text-xs font-medium">
                {order.lastTrackingSyncAt
                  ? new Intl.DateTimeFormat(locale, {
                      dateStyle: "short",
                      timeStyle: "short",
                    }).format(new Date(order.lastTrackingSyncAt))
                  : t("carrier_sync.never_synced")}
                {(order.trackingSyncFails ?? 0) > 0 && (
                  <span className="ms-1 text-destructive">
                    · {order.trackingSyncFails} {t("carrier_sync.fails_count")}
                  </span>
                )}
              </span>
            </div>
          )}
          {maySync && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={syncBusy}
              onClick={() => void syncNow()}
            >
              <RefreshCw size={14} className={syncBusy ? "animate-spin" : undefined} />
              {syncBusy ? t("carrier_sync.syncing") : t("carrier_sync.row_button")}
            </Button>
          )}
          {order.driverName && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                {t("detail.driver")}
              </span>
              <span className="font-semibold">{order.driverName}</span>
            </div>
          )}
          {order.trackingUrl && (
            <a
              href={order.trackingUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-link"
            >
              {t("detail.track_on_provider")}
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </Card>
      <Card title={t("detail.notes")}>
        <p className="text-sm text-foreground">
          {order.notes || t("detail.no_notes")}
        </p>
      </Card>
    </div>
  );
}
