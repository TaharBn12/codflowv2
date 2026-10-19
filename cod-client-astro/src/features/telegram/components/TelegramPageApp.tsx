import { useEffect, useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import {
  Activity,
  Bot,
  CheckCircle2,
  Copy,
  Link2,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import { DashboardChrome } from "@/components/layout/chrome";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { RequireAuth, useIdentity } from "@/features/auth/components/RequireAuth";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import {
  createBotLinkCode,
  decideApprovalRequest,
  getTelegramOverview,
  listApprovalRequests,
  revokeBotLink,
  saveBotConfig,
  sendBotTest,
} from "../api";
import type {
  ApprovalRequest,
  ApprovalStatus,
  BotConfig,
  BotLanguage,
  LinkCodeResult,
  TelegramOverview,
} from "../types";

const dateFormatter = new Intl.DateTimeFormat("fr-DZ", {
  dateStyle: "short",
  timeStyle: "short",
});

function formatDate(value: string | null | undefined, neverLabel: string) {
  if (!value) return neverLabel;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function statusTone(status: ApprovalRequest["status"]) {
  if (status === "approved") return "success" as const;
  if (status === "pending") return "warning" as const;
  if (status === "rejected" || status === "failed") return "critical" as const;
  return "neutral" as const;
}

function BotConfigForm({
  config,
  onSaved,
}: {
  config: BotConfig;
  onSaved: (next: BotConfig) => void;
}) {
  const t = useT("telegram");
  const [draft, setDraft] = useState<BotConfig>(config);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(config), [config]);

  const patch = (value: Partial<BotConfig>) => setDraft((current) => ({ ...current, ...value }));

  async function save() {
    setSaving(true);
    try {
      const saved = await saveBotConfig({
        enabled: draft.enabled,
        defaultLanguage: draft.defaultLanguage,
        quietHoursStart: draft.quietHoursStart,
        quietHoursEnd: draft.quietHoursEnd,
        digestIntervalMinutes: draft.digestIntervalMinutes,
        weeklyReportEnabled: draft.weeklyReportEnabled,
        weeklyReportDay: draft.weeklyReportDay,
        weeklyReportHour: draft.weeklyReportHour,
        monthlyReportEnabled: draft.monthlyReportEnabled,
        monthlyReportHour: draft.monthlyReportHour,
      });
      setDraft(saved);
      onSaved(saved);
      notify.success(t("config.saved"));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("config.error"));
    } finally {
      setSaving(false);
    }
  }

  const days = useMemo(
    () => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, label: t(`day_${day}`) })),
    [t],
  );

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold">{t("config.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("config.subtitle")}</p>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
            className="size-4 accent-[var(--brand)]"
          />
          {t("config.enabled")}
        </label>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label={t("config.default_language")}>
          <Select
            value={draft.defaultLanguage}
            onChange={(event) => patch({ defaultLanguage: event.target.value as BotLanguage })}
          >
            <option value="ar">العربية</option>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </Select>
        </Field>
        <Field label={t("config.digest")}>
          <Input
            type="number"
            min={5}
            max={1440}
            value={draft.digestIntervalMinutes}
            onChange={(event) => patch({ digestIntervalMinutes: Number(event.target.value) })}
          />
        </Field>
        <Field label={t("config.quiet_start")}>
          <Input
            type="number"
            min={0}
            max={23}
            value={draft.quietHoursStart}
            onChange={(event) => patch({ quietHoursStart: Number(event.target.value) })}
          />
        </Field>
        <Field label={t("config.quiet_end")}>
          <Input
            type="number"
            min={0}
            max={23}
            value={draft.quietHoursEnd}
            onChange={(event) => patch({ quietHoursEnd: Number(event.target.value) })}
          />
        </Field>
        <Field label={t("config.weekly")}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.weeklyReportEnabled}
              onChange={(event) => patch({ weeklyReportEnabled: event.target.checked })}
              className="size-4 accent-[var(--brand)]"
            />
            {t("config.weekly")}
          </label>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("config.weekly_day")}>
            <Select
              value={String(draft.weeklyReportDay)}
              onChange={(event) => patch({ weeklyReportDay: Number(event.target.value) })}
            >
              {days.map((day) => (
                <option key={day.day} value={day.day}>
                  {day.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("config.weekly_hour")}>
            <Input
              type="number"
              min={0}
              max={23}
              value={draft.weeklyReportHour}
              onChange={(event) => patch({ weeklyReportHour: Number(event.target.value) })}
            />
          </Field>
        </div>
        <Field label={t("config.monthly")}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.monthlyReportEnabled}
              onChange={(event) => patch({ monthlyReportEnabled: event.target.checked })}
              className="size-4 accent-[var(--brand)]"
            />
            {t("config.monthly")}
          </label>
        </Field>
        <Field label={t("config.monthly_hour")}>
          <Input
            type="number"
            min={0}
            max={23}
            value={draft.monthlyReportHour}
            onChange={(event) => patch({ monthlyReportHour: Number(event.target.value) })}
          />
        </Field>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">{t("config.quiet_hint")}</p>
      <div className="mt-4 flex justify-end">
        <Button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("config.save")}
        </Button>
      </div>
    </Card>
  );
}

