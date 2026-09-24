export const CONTACT_CHANNELS = ["call", "whatsapp", "sms"] as const;
export const CONTACT_OUTCOMES = [
  "no_answer",
  "busy",
  "switched_off",
  "wrong_number",
  "answered",
  "callback_requested",
  "message_sent",
] as const;

export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

export const CALL_OUTCOMES = [
  "no_answer",
  "busy",
  "switched_off",
  "wrong_number",
  "answered",
  "callback_requested",
] as const satisfies readonly ContactOutcome[];

export const MESSAGE_CHANNELS = ["whatsapp", "sms"] as const satisfies readonly ContactChannel[];

export const UNANSWERED_OUTCOMES = [
  "no_answer",
  "busy",
  "switched_off",
  "wrong_number",
] as const satisfies readonly ContactOutcome[];

export const AUTO_UNREACHABLE_OUTCOMES = [
  "no_answer",
  "busy",
  "switched_off",
] as const satisfies readonly ContactOutcome[];

export const MAX_DAILY_UNANSWERED_CALLS = 3;
export const NOTE_MAX_LENGTH = 1000;

const ALGERIA_UTC_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isUnansweredOutcome(outcome: string): boolean {
  return (UNANSWERED_OUTCOMES as readonly string[]).includes(outcome);
}

export function countsTowardDailyLimit(channel: string, outcome: string): boolean {
  return channel === "call" && isUnansweredOutcome(outcome);
}

export function triggersAutoUnreachable(channel: string, outcome: string): boolean {
  return channel === "call" && (AUTO_UNREACHABLE_OUTCOMES as readonly string[]).includes(outcome);
}

export function isValidContactCombination(channel: string, outcome: string): boolean {
  if (channel === "call") return (CALL_OUTCOMES as readonly string[]).includes(outcome);
  if ((MESSAGE_CHANNELS as readonly string[]).includes(channel)) return outcome === "message_sent";
  return false;
}

export function algeriaDayBounds(now: Date = new Date()): { start: string; end: string } {
  const shifted = new Date(now.getTime() + ALGERIA_UTC_OFFSET_MS);
  const midnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  const start = midnight - ALGERIA_UTC_OFFSET_MS;
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + DAY_MS).toISOString(),
  };
}

export interface ContactAttemptLike {
  channel: ContactChannel;
  outcome: ContactOutcome;
  createdAt: string;
  callbackAt?: string | null;
  createdByName?: string | null;
}

export interface ContactSummary {
  dailyLimit: number;
  unansweredToday: number;
  remainingToday: number;
  limitReached: boolean;
  callsToday: number;
  messagesToday: number;
  totalCalls: number;
  totalMessages: number;
  lastAttempt: {
    channel: ContactChannel;
    outcome: ContactOutcome;
    createdAt: string;
    createdByName: string | null;
  } | null;
  nextCallbackAt: string | null;
  resetsAt: string;
}

export function summarizeContactAttempts(
  attempts: readonly ContactAttemptLike[],
  now: Date = new Date(),
): ContactSummary {
  const { start, end } = algeriaDayBounds(now);
  const sorted = [...attempts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const today = sorted.filter((a) => a.createdAt >= start && a.createdAt < end);
  const unansweredToday = today.filter((a) => countsTowardDailyLimit(a.channel, a.outcome)).length;
  const latest = sorted[0] ?? null;
  const latestReach = sorted.find(
    (a) => a.channel === "call" && (a.outcome === "answered" || a.outcome === "callback_requested"),
  );
  return {
    dailyLimit: MAX_DAILY_UNANSWERED_CALLS,
    unansweredToday,
    remainingToday: Math.max(0, MAX_DAILY_UNANSWERED_CALLS - unansweredToday),
    limitReached: unansweredToday >= MAX_DAILY_UNANSWERED_CALLS,
    callsToday: today.filter((a) => a.channel === "call").length,
    messagesToday: today.filter((a) => a.channel !== "call").length,
    totalCalls: sorted.filter((a) => a.channel === "call").length,
    totalMessages: sorted.filter((a) => a.channel !== "call").length,
    lastAttempt: latest
      ? {
          channel: latest.channel,
          outcome: latest.outcome,
          createdAt: latest.createdAt,
          createdByName: latest.createdByName ?? null,
        }
      : null,
    nextCallbackAt:
      latestReach?.outcome === "callback_requested" ? latestReach.callbackAt ?? null : null,
    resetsAt: end,
  };
}
