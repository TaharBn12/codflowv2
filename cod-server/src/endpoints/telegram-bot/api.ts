/**
 * Minimal Telegram Bot API client.
 *
 * Every call goes through `telegramCall`, which:
 *  - posts JSON to `https://api.telegram.org/bot<token>/<method>`;
 *  - retries once on HTTP 429 using Telegram's `retry_after`;
 *  - converts `{ ok: false }` into a typed error with the description, so the
 *    webhook handler can log it instead of throwing into a silent 500.
 *
 * Networking is injected (`fetchImpl`) to keep unit tests offline.
 */

import type { Env } from "@/types";
import { resolveTelegramConfig, type ResolvedTelegramConfig } from "@/endpoints/telegram-approvals/service";

export type TelegramFetch = typeof fetch;

export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly method: string,
    public readonly description?: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

export interface SendMessageOptions {
  chatId: string | number;
  text: string;
  keyboard?: InlineKeyboard;
  parseMode?: "HTML" | "MarkdownV2";
  disablePreview?: boolean;
  replyToMessageId?: number;
}

export interface TelegramMessageResult {
  message_id: number;
  chat?: { id: number | string };
}

async function sleep(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function telegramCall<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  fetchImpl: TelegramFetch = fetch,
  attempt = 0,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    if (attempt < 1) {
      await sleep(400);
      return telegramCall<T>(token, method, body, fetchImpl, attempt + 1);
    }
    throw new TelegramApiError(
      `Telegram ${method} network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      method,
    );
  }

  let payload: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    /* non-JSON body — handled below */
  }

  if (response.status === 429 && attempt < 1) {
    const retryAfter = Math.min(payload.parameters?.retry_after ?? 1, 5);
    await sleep(retryAfter * 1_000);
    return telegramCall<T>(token, method, body, fetchImpl, attempt + 1);
  }

  if (!response.ok || payload.ok === false) {
    throw new TelegramApiError(
      payload.description ?? `Telegram ${method} failed (${response.status})`,
      method,
      payload.description,
      payload.parameters?.retry_after,
    );
  }

  return payload.result as T;
}

function keyboardPayload(keyboard?: InlineKeyboard) {
  if (!keyboard?.length) return undefined;
  return {
    inline_keyboard: keyboard.map((row) =>
      row.filter((button) => Boolean(button.callback_data ?? button.url)),
    ).filter((row) => row.length > 0),
  };
}

export async function sendBotMessage(
  config: ResolvedTelegramConfig,
  options: SendMessageOptions,
  fetchImpl: TelegramFetch = fetch,
): Promise<TelegramMessageResult> {
  return telegramCall<TelegramMessageResult>(
    config.botToken,
    "sendMessage",
    {
      chat_id: options.chatId,
      text: options.text,
      parse_mode: options.parseMode ?? "HTML",
      disable_web_page_preview: options.disablePreview ?? true,
      ...(options.replyToMessageId ? { reply_to_message_id: options.replyToMessageId } : {}),
      ...(keyboardPayload(options.keyboard) ? { reply_markup: keyboardPayload(options.keyboard) } : {}),
    },
    fetchImpl,
  );
}

export async function editBotMessage(
  config: ResolvedTelegramConfig,
  options: SendMessageOptions & { messageId: number },
  fetchImpl: TelegramFetch = fetch,
): Promise<void> {
  try {
    await telegramCall(
      config.botToken,
      "editMessageText",
      {
        chat_id: options.chatId,
        message_id: options.messageId,
        text: options.text,
        parse_mode: options.parseMode ?? "HTML",
        disable_web_page_preview: options.disablePreview ?? true,
        ...(keyboardPayload(options.keyboard) ? { reply_markup: keyboardPayload(options.keyboard) } : {}),
      },
      fetchImpl,
    );
  } catch (error) {
    // Telegram rejects edits that do not change anything — that is not a failure.
    if (error instanceof TelegramApiError && /message is not modified/i.test(error.description ?? "")) return;
    throw error;
  }
}

export async function answerCallback(
  config: ResolvedTelegramConfig,
  callbackId: string,
  text?: string,
  showAlert = false,
  fetchImpl: TelegramFetch = fetch,
): Promise<void> {
  try {
    await telegramCall(
      config.botToken,
      "answerCallbackQuery",
      { callback_query_id: callbackId, ...(text ? { text, show_alert: showAlert } : {}) },
      fetchImpl,
    );
  } catch (error) {
    console.warn("[telegram-bot] answerCallbackQuery failed", error);
  }
}

export async function getBotIdentity(
  config: ResolvedTelegramConfig,
  fetchImpl: TelegramFetch = fetch,
): Promise<{ id: number; username?: string; first_name?: string } | null> {
  try {
    return await telegramCall(config.botToken, "getMe", {}, fetchImpl);
  } catch (error) {
    console.warn("[telegram-bot] getMe failed", error);
    return null;
  }
}

export interface BotCommand {
  command: string;
  description: string;
}

/** Registers the command list shown in Telegram's “/” menu, per language. */
export async function registerBotCommands(
  config: ResolvedTelegramConfig,
  fetchImpl: TelegramFetch = fetch,
): Promise<void> {
  const lists: Record<string, BotCommand[]> = {
    ar: [
      { command: "menu", description: "القائمة الرئيسية" },
      { command: "orders", description: "تصفح الطلبات وغيّر حالتها" },
      { command: "order", description: "بطاقة طلب برقم أو هاتف" },
      { command: "report", description: "تقرير اليوم/الأسبوع/الشهر" },
      { command: "pending", description: "الموافقات المعلّقة" },
      { command: "stock", description: "المخزون الحرج" },
      { command: "mute", description: "كتم التنبيهات مؤقتاً" },
      { command: "link", description: "ربط حسابك برمز" },
      { command: "settings", description: "الإعدادات واللغة" },
      { command: "help", description: "المساعدة" },
    ],
    fr: [
      { command: "menu", description: "Menu principal" },
      { command: "orders", description: "Commandes et statuts" },
      { command: "order", description: "Fiche commande (n° / téléphone)" },
      { command: "report", description: "Rapport jour/semaine/mois" },
      { command: "pending", description: "Approbations en attente" },
      { command: "stock", description: "Stock critique" },
      { command: "mute", description: "Pause des alertes" },
      { command: "link", description: "Lier votre compte" },
      { command: "settings", description: "Paramètres et langue" },
      { command: "help", description: "Aide" },
    ],
    en: [
      { command: "menu", description: "Main menu" },
      { command: "orders", description: "Browse orders and change status" },
      { command: "order", description: "Order card by number or phone" },
      { command: "report", description: "Today/week/month report" },
      { command: "pending", description: "Pending approvals" },
      { command: "stock", description: "Critical stock" },
      { command: "mute", description: "Pause alerts" },
      { command: "link", description: "Link your account" },
      { command: "settings", description: "Settings and language" },
      { command: "help", description: "Help" },
    ],
  };
  for (const [languageCode, commands] of Object.entries(lists)) {
    try {
      await telegramCall(config.botToken, "setMyCommands", { commands, language_code: languageCode }, fetchImpl);
    } catch (error) {
      console.warn(`[telegram-bot] setMyCommands(${languageCode}) failed`, error);
    }
  }
}

/** Resolves the bot config, or null when the dashboard/env has none. */
export async function botConfig(env: Env): Promise<ResolvedTelegramConfig | null> {
  return resolveTelegramConfig(env);
}
