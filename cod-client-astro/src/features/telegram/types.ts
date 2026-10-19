export type BotLanguage = "ar" | "fr" | "en";
export type DigestMode = "instant" | "hourly" | "daily";
export type BotRole = "admin" | "staff" | "confirmer" | "driver";

export interface BotConfig {
  enabled: boolean;
  defaultLanguage: BotLanguage;
  quietHoursStart: number;
  quietHoursEnd: number;
  digestIntervalMinutes: number;
  weeklyReportEnabled: boolean;
  weeklyReportDay: number;
  weeklyReportHour: number;
  monthlyReportEnabled: boolean;
  monthlyReportHour: number;
  lastWeeklySentOn: string | null;
  lastMonthlySentOn: string | null;
}

export interface TelegramLink {
  telegramUserId: string;
  chatId: string;
  userId: string;
  username: string | null;
  firstName: string | null;
  language: BotLanguage;
  digestMode: DigestMode;
  linkedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  userName: string | null;
  userEmail: string | null;
  userRole: BotRole | null;
}

export interface BotMember {
  id: string;
  name: string;
  email: string;
  role: BotRole;
  status: "active" | "inactive";
}

export interface ApprovalRequest {
  id: string;
  action: string;
  title: string;
  payload: string;
  status: "pending" | "approved" | "rejected" | "expired" | "failed";
  requestedBy: string;
  requestedByName: string;
  decidedByTelegramId: string | null;
  decisionNote: string | null;
  telegramMessageId: string | null;
  reminderSentAt: string | null;
  escalatedAt: string | null;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BotEvent {
  id: string;
  telegramUserId: string | null;
  userId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  status: "ok" | "denied" | "failed";
  detail: string | null;
  createdAt: string;
  userName: string | null;
}

export interface TelegramOverview {
  connected: boolean;
  source: "dashboard" | "environment" | null;
  chatId: string | null;
  botUsername: string | null;
  webhookUrl: string | null;
  deepLinkBase: string | null;
  config: BotConfig;
  links: TelegramLink[];
  events: BotEvent[];
  approvals: { rows: ApprovalRequest[]; total: number };
  members: BotMember[];
}

export interface LinkCodeResult {
  code: string;
  expiresAt: string;
  userId: string;
  userName: string;
  command: string;
  deepLink: string | null;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "failed" | "all";
