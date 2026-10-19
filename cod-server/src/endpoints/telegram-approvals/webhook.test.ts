/**
 * Webhook perimeter tests: only Telegram (holding the secret token) may reach
 * the dispatcher, and malformed bodies never crash the worker.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const seam = vi.hoisted(() => ({
  config: { botToken: "token", chatId: "1", webhookSecret: "secret-123", source: "dashboard" as const } as any,
  handled: vi.fn(async () => ({ handled: true })),
}));

vi.mock("./service", () => ({
  resolveTelegramConfig: vi.fn(async () => seam.config),
}));

vi.mock("@/endpoints/telegram-bot/bot", () => ({
  handleTelegramUpdate: seam.handled,
}));

import routes from "./routes";

const app = new Hono();
app.route("/webhooks/telegram", routes);

const env = { DB: {}, WORKER_SELF_URL: "https://api.example.com" } as any;

function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    "/webhooks/telegram",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}

describe("Telegram webhook", () => {
  beforeEach(() => {
    seam.handled.mockClear();
  });

  it("rejects requests without the secret header", async () => {
    const response = await post({ update_id: 1, message: {} });
    expect(response.status).toBe(403);
    expect(seam.handled).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret header", async () => {
    const response = await post({ update_id: 1 }, { "X-Telegram-Bot-Api-Secret-Token": "guess" });
    expect(response.status).toBe(403);
    expect(seam.handled).not.toHaveBeenCalled();
  });

  it("dispatches an authentic update", async () => {
    const response = await post(
      { update_id: 7, message: { message_id: 1, chat: { id: 5, type: "private" }, from: { id: 5 }, text: "/menu" } },
      { "X-Telegram-Bot-Api-Secret-Token": "secret-123" },
    );
    expect(response.status).toBe(200);
    expect(seam.handled).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ ok: true, handled: true });
  });

  it("returns 400 for a body that is not JSON", async () => {
    const response = await post("not-json", { "X-Telegram-Bot-Api-Secret-Token": "secret-123" });
    expect(response.status).toBe(400);
    expect(seam.handled).not.toHaveBeenCalled();
  });

  it("still answers 200 when the dispatcher reports a handled failure", async () => {
    seam.handled.mockResolvedValueOnce({ handled: false, reason: "error" } as never);
    const response = await post({ update_id: 8 }, { "X-Telegram-Bot-Api-Secret-Token": "secret-123" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, handled: false });
  });
});