function LinkCodePanel({
  overview,
  onGenerated,
}: {
  overview: TelegramOverview;
  onGenerated: () => void;
}) {
  const t = useT("telegram");
  const [userId, setUserId] = useState("");
  const [ttl, setTtl] = useState(60);
  const [result, setResult] = useState<LinkCodeResult | null>(null);
  const [loading, setLoading] = useState(false);

  const linkedUserIds = new Set(overview.links.filter((link) => !link.revokedAt).map((link) => link.userId));
  const candidates = overview.members.filter((member) => member.status === "active" && !linkedUserIds.has(member.id));

  async function generate() {
    if (!userId) return;
    setLoading(true);
    try {
      const code = await createBotLinkCode(userId, ttl);
      setResult(code);
      onGenerated();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("generate.error"));
    } finally {
      setLoading(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify.success(t("actions.copied"));
    } catch {
      notify.error(t("generate.error"));
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-brand/25 bg-brand/10 text-brand">
          <Link2 className="size-5" />
        </span>
        <div>
          <h2 className="font-bold">{t("generate.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("generate.subtitle")}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px]">
        <Field label={t("generate.member")}>
          <Select value={userId} onChange={(event) => setUserId(event.target.value)}>
            <option value="">{t("generate.choose")}</option>
            {candidates.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name} · {member.email}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("generate.ttl")}>
          <Select value={String(ttl)} onChange={(event) => setTtl(Number(event.target.value))}>
            <option value="15">{t("generate.ttl_15")}</option>
            <option value="60">{t("generate.ttl_hour")}</option>
            <option value="1440">{t("generate.ttl_day")}</option>
          </Select>
        </Field>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t("generate.hint")}</p>
        <Button type="button" onClick={() => void generate()} disabled={!userId || loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
          {t("generate.button")}
        </Button>
      </div>

      {result ? (
        <div className="mt-4 rounded-xl border border-brand/25 bg-brand/5 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold">{t("generate.code")}:</span>
            <code className="rounded-lg bg-card px-3 py-1.5 text-lg font-black tracking-[0.25em]">{result.code}</code>
            <Button type="button" variant="secondary" size="sm" onClick={() => void copy(result.command)}>
              <Copy className="size-4" />
              {t("generate.command")}
            </Button>
            {result.deepLink ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => void copy(result.deepLink!)}>
                <Copy className="size-4" />
                {t("generate.deeplink")}
              </Button>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("generate.expires")}: {formatDate(result.expiresAt, "—")}
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function LinkedAccounts({ overview, reload }: { overview: TelegramOverview; reload: () => void }) {
  const t = useT("telegram");
  const [busy, setBusy] = useState<string | null>(null);
  const links = overview.links;

  async function test(telegramUserId: string) {
    setBusy(telegramUserId);
    try {
      await sendBotTest(telegramUserId);
      notify.success(t("links.test"));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("events.failed"));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(telegramUserId: string) {
    setBusy(telegramUserId);
    try {
      await revokeBotLink(telegramUserId);
      notify.success(t("links.revoked"));
      reload();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("events.failed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="font-bold">{t("links.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("links.subtitle")}</p>

      {links.length === 0 ? (
        <div className="mt-4">
          <EmptyState icon={<Users className="size-5" />} title={t("links.empty")} compact />
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("links.member")}</TableHead>
                <TableHead>{t("links.telegram")}</TableHead>
                <TableHead>{t("links.language")}</TableHead>
                <TableHead>{t("links.mode")}</TableHead>
                <TableHead>{t("links.last_seen")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((link) => {
                const revoked = Boolean(link.revokedAt);
                return (
                  <TableRow key={link.telegramUserId} className={revoked ? "opacity-60" : undefined}>
                    <TableCell>
                      <div className="font-semibold">{link.userName ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {link.userRole ? t(`roles.${link.userRole}`) : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">@{link.username ?? link.firstName ?? link.telegramUserId}</div>
                      <div className="text-xs text-muted-foreground">{link.telegramUserId}</div>
                    </TableCell>
                    <TableCell className="uppercase">{link.language}</TableCell>
                    <TableCell>
                      <Badge tone={link.digestMode === "instant" ? "success" : "neutral"}>
                        {t(`links.${link.digestMode}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(link.lastSeenAt, t("links.never"))}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={revoked || busy === link.telegramUserId}
                          onClick={() => void test(link.telegramUserId)}
                        >
                          <Send className="size-3.5" />
                          {t("links.test")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={revoked || busy === link.telegramUserId}
                          onClick={() => void revoke(link.telegramUserId)}
                        >
                          <Trash2 className="size-3.5" />
                          {t("links.revoke")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

function ApprovalInbox({
  initial,
  reload,
}: {
  initial: { rows: ApprovalRequest[]; total: number };
  reload: () => void;
}) {
  const t = useT("telegram");
  const [filter, setFilter] = useState<ApprovalStatus>("pending");
  const [rows, setRows] = useState<ApprovalRequest[]>(initial.rows);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setRows(filter === "pending" ? initial.rows : rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.rows]);

  async function changeFilter(next: ApprovalStatus) {
    setFilter(next);
    try {
      const result = await listApprovalRequests(next);
      setRows(result.rows);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("approvals.decide_error"));
    }
  }

  async function decide(row: ApprovalRequest, decision: "approve" | "reject") {
    setBusy(row.id);
    try {
      await decideApprovalRequest(row.id, decision, notes[row.id]);
      notify.success(t("approvals.decided"));
      const result = await listApprovalRequests(filter);
      setRows(result.rows);
      reload();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("approvals.decide_error"));
    } finally {
      setBusy(null);
    }
  }

  const tabs: ApprovalStatus[] = ["pending", "approved", "rejected", "expired", "all"];

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-bold">
            <ShieldCheck className="size-4 text-brand" />
            {t("approvals.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("approvals.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => void changeFilter(tab)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                filter === tab
                  ? "border-brand/40 bg-brand/10 text-brand"
                  : "border-border/80 bg-card text-muted-foreground hover:bg-muted"
              }`}
            >
              {t(`approvals.${tab}`)}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState icon={<Inbox className="size-5" />} title={t("approvals.empty")} compact />
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="rounded-xl border border-border/80 bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{row.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("approvals.requested_by")}: {row.requestedByName} · {t("approvals.expires")}:{" "}
                    {formatDate(row.expiresAt, "—")}
                  </p>
                  {row.decisionNote ? (
                    <p className="mt-2 text-xs text-muted-foreground">{row.decisionNote}</p>
                  ) : null}
                </div>
                <Badge tone={statusTone(row.status)}>{t(`approvals.${row.status}`)}</Badge>
              </div>
              {row.status === "pending" ? (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={notes[row.id] ?? ""}
                    onChange={(event) => setNotes((current) => ({ ...current, [row.id]: event.target.value }))}
                    placeholder={t("approvals.note_placeholder")}
                    className="sm:flex-1"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy === row.id}
                      onClick={() => void decide(row, "approve")}
                    >
                      <CheckCircle2 className="size-4" />
                      {t("approvals.approve")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={busy === row.id}
                      onClick={() => void decide(row, "reject")}
                    >
                      <XCircle className="size-4" />
                      {t("approvals.reject")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ActivityLog({ events }: { events: TelegramOverview["events"] }) {
  const t = useT("telegram");
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-bold">
        <Activity className="size-4 text-brand" />
        {t("events.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("events.subtitle")}</p>
      {events.length === 0 ? (
        <div className="mt-4">
          <EmptyState icon={<Activity className="size-5" />} title={t("events.empty")} compact />
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("events.action")}</TableHead>
                <TableHead>{t("events.target")}</TableHead>
                <TableHead>{t("events.status")}</TableHead>
                <TableHead>{t("events.when")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.slice(0, 25).map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-mono text-xs">{event.action}</TableCell>
                  <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">
                    {event.userName ?? event.targetType ?? "—"}
                    {event.targetId ? ` · ${event.targetId.slice(0, 8)}` : ""}
                  </TableCell>
                  <TableCell>
                    <Badge
                      tone={event.status === "ok" ? "success" : event.status === "denied" ? "warning" : "critical"}
                    >
                      {t(`events.${event.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(event.createdAt, "—")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

function Gated() {
  const t = useT("telegram");
  const auth = useT("auth");
  const common = useT("common");
  const identity = useIdentity();
  const isAdmin = identity?.role === "admin";
  const [overview, setOverview] = useState<TelegramOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setOverview(await getTelegramOverview());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isAdmin) void load();
  }, [identity?.role]);

  if (!isAdmin) {
    return (
      <DashboardChrome currentPath="/telegram">
        <Alert tone="critical">{auth("no_access")}</Alert>
      </DashboardChrome>
    );
  }

  if (loading) {
    return (
      <DashboardChrome currentPath="/telegram">
        <Skeleton className="h-24 w-full" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="mt-4 h-64 w-full" />
      </DashboardChrome>
    );
  }

  if (error || !overview) {
    return (
      <DashboardChrome currentPath="/telegram">
        <Alert tone="critical">
          <span className="flex-1">{error ?? auth("no_access")}</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => void load()}>
            {common("retry")}
          </Button>
        </Alert>
      </DashboardChrome>
    );
  }

  return (
    <DashboardChrome currentPath="/telegram">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Bot className="size-6 text-brand" />
            {t("header.title")}
          </span>
        }
        subtitle={t("header.subtitle")}
        actions={
          <Button type="button" variant="secondary" onClick={() => void load()}>
            <RefreshCw className="size-4" />
            {t("actions.refresh")}
          </Button>
        }
      />

      <Card className="mb-5 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={overview.connected ? "success" : "critical"}>
            {overview.connected ? t("status.connected") : t("status.disconnected")}
          </Badge>
          {overview.botUsername ? <span className="font-mono text-sm">@{overview.botUsername}</span> : null}
          {overview.source ? (
            <span className="text-xs text-muted-foreground">
              {t(overview.source === "dashboard" ? "status.source_dashboard" : "status.source_environment")}
            </span>
          ) : null}
        </div>
        {overview.webhookUrl ? (
          <p className="max-w-full truncate text-xs text-muted-foreground">
            {t("status.webhook")}: <code>{overview.webhookUrl}</code>
          </p>
        ) : null}
      </Card>

      {!overview.connected ? (
        <Alert tone="warning" className="mb-5">
          <div className="flex-1">
            <p className="font-semibold">{t("setup.title")}</p>
            <p className="mt-1 text-sm">{t("setup.body")}</p>
            <p className="mt-1 text-xs">{t("setup.webhook_hint")}</p>
          </div>
          <a href="/settings" className="shrink-0 self-center text-sm font-semibold underline underline-offset-4">
            {t("setup.open_settings")}
          </a>
        </Alert>
      ) : null}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t("stats.linked_users")}
          value={overview.links.filter((link) => !link.revokedAt).length}
          icon={<Users className="size-5" />}
          tone="brand"
        />
        <StatCard
          label={t("stats.pending_approvals")}
          value={overview.approvals.total}
          icon={<ShieldCheck className="size-5" />}
          tone={overview.approvals.total > 0 ? "warning" : "success"}
        />
        <StatCard
          label={t("stats.events")}
          value={overview.events.length}
          icon={<Activity className="size-5" />}
        />
        <StatCard
          label={t("stats.categories")}
          value={7}
          icon={<Bot className="size-5" />}
          hint={`${overview.config.quietHoursStart}:00 → ${overview.config.quietHoursEnd}:00`}
        />
      </div>

      <div className="mb-5 grid gap-5 xl:grid-cols-2">
        <LinkCodePanel overview={overview} onGenerated={() => void load()} />
        <BotConfigForm config={overview.config} onSaved={() => void load()} />
      </div>

      <div className="mb-5">
        <LinkedAccounts overview={overview} reload={() => void load()} />
      </div>

      <div className="grid gap-5">
        <ApprovalInbox initial={overview.approvals} reload={() => void load()} />
        <ActivityLog events={overview.events} />
      </div>
    </DashboardChrome>
  );
}

export default function TelegramPageApp() {
  return (
    <RequireAuth>
      <Gated />
    </RequireAuth>
  );
}
