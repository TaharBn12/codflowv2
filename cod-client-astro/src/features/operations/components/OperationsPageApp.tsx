import { useEffect, useState } from "react";
import {
  ArrowUpLeft,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  PackageSearch,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import { DashboardChrome } from "@/components/layout/chrome";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import {
  RequireAuth,
  canScope,
  useIdentity,
} from "@/features/auth/components/RequireAuth";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import {
  getAgentPerformance,
  listStaffCommissions,
  markStaffCommissionsPaid,
  getOperationsSummary,
  listOperationTasks,
  type AgentPerformance,
  type StaffCommission,
  type OperationsSummary,
  type OperationTask,
} from "../api";

const money = new Intl.NumberFormat("fr-DZ", { maximumFractionDigits: 2 });

function Gated() {
  const t = useT("operations");
  const auth = useT("auth");
  const identity = useIdentity();
  const isAdmin = identity?.role === "admin";
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [tasks, setTasks] = useState<OperationTask[]>([]);
  const [performance, setPerformance] = useState<AgentPerformance[]>([]);
  const [commissions, setCommissions] = useState<StaffCommission[]>([]);
  const [paying, setPaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextSummary, nextTasks, nextPerformance, nextCommissions] =
        await Promise.all([
          getOperationsSummary(),
          listOperationTasks(),
          isAdmin ? getAgentPerformance() : Promise.resolve([]),
          listStaffCommissions(),
        ]);
      setSummary(nextSummary);
      setTasks(nextTasks);
      setPerformance(nextPerformance);
      setCommissions(nextCommissions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canScope(identity, "operations:view")) void load();
  }, [identity?.role, identity?.scopes.join(",")]);

  async function payEarnedCommissions() {
    const ids = commissions
      .filter((row) => row.status === "earned")
      .map((row) => row.id);
    if (!ids.length) return;
    setPaying(true);
    try {
      const result = await markStaffCommissionsPaid(ids);
      notify.success(
        result.data.status === "pending"
          ? t("approval_sent")
          : t("commissions_paid"),
      );
      await load();
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPaying(false);
    }
  }

  if (!canScope(identity, "operations:view")) {
    return (
      <DashboardChrome currentPath="/operations">
        <Alert tone="critical">{auth("no_access")}</Alert>
      </DashboardChrome>
    );
  }

  const earned = commissions.filter((row) => row.status === "earned");
  return (
    <DashboardChrome currentPath="/operations">
      <PageHeader
        title={t("title")}
        subtitle={t("description")}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-semibold transition-colors hover:bg-muted"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            {t("refresh")}
          </button>
        }
      />
      {error && <Alert tone="critical">{error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("open_tasks")}
          value={summary?.openTasks ?? "—"}
          icon={<Clock3 size={19} />}
          tone="warning"
        />
        <StatCard
          label={t("completed_tasks")}
          value={summary?.completedTasks ?? "—"}
          icon={<CheckCircle2 size={19} />}
          tone="success"
        />
        <StatCard
          label={t("unassigned_orders")}
          value={summary?.unassignedOrders ?? "—"}
          icon={<PackageSearch size={19} />}
          tone="critical"
        />
        <StatCard
          label={t("earned_commission")}
          value={summary ? `${money.format(summary.earnedCommission)} DA` : "—"}
          icon={<CircleDollarSign size={19} />}
          tone="brand"
        />
      </div>

      <Card flush className="mt-5 overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="font-bold">{t("tasks")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("tasks_hint_readonly")}
            </p>
          </div>
          <Badge tone="neutral">{tasks.length}</Badge>
        </div>
        {tasks.length === 0 && !loading ? (
          <div className="p-8">
            <EmptyState
              icon={<CheckCircle2 size={22} />}
              title={t("no_tasks")}
            />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {tasks.map((task) => (
              <a
                key={task.id}
                href={task.orderId ? `/orders/${task.orderId}` : undefined}
                className="grid gap-3 px-5 py-4 transition-colors hover:bg-muted/40 sm:grid-cols-[1fr_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 rounded-full ${task.priority === "urgent" ? "bg-rose-500" : task.priority === "high" ? "bg-amber-500" : "bg-primary"}`}
                    />
                    <p className="truncate text-sm font-semibold">
                      {task.title}
                    </p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {task.assigneeName ?? "—"}
                    {task.dueAt
                      ? ` · ${new Date(task.dueAt).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {t("order_status")}
                  </span>
                  <Badge
                    tone={
                      task.orderStatus === "delivered"
                        ? "success"
                        : task.orderStatus === "cancelled" ||
                            task.orderStatus === "returned"
                          ? "critical"
                          : "neutral"
                    }
                  >
                    {task.orderStatus
                      ? t(`order_statuses.${task.orderStatus}`)
                      : "—"}
                  </Badge>
                </div>
              </a>
            ))}
          </div>
        )}
      </Card>

      {isAdmin && (
        <Card flush className="mt-5 overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <UsersRound size={18} className="text-primary" />
              <h2 className="font-bold">{t("team_performance")}</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("agents_click_hint")}
            </p>
          </div>
          {performance.length === 0 ? (
            <div className="p-8">
              <EmptyState
                icon={<UsersRound size={22} />}
                title={t("no_agents")}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[820px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("agent")}</TableHead>
                    <TableHead>{t("assigned_today")}</TableHead>
                    <TableHead>{t("open")}</TableHead>
                    <TableHead>{t("delivered")}</TableHead>
                    <TableHead>{t("success_rate")}</TableHead>
                    <TableHead>{t("commissions")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {performance.map((agent) => {
                    const closed =
                      Number(agent.deliveredOrders) +
                      Number(agent.failedOrders);
                    const rate = closed
                      ? Math.round(
                          (Number(agent.deliveredOrders) / closed) * 100,
                        )
                      : 0;
                    return (
                      <TableRow key={agent.id} className="hover:bg-muted/40">
                        <TableCell>
                          <a
                            href={`/operations/agents/${agent.id}`}
                            className="font-semibold text-link hover:underline"
                          >
                            {agent.name}
                          </a>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {Boolean(agent.autoAssignEnabled)
                              ? t("available_for_distribution")
                              : t("distribution_paused")}
                          </p>
                        </TableCell>
                        <TableCell>
                          <b className="tabular-nums">{agent.assignedToday}</b>
                          <span className="text-xs text-muted-foreground">
                            {" "}
                            / {agent.maxDailyOrders}
                          </span>
                        </TableCell>
                        <TableCell>{agent.openOrders}</TableCell>
                        <TableCell>{agent.deliveredOrders}</TableCell>
                        <TableCell>
                          <Badge
                            tone={
                              rate >= 70
                                ? "success"
                                : rate >= 40
                                  ? "warning"
                                  : "critical"
                            }
                          >
                            {rate}%
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {money.format(
                            Number(agent.confirmationCommission) +
                              Number(agent.followUpCommission),
                          )}{" "}
                          DA
                        </TableCell>
                        <TableCell>
                          <a
                            href={`/operations/agents/${agent.id}`}
                            aria-label={t("view_agent")}
                            className="inline-grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <ArrowUpLeft
                              size={16}
                              className="rtl:rotate-0 ltr:rotate-90"
                            />
                          </a>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      {isAdmin && earned.length > 0 && (
        <Card className="mt-5 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-bold">{t("commission_payout")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {earned.length} {t("earned_entries")} ·{" "}
              {money.format(
                earned.reduce((sum, row) => sum + Number(row.amount), 0),
              )}{" "}
              DA
            </p>
          </div>
          <button
            type="button"
            disabled={paying}
            onClick={() => void payEarnedCommissions()}
            className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {paying ? t("saving") : t("mark_all_paid")}
          </button>
        </Card>
      )}
    </DashboardChrome>
  );
}

export default function OperationsPageApp() {
  return (
    <RequireAuth>
      <Gated />
    </RequireAuth>
  );
}
