import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  PackageSearch,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import { DashboardChrome } from "@/components/layout/chrome";
import { Alert, Card, EmptyState, PageHeader } from "@/components/ui";
import {
  RequireAuth,
  useIdentity,
} from "@/features/auth/components/RequireAuth";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import {
  getAgentPerformance,
  getOperationsSummary,
  listOperationTasks,
  updateOperationTask,
  type AgentPerformance,
  type OperationsSummary,
  type OperationTask,
} from "../api";

const money = new Intl.NumberFormat("fr-DZ", { maximumFractionDigits: 2 });

function Gated() {
  const t = useT("operations");
  const identity = useIdentity();
  const isAdmin = identity?.role === "admin";
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [tasks, setTasks] = useState<OperationTask[]>([]);
  const [performance, setPerformance] = useState<AgentPerformance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextSummary, nextTasks, nextPerformance] = await Promise.all([
        getOperationsSummary(),
        listOperationTasks(),
        isAdmin ? getAgentPerformance() : Promise.resolve([]),
      ]);
      setSummary(nextSummary);
      setTasks(nextTasks);
      setPerformance(nextPerformance);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [identity?.role, isAdmin]);

  async function changeTask(
    task: OperationTask,
    status: OperationTask["status"],
  ) {
    try {
      await updateOperationTask(task.id, status);
      notify.success(t("task_updated"));
      await load();
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const cards = summary
    ? [
        {
          label: t("open_tasks"),
          value: summary.openTasks,
          icon: Clock3,
          tone: "text-amber-600",
        },
        {
          label: t("completed_tasks"),
          value: summary.completedTasks,
          icon: CheckCircle2,
          tone: "text-emerald-600",
        },
        {
          label: t("unassigned_orders"),
          value: summary.unassignedOrders,
          icon: PackageSearch,
          tone: "text-rose-600",
        },
        {
          label: t("earned_commission"),
          value: `${money.format(summary.earnedCommission)} DA`,
          icon: CircleDollarSign,
          tone: "text-primary",
        },
      ]
    : [];

  return (
    <DashboardChrome currentPath="/operations">
      <PageHeader
        title={t("title")}
        subtitle={t("description")}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-semibold hover:bg-muted"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />{" "}
            {t("refresh")}
          </button>
        }
      />

      {error && <Alert tone="critical">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, icon: Icon, tone }) => (
          <Card key={label} className="p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">{label}</p>
              <Icon size={20} className={tone} />
            </div>
            <p className="mt-3 text-2xl font-bold tabular-nums">{value}</p>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="overflow-hidden">
          <div className="border-b border-border p-5">
            <h2 className="font-semibold">{t("tasks")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("tasks_hint")}
            </p>
          </div>
          {tasks.length === 0 && !loading ? (
            <div className="p-6">
              <EmptyState
                icon={<CheckCircle2 size={22} />}
                title={t("no_tasks")}
              />
            </div>
          ) : (
            <div className="divide-y divide-border">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${task.priority === "urgent" ? "bg-rose-500" : task.priority === "high" ? "bg-amber-500" : "bg-primary"}`}
                      />
                      <p className="truncate font-medium">{task.title}</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {task.assigneeName ?? "—"}
                      {task.dueAt
                        ? ` · ${new Date(task.dueAt).toLocaleString()}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {task.status === "open" && (
                      <button
                        onClick={() => void changeTask(task, "in_progress")}
                        className="rounded-md border px-3 py-1.5 text-xs font-semibold hover:bg-muted"
                      >
                        {t("start")}
                      </button>
                    )}
                    {task.status !== "completed" &&
                      task.status !== "cancelled" && (
                        <button
                          onClick={() => void changeTask(task, "completed")}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                        >
                          {t("complete")}
                        </button>
                      )}
                    {task.status === "completed" && (
                      <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-600">
                        {t("completed")}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-border p-5">
            <div className="flex items-center gap-2">
              <UsersRound size={18} />
              <h2 className="font-semibold">{t("team_performance")}</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("least_loaded_active")}
            </p>
          </div>
          {!isAdmin ? (
            <p className="p-5 text-sm text-muted-foreground">
              {t("admin_only")}
            </p>
          ) : performance.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">
              {t("no_agents")}
            </p>
          ) : (
            <div className="divide-y divide-border">
              {performance.map((agent) => {
                const total =
                  Number(agent.deliveredOrders) + Number(agent.failedOrders);
                const deliveryRate = total
                  ? Math.round((Number(agent.deliveredOrders) / total) * 100)
                  : 0;
                return (
                  <div key={agent.id} className="p-4">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{agent.name}</p>
                      <span className="text-xs font-semibold text-emerald-600">
                        {deliveryRate}%
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                      <div className="rounded-lg bg-muted p-2">
                        <b className="block text-base">{agent.openOrders}</b>
                        {t("open")}
                      </div>
                      <div className="rounded-lg bg-muted p-2">
                        <b className="block text-base">
                          {agent.deliveredOrders}
                        </b>
                        {t("delivered")}
                      </div>
                      <div className="rounded-lg bg-muted p-2">
                        <b className="block text-base">
                          {money.format(Number(agent.earnedCommission))}
                        </b>
                        {t("commission")}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
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
