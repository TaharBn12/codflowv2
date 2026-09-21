import { useEffect, useState } from "react";
import { CalendarClock, Loader2, Send } from "lucide-react";
import { Input, Select } from "@/components/ui";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import { getReportConfig, saveReportConfig, sendReportNow, type ReportConfigView } from "@/features/dashboard/api";
import { FieldRow, SettingsSection } from "./SettingsSection";

const TIMEZONES = ["Africa/Algiers", "Africa/Tunis", "Africa/Casablanca", "Europe/Paris", "UTC"];

function Toggle({ checked, onChange, label, hint, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
          checked ? "bg-brand" : "bg-muted-foreground/35"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 size-4 rounded-full shadow-sm transition-transform ${
            checked ? "translate-x-5 bg-brand-foreground" : "translate-x-0 bg-background"
          }`}
        />
      </button>
    </div>
  );
}

export function ReportsSettings() {
  const t = useT("settings");
  const [config, setConfig] = useState<ReportConfigView | null>(null);
  const [recipients, setRecipients] = useState("");
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getReportConfig()
      .then((value) => {
        setConfig(value);
        setRecipients(value.emailRecipients.join(", "));
      })
      .catch((cause) => setLoadError(cause instanceof Error ? cause.message : t("store.save_error")));
  }, []);

  function update<K extends keyof ReportConfigView>(key: K, value: ReportConfigView[K]) {
    setConfig((current) => (current ? { ...current, [key]: value } : current));
  }

  function parseRecipients(): string[] {
    return recipients
      .split(/[,;\n\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async function save() {
    if (!config) return;
    const emailRecipients = parseRecipients();
    if (config.emailEnabled && emailRecipients.length === 0) throw new Error(t("reports.recipients_required"));
    if (emailRecipients.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) throw new Error(t("reports.recipients_invalid"));
    const saved = await saveReportConfig({
      enabled: config.enabled,
      sendHour: config.sendHour,
      timezone: config.timezone,
      telegramEnabled: config.telegramEnabled,
      emailEnabled: config.emailEnabled,
      emailRecipients,
    });
    setConfig(saved);
    setRecipients(saved.emailRecipients.join(", "));
  }

  async function sendNow() {
    setSending(true);
    try {
      const result = await sendReportNow();
      const delivered = result.telegram === "sent" || result.email.sent > 0;
      if (delivered) {
        notify.success(t("reports.sent_success"));
      } else if (result.telegram === "not_configured" || result.email.notConfigured) {
        notify.error(t("reports.sent_not_configured"));
      } else {
        notify.error(t("reports.sent_failed"));
      }
      const refreshed = await getReportConfig();
      setConfig(refreshed);
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : t("reports.sent_failed"));
    } finally {
      setSending(false);
    }
  }

  if (loadError) {
    return <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{loadError}</p>;
  }
  if (!config) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-border bg-card">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hours = Array.from({ length: 24 }, (_, hour) => hour);

  return (
    <SettingsSection icon={CalendarClock} title={t("reports.title")} subtitle={t("reports.subtitle")} onSave={save}>
      <Toggle checked={config.enabled} onChange={(value) => update("enabled", value)} label={t("reports.enabled")} hint={t("reports.enabled_hint")} />

      <div className="grid gap-4 sm:grid-cols-2">
        <FieldRow label={t("reports.send_hour")} hint={t("reports.send_hour_hint")}>
          <Select value={String(config.sendHour)} onChange={(event) => update("sendHour", Number(event.currentTarget.value))}>
            {hours.map((hour) => (
              <option key={hour} value={String(hour)}>
                {String(hour).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label={t("reports.timezone")} hint={t("reports.timezone_hint")}>
          <Select value={config.timezone} onChange={(event) => update("timezone", event.currentTarget.value)}>
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
            {!TIMEZONES.includes(config.timezone) && <option value={config.timezone}>{config.timezone}</option>}
          </Select>
        </FieldRow>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
        <Toggle
          checked={config.telegramEnabled}
          onChange={(value) => update("telegramEnabled", value)}
          label={t("reports.telegram")}
          hint={config.telegramConfigured ? t("reports.telegram_ready") : t("reports.telegram_missing")}
        />
        <Toggle
          checked={config.emailEnabled}
          onChange={(value) => update("emailEnabled", value)}
          label={t("reports.email")}
          hint={config.emailConfigured ? t("reports.email_ready") : t("reports.email_missing")}
        />
        {config.emailEnabled && (
          <FieldRow label={t("reports.recipients")} hint={t("reports.recipients_hint")}>
            <Input dir="ltr" value={recipients} onChange={(event) => setRecipients(event.currentTarget.value)} placeholder="owner@example.com, finance@example.com" />
          </FieldRow>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand/20 bg-brand/5 px-4 py-3">
        <div>
          <p className="text-sm font-semibold">{t("reports.send_now")}</p>
          <p className="text-xs text-muted-foreground">
            {t("reports.send_now_hint")}
            {config.lastSentOn && (
              <>
                {" "}
                · {t("reports.last_sent")}: <span dir="ltr">{config.lastSentOn}</span>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void sendNow()}
          disabled={sending}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          {t("reports.send_now")}
        </button>
      </div>
    </SettingsSection>
  );
}
