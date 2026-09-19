import { Hono } from "hono";
import type { AppContext } from "@/types";
import {
  answerTelegramCallback,
  decideApproval,
  resolveTelegramConfig,
} from "./service";

const routes = new Hono<AppContext>();
routes.post("/", async (c) => {
  const config = await resolveTelegramConfig(c.env);
  if (
    !config ||
    c.req.header("X-Telegram-Bot-Api-Secret-Token") !== config.webhookSecret
  )
    return c.json({ ok: false }, 403);
  const update = await c.req.json<any>();
  const callback = update.callback_query;
  if (
    !callback?.id ||
    String(callback.message?.chat?.id) !== String(config.chatId)
  )
    return c.json({ ok: true });
  const match = /^approval:(approve|reject):([0-9a-f-]+)$/.exec(
    String(callback.data ?? ""),
  );
  if (!match) return c.json({ ok: true });
  const result = await decideApproval(
    c.env,
    match[2],
    match[1] as "approve" | "reject",
    String(callback.from?.id ?? "unknown"),
  );
  await answerTelegramCallback(c.env, callback.id, result.text);
  return c.json({ ok: true });
});
export default routes;
