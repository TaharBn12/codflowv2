/**
 * Telegram webhook receiver.
 *
 * Authenticity: Telegram echoes the secret set at `setWebhook` in the
 * `X-Telegram-Bot-Api-Secret-Token` header; anything else is rejected with 403.
 * Delivery is at-least-once, so the dispatcher dedupes by `update_id`.
 */

import { Hono } from "hono";
import type { AppContext } from "@/types";
import { resolveTelegramConfig } from "./service";
import { handleTelegramUpdate, type TelegramUpdate } from "@/endpoints/telegram-bot/bot";

const routes = new Hono<AppContext>();

routes.post("/", async (c) => {
  const config = await resolveTelegramConfig(c.env);
  if (!config) return c.json({ ok: false, error: "not_configured" }, 403);
  if (c.req.header("X-Telegram-Bot-Api-Secret-Token") !== config.webhookSecret) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  let update: TelegramUpdate;
  try {
    update = (await c.req.json()) as TelegramUpdate;
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const result = await handleTelegramUpdate({
    env: c.env,
    waitUntil: (promise) => {
      try {
        c.executionCtx.waitUntil(promise);
      } catch {
        void promise;
      }
    },
  }, update);

  // Always 200 for accepted updates: Telegram retries non-2xx responses, which
  // would duplicate user-visible messages.
  return c.json({ ok: true, handled: result.handled });
});

/** Health probe for the dashboard (“is the webhook reachable?”). */
routes.get("/", (c) => c.json({ ok: true, service: "telegram-bot" }));

export default routes;
