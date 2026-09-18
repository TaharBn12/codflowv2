import { apiFetch } from "@/lib/api";

export type OperationsSummary = {
  openTasks: number;
  completedTasks: number;
  unassignedOrders: number;
  earnedCommission: number;
  paidCommission: number;
};

export type OperationTask = {
  id: string;
  title: string;
  description: string | null;
  type:
    | "confirmation"
    | "callback"
    | "address_review"
    | "shipment_follow_up"
    | "follow_up";
  status: "open" | "in_progress" | "completed" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  orderId: string | null;
  assigneeId: string;
  assigneeName: string | null;
  dueAt: string | null;
  createdAt: string;
};

export type AgentPerformance = {
  id: string;
  name: string;
  autoAssignEnabled: number;
  maxOpenOrders: number;
  openOrders: number;
  deliveredOrders: number;
  failedOrders: number;
  earnedCommission: number;
  paidCommission: number;
};

type Envelope<T> = { success: true; data: T };

export async function getOperationsSummary() {
  return (
    await apiFetch<Envelope<OperationsSummary>>("/api/operations/summary")
  ).data;
}

export async function listOperationTasks() {
  return (await apiFetch<Envelope<OperationTask[]>>("/api/operations/tasks"))
    .data;
}

export async function updateOperationTask(
  id: string,
  status: OperationTask["status"],
) {
  return apiFetch(`/api/operations/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

export async function getAgentPerformance() {
  return (
    await apiFetch<Envelope<AgentPerformance[]>>("/api/operations/performance")
  ).data;
}
