import { BarChart2, Bot, CalendarClock, Key, ListChecks, Mail, Palette, Search, ShieldCheck, Star, Store, type LucideIcon } from "lucide-react";

export type CategoryId = "general" | "branding" | "seo" | "reviews" | "analytics" | "verification" | "email" | "api" | "telegram" | "approvals" | "reports";

export interface SettingsCategory {
  id: CategoryId;
  icon: LucideIcon;
  /** Dot-path into the settings `store` namespace. */
  labelKey: string;
}

/** The settings categories, in sidebar order. */
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: "general", icon: Store, labelKey: "general_title" },
  { id: "branding", icon: Palette, labelKey: "branding_title" },
  { id: "seo", icon: Search, labelKey: "seo_title" },
  { id: "reviews", icon: Star, labelKey: "reviews_title" },
  { id: "analytics", icon: BarChart2, labelKey: "tracking_title" },
  { id: "verification", icon: ShieldCheck, labelKey: "otp_title" },
  { id: "email", icon: Mail, labelKey: "email_title" },
  { id: "api", icon: Key, labelKey: "api_key_title" },
  { id: "telegram", icon: Bot, labelKey: "telegram_title" },
  { id: "approvals", icon: ListChecks, labelKey: "approval_policies_title" },
  { id: "reports", icon: CalendarClock, labelKey: "reports_title" },
];

export function settingsErrorMessage(_cause: unknown, t: (key: string) => string) {
  return t("store.save_error");
}
