import { useEffect, useState } from "react";
import {
  Ban,
  CalendarClock,
  CheckCircle2,
  History,
  MessageCircle,
  MessageSquareText,
  Phone,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  type LucideIcon,
} from "lucide-react";
import { useLocale, useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import { ApiError } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  LinkButton,
  Textarea,
} from "@/components/ui";
import { listContactAttempts, logContactAttempt } from "@/features/orders/api";
import {
  canLogContact,
  defaultCallbackInput,
  orderActivityHref,
  telLink,
  toCallbackIso,
  whatsappLink,
} from "@/features/orders/model";
import type {
  ContactAttempt,
  ContactChannel,
  ContactOutcome,
  ContactSummary,
  OrderDetail,
} from "@/features/orders/types";
import {
  CALL_OUTCOMES,
  NOTE_MAX_LENGTH,
} from "../../../../../cod-shared/lib/order-contact";

const OUTCOME_ICONS: Record<ContactOutcome, LucideIcon> = {
  no_answer: PhoneMissed,
  busy: PhoneOutgoing,
  switched_off: PhoneOff,
  wrong_number: Ban,
  answered: CheckCircle2,
  callback_requested: CalendarClock,
  message_sent: MessageSquareText,
};

const OUTCOME_TONES: Record<ContactOutcome, string> = {
  no_answer: "border-[var(--status-preparing-border)] text-[var(--status-preparing-text)] hover:bg-[var(--status-preparing-bg)]",
  busy: "border-[var(--status-preparing-border)] text-[var(--status-preparing-text)] hover:bg-[var(--status-preparing-bg)]",
  switched_off: "border-[var(--status-preparing-border)] text-[var(--status-preparing-text)] hover:bg-[var(--status-preparing-bg)]",
  wrong_number: "border-[var(--status-returned-border)] text-[var(--status-returned-text)] hover:bg-[var(--status-returned-bg)]",
  answered: "border-[var(--status-confirmed-border)] text-[var(--status-confirmed-text)] hover:bg-[var(--status-confirmed-bg)]",
  callback_requested: "border-[var(--status-ready-border)] text-[var(--status-ready-text)] hover:bg-[var(--status-ready-bg)]",
  message_sent: "border-[var(--status-ready-border)] text-[var(--status-ready-text)] hover:bg-[var(--status-ready-bg)]",
};

export function formatContactTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-DZ" : `${locale}-DZ`, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatClock(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-DZ" : `${locale}-DZ`, {
    timeStyle: "short",
  }).format(date);
}

export function ContactOutcomeBadge({
  channel,
  outcome,
}: {
  channel: ContactChannel;
  outcome: ContactOutcome;
}) {
  const t = useT("orders");
  const Icon = channel === "call" ? OUTCOME_ICONS[outcome] : MessageCircle;
  const tone =
    outcome === "answered"
      ? "success"
      : outcome === "wrong_number"
        ? "critical"
        : outcome === "callback_requested" || outcome === "message_sent"
          ? "info"
          : "warning";
  return (
    <Badge tone={tone} size="sm">
      <Icon size={11} aria-hidden="true" />
      {outcome === "message_sent"
        ? `${t("contact.outcomes.message_sent")} · ${t(`contact.channels.${channel}`)}`
        : t(`contact.outcomes.${outcome}`)}
    </Badge>
  );
}

