import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, History, RefreshCw } from "lucide-react";
import { Button, Field, Input } from "@/components/ui";
import { useLocale, useT } from "@/i18n/react";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import {
  getCompanyAutoSyncStatus,
  listCompanySyncRuns,
  syncCompanyStatuses,
  updateDeliveryCompany,
} from "@/features/delivery/api";
import type { DeliveryCompany } from "@/features/delivery/types";
import type { CarrierAutoSyncStatus, CarrierSyncRun } from "@/features/orders/types";

const TRIGGER_KEYS = {
  cron: "auto_sync_trigger_cron",
  manual: "auto_sync_trigger_manual",
  company: "auto_sync_trigger_company",
} as const;

/**
 * Per-company carrier status auto-sync control.
 *
 * Sits next to the webhook cards on the credentials page: webhooks are the
 * push path, this is the pull path (the only status source for carriers with
 * no webhooks, and the catch-up for the rest). The switches persist on the
 * company row; the counters and history come from carrier_sync_runs.
 */
export function CompanyAutoSyncCard({
  company,
  canManage,
  onChanged,
}: {
  company: DeliveryCompany | null;
  canManage: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const t = useT("delivery_companies");
  const locale = useLocale();
  const [status, setStatus] = useState<CarrierAutoSyncStatus | null>(null);
  const [runs, setRuns] = useState<CarrierSyncRun[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [intervalMin, setIntervalMin] = useState(30);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    if (!company) return;
    try {
      const [nextStatus, nextRuns] = await Promise.all([
        getCompanyAutoSyncStatus(company.id),
        listCompanySyncRuns(company.id, 8),
      ]);
      setStatus(nextStatus);
      setRuns(nextRuns);
      setEnabled(nextStatus.autoSyncEnabled);
      setIntervalMin(nextStatus.autoSyncIntervalMin);
    } catch {
      // The card is informational — a failed load must not break the page.
      setStatus(null);
      setRuns([]);
    }
  }, [company?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!company) return;
    setSaving(true);
    try {
      await updateDeliveryCompany(company.id, {
        autoSyncEnabled: enabled,
        autoSyncIntervalMin: Math.min(1440, Math.max(5, intervalMin || 30)),
      } as Partial<DeliveryCompany>);
      notify.flashSuccess(t("auto_sync_saved"));
      await load();
      await onChanged?.();
    } catch {
      notify.error(t("auto_sync_save_failed"));
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    if (!company) return;
    setRunning(true);
    try {
      const result = await syncCompanyStatuses(company.id, { force: true });
      notify.success(
        t("auto_sync_result")
          .replace("{updated}", String(result.updated))
          .replace("{polled}", String(result.polled)),
      );
      await load();
      await onChanged?.();
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }

  const dirty =
    !!status &&
    (status.autoSyncEnabled !== enabled || status.autoSyncIntervalMin !== intervalMin);

  function formatWhen(value: string | null) {
    if (!value) return t("auto_sync_never_run");
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value));
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          <History size={14} className="text-primary/50" aria-hidden="true" />
          {t("auto_sync_title")}
        </h2>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-[10px] font-bold",
            enabled
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          {enabled ? t("auto_validate_on") : t("auto_validate_off")}
        </span>
      </div>

      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        {t("auto_sync_hint")}
        {status?.hasWebhookSecret ? ` ${t("auto_sync_webhook_note")}` : ""}
      </p>

      {!status?.hasCredentials && (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {t("auto_sync_no_credentials")}
        </p>
      )}

      {status && (
        <div className="mb-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div className="rounded-lg border border-border p-2.5">
            <span className="block text-muted-foreground">{t("auto_sync_shipped")}</span>
            <span className="text-base font-bold tabular-nums">{status.shippedOrders}</span>
          </div>
          <div
            className={cn(
              "rounded-lg border p-2.5",
              status.failingOrders > 0
                ? "border-destructive/40 bg-destructive/5"
                : "border-border",
            )}
          >
            <span className="block text-muted-foreground">{t("auto_sync_failing")}</span>
            <span className="text-base font-bold tabular-nums">{status.failingOrders}</span>
          </div>
          <div className="rounded-lg border border-border p-2.5">
            <span className="block text-muted-foreground">{t("auto_sync_counters_updated")}</span>
            <span className="text-base font-bold tabular-nums">{status.lastRun?.updated ?? 0}</span>
          </div>
          <div className="rounded-lg border border-border p-2.5">
            <span className="block text-muted-foreground">{t("auto_sync_counters_unmapped")}</span>
            <span className="text-base font-bold tabular-nums">{status.lastRun?.unmapped ?? 0}</span>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canManage}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t("auto_sync_enabled_label")}
        </label>
        <Field label={t("auto_sync_interval_label")} hint={t("auto_sync_interval_hint")}>
          <Input
            type="number"
            min={5}
            max={1440}
            step={5}
            value={intervalMin}
            disabled={!canManage}
            onChange={(event) => setIntervalMin(Number(event.target.value))}
            className="h-9 w-28"
          />
        </Field>
        {canManage && (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? t("saving") : t("auto_sync_save")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={running || !status?.hasCredentials}
              onClick={() => void runNow()}
            >
              <RefreshCw size={14} className={running ? "animate-spin" : undefined} />
              {running ? t("auto_sync_running") : t("auto_sync_run_now")}
            </Button>
          </div>
        )}
      </div>

      {status?.lastRun?.unmappedStatuses && status.lastRun.unmappedStatuses.length > 0 && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <p className="text-xs font-semibold text-warning">{t("auto_sync_unmapped_title")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("auto_sync_unmapped_hint")}</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {status.lastRun.unmappedStatuses.map((value) => (
              <li
                key={value}
                className="rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[11px]"
              >
                {value}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
          {t("auto_sync_runs_title")}
        </h3>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("auto_sync_runs_empty")}</p>
        ) : (
          <ul className="space-y-1.5">
            {runs.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2 text-xs"
              >
                <span className="font-medium">{formatWhen(run.startedAt)}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold">
                  {t(TRIGGER_KEYS[run.trigger])}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {t(run.mode === "reconcile" ? "auto_sync_mode_reconcile" : "auto_sync_mode_poll")}
                </span>
                <span className="ms-auto tabular-nums text-muted-foreground">
                  {run.updated} {t("auto_sync_counters_updated")} · {run.unchanged}{" "}
                  {t("auto_sync_counters_unchanged")}
                  {run.unmapped > 0 ? ` · ${run.unmapped} ${t("auto_sync_counters_unmapped")}` : ""}
                  {run.errors > 0 ? ` · ${run.errors} ${t("auto_sync_counters_errors")}` : ""}
                </span>
                {run.error && (
                  <span className="w-full text-destructive">{run.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
