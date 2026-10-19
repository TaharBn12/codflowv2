import { apiFetch } from "@/lib/api";
import type { ApprovalRequest, ApprovalStatus, BotConfig, LinkCodeResult, TelegramOverview } from "./types";

interface Envelope<T> {
  success: boolean;
  data: T;
  message?: string;
}

function json(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  };
}

export async function getTelegramOverview() {
  return (await apiFetch<Envelope<TelegramOverview>>("/api/operations/telegram/bot/overview")).data;
}

export async function saveBotConfig(patch: Partial<BotConfig>) {
  return (await apiFetch<Envelope<BotConfig>>("/api/operations/telegram/bot/config", json({ method: "PUT", body: JSON.stringify(patch) }))).data;
}

export async function createBotLinkCode(userId: string, ttlMinutes = 60) {
  return (
    await apiFetch<Envelope<LinkCodeResult>>(
      "/api/operations/telegram/bot/link-codes",
      json({ method: "POST", body: JSON.stringify({ userId, ttlMinutes }) }),
    )
  ).data;
}

export async function revokeBotLink(telegramUserId: string) {
  return apiFetch<Envelope<{ telegramUserId: string; revoked: boolean }>>(
    `/api/operations/telegram/bot/links/${encodeURIComponent(telegramUserId)}`,
    { method: "DELETE" },
  );
}

export async function sendBotTest(telegramUserId: string) {
  return apiFetch<Envelope<{ sent: boolean }>>(
    "/api/operations/telegram/bot/test",
    json({ method: "POST", body: JSON.stringify({ telegramUserId }) }),
  );
}

export async function listApprovalRequests(status: ApprovalStatus, limit = 20) {
  return (
    await apiFetch<Envelope<{ rows: ApprovalRequest[]; total: number }>>(
      `/api/operations/approvals?status=${status}&limit=${limit}`,
    )
  ).data;
}

export async function decideApprovalRequest(id: string, decision: "approve" | "reject", note?: string) {
  return apiFetch<Envelope<unknown>>(
    `/api/operations/approvals/${encodeURIComponent(id)}/decision`,
    json({ method: "POST", body: JSON.stringify({ decision, note: note?.trim() || undefined }) }),
  );
}