export function OrderContactCard({
  order,
  canUpdate,
  onStatusChanged,
}: {
  order: Pick<OrderDetail, "id" | "orderNumber" | "phone" | "status">;
  canUpdate: boolean;
  onStatusChanged: () => void | Promise<void>;
}) {
  const t = useT("orders");
  const common = useT("common");
  const locale = useLocale();
  const [attempts, setAttempts] = useState<ContactAttempt[] | null>(null);
  const [summary, setSummary] = useState<ContactSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [callbackOpen, setCallbackOpen] = useState(false);
  const [callbackAt, setCallbackAt] = useState(defaultCallbackInput);

  async function load() {
    setLoadError(null);
    try {
      const data = await listContactAttempts(order.id);
      setAttempts(data.attempts);
      setSummary(data.summary);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    void load();
  }, [order.id]);

  const open = canLogContact(order.status);
  const editable = canUpdate && open;
  const limitReached = summary?.limitReached ?? false;
  const tel = telLink(order.phone);
  const wa = whatsappLink(
    order.phone,
    t("quick_contact.whatsapp_message").replace("{order}", order.orderNumber),
  );
  const sms = tel ? tel.replace("tel:", "sms:") : null;

  async function submit(channel: ContactChannel, outcome: ContactOutcome, callbackIso: string | null = null) {
    setBusy(true);
    try {
      const result = await logContactAttempt(order.id, {
        channel,
        outcome,
        note: note.trim() || null,
        callbackAt: callbackIso,
      });
      setSummary(result.summary);
      setAttempts((current) => [result.attempt, ...(current ?? [])]);
      setNote("");
      setCallbackOpen(false);
      const label =
        outcome === "message_sent"
          ? `${t("contact.outcomes.message_sent")} · ${t(`contact.channels.${channel}`)}`
          : t(`contact.outcomes.${outcome}`);
      if (result.callbackTaskId && callbackIso) {
        notify.success(t("contact.callback_scheduled").replace("{time}", formatContactTime(callbackIso, locale)));
      } else {
        notify.success(
          (result.statusChanged ? t("contact.recorded_unreachable") : t("contact.recorded")).replace("{outcome}", label),
        );
      }
      if (result.statusChanged) await onStatusChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "CONTACT_LIMIT_REACHED") {
        notify.error(t("contact.limit_reached"));
        await load();
      } else {
        notify.error(cause instanceof ApiError && cause.message ? cause.message : t("contact.error"));
      }
    } finally {
      setBusy(false);
    }
  }

  function openCallback() {
    setCallbackAt(defaultCallbackInput());
    setCallbackOpen(true);
  }

  const pendingCallback =
    order.status === "new" || order.status === "unreachable" ? summary?.nextCallbackAt ?? null : null;
  const used = summary?.unansweredToday ?? 0;
  const limit = summary?.dailyLimit ?? 3;

  return (
    <Card
      title={t("contact.title")}
      subtitle={t("contact.subtitle")}
      action={
        <LinkButton href={orderActivityHref(order.id)} variant="secondary" size="sm">
          <History size={14} aria-hidden="true" />
          {t("contact.view_log")}
        </LinkButton>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {tel && (
            <LinkButton href={tel} variant="primary" size="sm">
              <Phone size={14} aria-hidden="true" />
              {t("contact.call_now")}
            </LinkButton>
          )}
          {wa && (
            <LinkButton href={wa} target="_blank" rel="noreferrer" variant="secondary" size="sm">
              <MessageCircle size={14} aria-hidden="true" />
              {t("contact.whatsapp_now")}
            </LinkButton>
          )}
          {sms && (
            <LinkButton href={sms} variant="secondary" size="sm">
              <MessageSquareText size={14} aria-hidden="true" />
              {t("contact.sms_now")}
            </LinkButton>
          )}
          <span className="ms-auto text-sm font-semibold text-foreground" dir="ltr">
            {order.phone}
          </span>
        </div>

        <div className="rounded-xl border border-border/80 bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-muted-foreground">{t("contact.today_counter")}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-foreground" aria-live="polite">
                {used}
                <span className="text-base font-semibold text-muted-foreground">/{limit}</span>
              </p>
            </div>
            <div className="flex gap-1.5" aria-hidden="true">
              {Array.from({ length: limit }, (_, index) => (
                <span
                  key={index}
                  className={`h-2.5 w-8 rounded-full ${index < used ? (limitReached ? "bg-destructive" : "bg-[var(--status-preparing-text)]") : "bg-border"}`}
                />
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {limitReached
              ? t("contact.resets_at").replace("{time}", summary ? formatContactTime(summary.resetsAt, locale) : "-")
              : t("contact.remaining").replace("{count}", String(summary?.remainingToday ?? limit))}
          </p>
        </div>

        {loadError && (
          <Alert tone="critical" role="alert">
            <span className="flex-1">{loadError}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
              {common("retry")}
            </Button>
          </Alert>
        )}

        {!open && <Alert tone="info">{t("contact.closed")}</Alert>}

        {editable && (
          <>
            {limitReached && <Alert tone="warning">{t("contact.limit_reached")}</Alert>}
            <div>
              <p className="mb-2 text-xs font-semibold text-muted-foreground">{t("contact.call_outcome")}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CALL_OUTCOMES.map((outcome) => {
                  const Icon = OUTCOME_ICONS[outcome];
                  const blocked =
                    limitReached &&
                    (outcome === "no_answer" || outcome === "busy" || outcome === "switched_off" || outcome === "wrong_number");
                  return (
                    <button
                      key={outcome}
                      type="button"
                      disabled={busy || blocked}
                      onClick={() =>
                        outcome === "callback_requested" ? openCallback() : void submit("call", outcome)
                      }
                      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border bg-card px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${OUTCOME_TONES[outcome]}`}
                    >
                      <Icon size={16} aria-hidden="true" />
                      {t(`contact.outcomes.${outcome}`)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-muted-foreground">{t("contact.message_sent_section")}</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void submit("whatsapp", "message_sent")}
                  className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border bg-card px-3 text-sm font-semibold transition-colors disabled:opacity-40 ${OUTCOME_TONES.message_sent}`}
                >
                  <MessageCircle size={16} aria-hidden="true" />
                  {t("contact.message_sent_whatsapp")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void submit("sms", "message_sent")}
                  className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border bg-card px-3 text-sm font-semibold transition-colors disabled:opacity-40 ${OUTCOME_TONES.message_sent}`}
                >
                  <MessageSquareText size={16} aria-hidden="true" />
                  {t("contact.message_sent_sms")}
                </button>
              </div>
            </div>
            <Field label={t("contact.note_label")}>
              <Textarea
                value={note}
                maxLength={NOTE_MAX_LENGTH}
                onChange={(event) => setNote(event.currentTarget.value)}
                placeholder={t("contact.note_placeholder")}
                className="min-h-16"
                disabled={busy}
              />
            </Field>
          </>
        )}

        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div className="rounded-lg border border-border/70 p-2.5">
            <p className="font-semibold text-muted-foreground">{t("contact.last_attempt")}</p>
            {summary?.lastAttempt ? (
              <div className="mt-1.5 space-y-1">
                <ContactOutcomeBadge channel={summary.lastAttempt.channel} outcome={summary.lastAttempt.outcome} />
                <p className="text-muted-foreground">
                  {formatContactTime(summary.lastAttempt.createdAt, locale)}
                  {summary.lastAttempt.createdByName ? ` · ${summary.lastAttempt.createdByName}` : ""}
                </p>
              </div>
            ) : (
              <p className="mt-1.5 font-medium text-foreground">{t("contact.never_contacted")}</p>
            )}
          </div>
          <div className="rounded-lg border border-border/70 p-2.5">
            <p className="font-semibold text-muted-foreground">{t("contact.next_callback")}</p>
            <p className="mt-1.5 font-medium text-foreground">
              {pendingCallback ? formatContactTime(pendingCallback, locale) : "—"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {t("contact.total_calls").replace("{count}", String(summary?.totalCalls ?? 0))}
              {" · "}
              {t("contact.total_messages").replace("{count}", String(summary?.totalMessages ?? 0))}
            </p>
          </div>
        </div>

        {attempts && attempts.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold text-muted-foreground">{t("contact.recent")}</p>
            <ul className="space-y-2">
              {attempts.slice(0, 4).map((attempt) => (
                <li key={attempt.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <ContactOutcomeBadge channel={attempt.channel} outcome={attempt.outcome} />
                  <span className="text-muted-foreground">
                    {formatClock(attempt.createdAt, locale)} · {attempt.createdByName}
                  </span>
                  {attempt.note && <span className="w-full truncate text-foreground/80">{attempt.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <Dialog
        open={callbackOpen}
        onClose={() => !busy && setCallbackOpen(false)}
        title={t("contact.outcomes.callback_requested")}
        description={t("contact.callback_hint")}
        icon={<CalendarClock size={18} />}
        preventClose={busy}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setCallbackOpen(false)} disabled={busy}>
              {t("contact.cancel")}
            </Button>
            <Button
              type="button"
              disabled={busy || !toCallbackIso(callbackAt)}
              onClick={() => void submit("call", "callback_requested", toCallbackIso(callbackAt))}
            >
              {busy ? t("contact.saving") : t("contact.save_callback")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t("contact.callback_label")}>
            <Input
              type="datetime-local"
              value={callbackAt}
              onChange={(event) => setCallbackAt(event.currentTarget.value)}
              dir="ltr"
            />
          </Field>
          <Field label={t("contact.note_label")}>
            <Textarea
              value={note}
              maxLength={NOTE_MAX_LENGTH}
              onChange={(event) => setNote(event.currentTarget.value)}
              placeholder={t("contact.note_placeholder")}
              className="min-h-16"
            />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
