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
  confirmationCommission: number;
  followUpCommission: number;
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

export type OperationAgent = {
  id: string;
  name: string;
  email: string;
  status: "active" | "inactive";
  autoAssignEnabled: boolean | number;
  maxOpenOrders: number;
  commissionType: "fixed" | "percentage";
  commissionValue: number;
  confirmationCommissionType: "fixed" | "percentage";
  confirmationCommissionValue: number;
};

export async function listOperationAgents() {
  return (await apiFetch<Envelope<OperationAgent[]>>("/api/operations/agents"))
    .data;
}

export async function saveOperationAgentSettings(agent: OperationAgent) {
  return apiFetch(
    `/api/operations/agents/${encodeURIComponent(agent.id)}/settings`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        autoAssignEnabled: Boolean(agent.autoAssignEnabled),
        maxOpenOrders: Number(agent.maxOpenOrders),
        commissionType: agent.commissionType,
        commissionValue: Number(agent.commissionValue),
        confirmationCommissionType: agent.confirmationCommissionType,
        confirmationCommissionValue: Number(agent.confirmationCommissionValue),
      }),
    },
  );
}

export async function bulkAssignConfirmationOrders(
  orderIds: string[],
  assigneeId: string,
) {
  return apiFetch<{ success: true; data: { assigned: number } }>(
    "/api/operations/orders/bulk-assign",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderIds, assigneeId }),
    },
  );
}

export type StaffCommission = {
  id: string;
  orderId: string;
  orderNumber: string;
  userId: string;
  userName: string;
  amount: number;
  category: "confirmation" | "follow_up";
  status: "pending" | "earned" | "paid" | "reversed";
  earnedAt: string;
  paidAt: string | null;
};

export async function listStaffCommissions() {
  return (
    await apiFetch<Envelope<StaffCommission[]>>("/api/operations/commissions")
  ).data;
}

export async function markStaffCommissionsPaid(ids: string[]) {
  return apiFetch<{
    success: true;
    data: { paid?: number; approvalId?: string; status?: "pending" };
    message?: string;
  }>("/api/operations/commissions/mark-paid", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

export async function autoAssignNewOrders(orderIds?: string[]) {
  return apiFetch<{
    success: true;
    data: { assigned: number; remaining: number };
  }>("/api/operations/orders/auto-assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(orderIds?.length ? { orderIds } : {}),
  });
}

export async function getCommissionReport(period: "daily" | "monthly") {
  return (await apiFetch<Envelope<Array<{ period: string; userId: string; userName: string; category: "confirmation" | "follow_up"; status: StaffCommission["status"]; amount: number; count: number }>>>(`/api/operations/commissions/report?period=${period}`)).data;
}
