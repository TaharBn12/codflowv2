import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  History,
  PackageCheck,
  PackageOpen,
  RotateCcw,
  Save,
  UserRoundCheck,
} from "lucide-react";
import { DashboardChrome } from "@/components/layout/chrome";
import {
  Alert,
  Badge,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  StatCard,
} from "@/components/ui";
import {
  RequireAuth,
  useIdentity,
} from "@/features/auth/components/RequireAuth";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import {
  getOperationAgentOverview,
  saveOperationAgentSettings,
  type AgentOverview,
} from "../api";

const money = new Intl.NumberFormat("fr-DZ", { maximumFractionDigits: 2 });

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${checked ? "bg-primary" : "bg-muted-foreground/30"}`}
    >
      <span
        className={`pointer-events-none block size-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0.5"}`}
      />
    </button>
  );
}

function Gated({ agentId }: { agentId: string }) {
  const t = useT("operations");
  const auth = useT("auth");
  const identity = useIdentity();
  const [agent, setAgent] = useState<AgentOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setError(null);
      setAgent(await getOperationAgentOverview(agentId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  useEffect(() => {
    if (identity?.role === "admin") void load();
  }, [identity?.role, agentId]);

  async function save() {
    if (!agent) return;
    setSaving(true);
    try {
      await saveOperationAgentSettings(agent);
      notify.success(t("agent_settings_saved"));
      await load();
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (identity?.role !== "admin")
    return (
      <DashboardChrome currentPath="/operations">
        <Alert tone="critical">{auth("no_access")}</Alert>
      </DashboardChrome>
    );
  if (error)
    return (
      <DashboardChrome currentPath="/operations">
        <Alert tone="critical">{error}</Alert>
      </DashboardChrome>
    );
  if (!agent)
    return (
      <DashboardChrome currentPath="/operations">
        <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
          {t("loading_agent")}
        </div>
      </DashboardChrome>
    );

  const closed = Number(agent.deliveredOrders) + Number(agent.failedOrders);
  const rate = closed
    ? Math.round((Number(agent.deliveredOrders) / closed) * 100)
    : 0;
  const update = <K extends keyof AgentOverview>(
    key: K,
    value: AgentOverview[K],
  ) =>
    setAgent((current) => (current ? { ...current, [key]: value } : current));

  return (
    <DashboardChrome currentPath="/operations">
      <PageHeader
        title={agent.name}
        subtitle={agent.email}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`/team/${agent.id}`}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <History size={16} />
              {t("view_agent_activity")}
            </a>
            <a
              href="/operations"
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-semibold hover:bg-muted"
            >
              <ArrowRight size={16} />
              {t("back_to_operations")}
            </a>
          </div>
        }
      />
      <div className="mb-4 flex items-center gap-2">
        <Badge tone={agent.status === "active" ? "success" : "neutral"}>
          {t(agent.status === "active" ? "active_agent" : "inactive_agent")}
        </Badge>
        <Badge tone={Boolean(agent.autoAssignEnabled) ? "brand" : "warning"}>
          {t(
            Boolean(agent.autoAssignEnabled)
              ? "distribution_active"
              : "distribution_paused",
          )}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("total_assigned_orders")}
          value={agent.totalOrders}
          icon={<ClipboardCheck size={19} />}
          tone="brand"
        />
        <StatCard
          label={t("assigned_today")}
          value={`${agent.assignedToday} / ${agent.maxDailyOrders}`}
          icon={<UserRoundCheck size={19} />}
          tone="warning"
        />
        <StatCard
          label={t("delivered")}
          value={agent.deliveredOrders}
          icon={<PackageCheck size={19} />}
          tone="success"
        />
        <StatCard
          label={t("success_rate")}
          value={`${rate}%`}
          icon={<CheckCircle2 size={19} />}
          tone={rate >= 70 ? "success" : rate >= 40 ? "warning" : "critical"}
        />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("open")}
          value={agent.openOrders}
          icon={<PackageOpen size={19} />}
        />
        <StatCard
          label={t("failed_orders")}
          value={agent.failedOrders}
          icon={<RotateCcw size={19} />}
          tone="critical"
        />
        <StatCard
          label={t("confirmation_commission")}
          value={`${money.format(agent.confirmationCommission)} DA`}
          icon={<CircleDollarSign size={19} />}
          tone="brand"
        />
        <StatCard
          label={t("follow_up_commission")}
          value={`${money.format(agent.followUpCommission)} DA`}
          icon={<CircleDollarSign size={19} />}
          tone="brand"
        />
      </div>

      <Card className="mt-5 overflow-hidden p-0">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-bold">{t("agent_distribution_settings")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("agent_distribution_settings_hint")}
          </p>
        </div>
        <div className="space-y-6 p-5">
          <div className="flex items-center justify-between gap-5 rounded-xl border border-border bg-muted/25 p-4">
            <div>
              <p className="text-sm font-semibold">{t("auto_assign")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("agent_auto_assign_hint")}
              </p>
            </div>
            <Switch
              checked={Boolean(agent.autoAssignEnabled)}
              onChange={(value) => update("autoAssignEnabled", value)}
              label={t("auto_assign")}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label={t("max_daily_orders")}
              hint={t("max_daily_orders_hint")}
            >
              <Input
                type="number"
                min="1"
                max="1000"
                value={agent.maxDailyOrders}
                onChange={(event) =>
                  update("maxDailyOrders", Number(event.currentTarget.value))
                }
              />
            </Field>
            <Field label={t("max_open")} hint={t("max_open_hint")}>
              <Input
                type="number"
                min="1"
                max="500"
                value={agent.maxOpenOrders}
                onChange={(event) =>
                  update("maxOpenOrders", Number(event.currentTarget.value))
                }
              />
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label={t("confirmation_cost")}
              hint={t("confirmation_cost_hint")}
            >
              <div className="flex">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={agent.confirmationCommissionValue}
                  onChange={(event) =>
                    update(
                      "confirmationCommissionValue",
                      Number(event.currentTarget.value),
                    )
                  }
                  className="rounded-e-none"
                />
                <Select
                  value={agent.confirmationCommissionType}
                  onChange={(event) =>
                    update(
                      "confirmationCommissionType",
                      event.currentTarget
                        .value as AgentOverview["confirmationCommissionType"],
                    )
                  }
                  className="h-10 w-24 rounded-s-none border-s-0"
                >
                  <option value="fixed">DA</option>
                  <option value="percentage">%</option>
                </Select>
              </div>
            </Field>
            <Field label={t("follow_up_cost")} hint={t("follow_up_cost_hint")}>
              <div className="flex">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={agent.commissionValue}
                  onChange={(event) =>
                    update("commissionValue", Number(event.currentTarget.value))
                  }
                  className="rounded-e-none"
                />
                <Select
                  value={agent.commissionType}
                  onChange={(event) =>
                    update(
                      "commissionType",
                      event.currentTarget
                        .value as AgentOverview["commissionType"],
                    )
                  }
                  className="h-10 w-24 rounded-s-none border-s-0"
                >
                  <option value="fixed">DA</option>
                  <option value="percentage">%</option>
                </Select>
              </div>
            </Field>
          </div>
        </div>
        <div className="flex justify-end border-t border-border bg-muted/20 px-5 py-4">
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            <Save size={16} />
            {saving ? t("saving") : t("save_changes")}
          </button>
        </div>
      </Card>
    </DashboardChrome>
  );
}

export default function OperationAgentDetailPageApp({
  agentId,
}: {
  agentId: string;
}) {
  return (
    <RequireAuth>
      <Gated agentId={agentId} />
    </RequireAuth>
  );
}
