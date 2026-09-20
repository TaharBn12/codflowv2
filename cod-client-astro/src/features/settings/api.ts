import { apiFetch } from "@/lib/api";
import type {
  ApprovalPoliciesOverview,
  EmailConfig,
  EmailConnectionCheck,
  OtpConfig,
  OtpConnectionCheck,
  PixelConfig,
  SaveEmailConfigData,
  SaveOtpConfigData,
  SavePixelConfigData,
  SaveTurnstileConfigData,
  StoreConfig,
  TurnstileConfig,
  TelegramConfig,
  SaveTelegramConfigData,
  UpdateStoreData,
} from "./types";

interface DataEnvelope<T> {
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

export async function getMyStore() {
  return (await apiFetch<DataEnvelope<StoreConfig>>("/api/stores/me")).data;
}

export async function updateMyStore(data: UpdateStoreData) {
  return (await apiFetch<DataEnvelope<StoreConfig>>("/api/stores/me", json({ method: "PATCH", body: JSON.stringify(data) }))).data;
}

export async function getPixelConfig() {
  return (await apiFetch<DataEnvelope<PixelConfig | null>>("/api/stores/pixel-config")).data;
}

export async function savePixelConfig(data: SavePixelConfigData) {
  return (await apiFetch<DataEnvelope<PixelConfig>>("/api/stores/pixel-config", json({ method: "POST", body: JSON.stringify(data) }))).data;
}

export async function getOtpConfig() {
  return (await apiFetch<DataEnvelope<OtpConfig | null>>("/api/stores/otp-config")).data;
}

export async function saveOtpConfig(data: SaveOtpConfigData) {
  return (await apiFetch<DataEnvelope<OtpConfig>>("/api/stores/otp-config", json({ method: "POST", body: JSON.stringify(data) }))).data;
}

export async function testOtpConnection(apiKey?: string) {
  return (await apiFetch<DataEnvelope<OtpConnectionCheck>>("/api/stores/otp-config/test", json({ method: "POST", body: JSON.stringify(apiKey ? { apiKey } : {}) }))).data;
}

export async function getTurnstileConfig() {
  return (await apiFetch<DataEnvelope<TurnstileConfig | null>>("/api/stores/turnstile-config")).data;
}

export async function saveTurnstileConfig(data: SaveTurnstileConfigData) {
  return (await apiFetch<DataEnvelope<TurnstileConfig>>("/api/stores/turnstile-config", json({ method: "POST", body: JSON.stringify(data) }))).data;
}

export async function getEmailConfig() {
  return (await apiFetch<DataEnvelope<EmailConfig | null>>("/api/stores/email-config")).data;
}

export async function saveEmailConfig(data: SaveEmailConfigData) {
  return (await apiFetch<DataEnvelope<EmailConfig>>("/api/stores/email-config", json({ method: "POST", body: JSON.stringify(data) }))).data;
}

export async function testEmailConnection(apiKey?: string) {
  return (await apiFetch<DataEnvelope<EmailConnectionCheck>>("/api/stores/email-config/test", json({ method: "POST", body: JSON.stringify(apiKey ? { apiKey } : {}) }))).data;
}

export async function getTelegramConfig() {
  return (await apiFetch<DataEnvelope<TelegramConfig>>("/api/operations/telegram/config")).data;
}

export async function saveTelegramConfig(data: SaveTelegramConfigData) {
  return (await apiFetch<DataEnvelope<TelegramConfig>>("/api/operations/telegram/config", json({ method: "PUT", body: JSON.stringify(data) }))).data;
}

export async function getApprovalPolicies() {
  return (await apiFetch<DataEnvelope<ApprovalPoliciesOverview>>("/api/operations/telegram/approval-policies")).data;
}

export async function saveApprovalPolicy(userId: string, action: string, enabled: boolean) {
  return apiFetch(`/api/operations/telegram/approval-policies/${encodeURIComponent(userId)}/${encodeURIComponent(action)}`, json({ method: "PUT", body: JSON.stringify({ enabled }) }));
}

export async function saveAllApprovalPolicies(userId: string, enabled: boolean) {
  return apiFetch(`/api/operations/telegram/approval-policies/${encodeURIComponent(userId)}`, json({ method: "PUT", body: JSON.stringify({ enabled }) }));
}
