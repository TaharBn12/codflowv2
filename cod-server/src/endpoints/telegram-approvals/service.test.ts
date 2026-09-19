import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ row: undefined as any }));
vi.mock("@/db", () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: async () => seam.row }) }) }) }),
}));
import { resolveTelegramConfig } from "./service";

const environment = {
  DB: {}, TELEGRAM_BOT_TOKEN: "env-token", TELEGRAM_APPROVAL_CHAT_ID: "env-chat", TELEGRAM_WEBHOOK_SECRET: "env-secret",
} as any;

describe("Telegram approval configuration", () => {
  beforeEach(() => { seam.row = undefined; });
  it("falls back to Worker secrets before dashboard settings exist", async () => {
    await expect(resolveTelegramConfig(environment)).resolves.toMatchObject({ source: "environment", botToken: "env-token" });
  });
  it("uses dashboard secrets without exposing environment values", async () => {
    seam.row = { enabled: true, botToken: "db-token", chatId: "db-chat", webhookSecret: "db-secret" };
    await expect(resolveTelegramConfig(environment)).resolves.toEqual({ source: "dashboard", botToken: "db-token", chatId: "db-chat", webhookSecret: "db-secret" });
  });
  it("honors a dashboard disable even when fallback secrets exist", async () => {
    seam.row = { enabled: false, botToken: "db-token", chatId: "db-chat", webhookSecret: "db-secret" };
    await expect(resolveTelegramConfig(environment)).resolves.toBeNull();
  });
});
