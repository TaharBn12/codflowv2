import { describe, expect, it } from "vitest";
import {
  algeriaDayBounds,
  countsTowardDailyLimit,
  isValidContactCombination,
  summarizeContactAttempts,
  triggersAutoUnreachable,
  type ContactAttemptLike,
} from "./order-contact";

describe("algeriaDayBounds", () => {
  it("returns the UTC window of the current Algeria (UTC+1) day", () => {
    expect(algeriaDayBounds(new Date("2026-09-23T10:00:00.000Z"))).toEqual({
      start: "2026-09-22T23:00:00.000Z",
      end: "2026-09-23T23:00:00.000Z",
    });
  });

  it("rolls to the next Algeria day at 23:00 UTC, not at UTC midnight", () => {
    expect(algeriaDayBounds(new Date("2026-09-23T23:30:00.000Z")).start).toBe("2026-09-23T23:00:00.000Z");
    expect(algeriaDayBounds(new Date("2026-09-23T22:59:59.999Z")).start).toBe("2026-09-22T23:00:00.000Z");
  });
});

describe("contact outcome rules", () => {
  it("counts only unanswered calls toward the daily limit", () => {
    expect(countsTowardDailyLimit("call", "no_answer")).toBe(true);
    expect(countsTowardDailyLimit("call", "busy")).toBe(true);
    expect(countsTowardDailyLimit("call", "switched_off")).toBe(true);
    expect(countsTowardDailyLimit("call", "wrong_number")).toBe(true);
    expect(countsTowardDailyLimit("call", "answered")).toBe(false);
    expect(countsTowardDailyLimit("call", "callback_requested")).toBe(false);
    expect(countsTowardDailyLimit("whatsapp", "message_sent")).toBe(false);
    expect(countsTowardDailyLimit("sms", "message_sent")).toBe(false);
  });

  it("parks the order as unreachable only for a genuine no-reach call", () => {
    expect(triggersAutoUnreachable("call", "no_answer")).toBe(true);
    expect(triggersAutoUnreachable("call", "busy")).toBe(true);
    expect(triggersAutoUnreachable("call", "switched_off")).toBe(true);
    expect(triggersAutoUnreachable("call", "wrong_number")).toBe(false);
    expect(triggersAutoUnreachable("whatsapp", "message_sent")).toBe(false);
  });

  it("pairs message_sent with message channels and call outcomes with calls", () => {
    expect(isValidContactCombination("whatsapp", "message_sent")).toBe(true);
    expect(isValidContactCombination("sms", "message_sent")).toBe(true);
    expect(isValidContactCombination("call", "message_sent")).toBe(false);
    expect(isValidContactCombination("whatsapp", "no_answer")).toBe(false);
    expect(isValidContactCombination("call", "answered")).toBe(true);
    expect(isValidContactCombination("fax", "answered")).toBe(false);
  });
});

describe("summarizeContactAttempts", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const attempt = (overrides: Partial<ContactAttemptLike>): ContactAttemptLike => ({
    channel: "call",
    outcome: "no_answer",
    createdAt: "2026-09-23T09:00:00.000Z",
    ...overrides,
  });

  it("counts today's unanswered calls and exposes the remaining quota", () => {
    const summary = summarizeContactAttempts(
      [
        attempt({ createdAt: "2026-09-23T08:00:00.000Z" }),
        attempt({ outcome: "busy", createdAt: "2026-09-23T09:00:00.000Z" }),
        attempt({ channel: "whatsapp", outcome: "message_sent", createdAt: "2026-09-23T09:30:00.000Z" }),
        attempt({ createdAt: "2026-09-22T20:00:00.000Z" }),
      ],
      now,
    );
    expect(summary).toMatchObject({
      dailyLimit: 3,
      unansweredToday: 2,
      remainingToday: 1,
      limitReached: false,
      callsToday: 2,
      messagesToday: 1,
      totalCalls: 3,
      totalMessages: 1,
      resetsAt: "2026-09-23T23:00:00.000Z",
    });
    expect(summary.lastAttempt).toMatchObject({ channel: "whatsapp", outcome: "message_sent" });
  });

  it("reports the limit as reached after three unanswered calls", () => {
    const summary = summarizeContactAttempts(
      [
        attempt({ createdAt: "2026-09-23T08:00:00.000Z" }),
        attempt({ createdAt: "2026-09-23T09:00:00.000Z" }),
        attempt({ outcome: "switched_off", createdAt: "2026-09-23T10:00:00.000Z" }),
      ],
      now,
    );
    expect(summary.limitReached).toBe(true);
    expect(summary.remainingToday).toBe(0);
  });

  it("surfaces the pending callback only while it is the latest reach", () => {
    const pending = summarizeContactAttempts(
      [attempt({ outcome: "callback_requested", callbackAt: "2026-09-23T16:00:00.000Z" })],
      now,
    );
    expect(pending.nextCallbackAt).toBe("2026-09-23T16:00:00.000Z");

    const resolved = summarizeContactAttempts(
      [
        attempt({ outcome: "callback_requested", callbackAt: "2026-09-23T16:00:00.000Z", createdAt: "2026-09-23T08:00:00.000Z" }),
        attempt({ outcome: "answered", createdAt: "2026-09-23T11:00:00.000Z" }),
      ],
      now,
    );
    expect(resolved.nextCallbackAt).toBeNull();
  });

  it("handles an order that was never contacted", () => {
    const summary = summarizeContactAttempts([], now);
    expect(summary).toMatchObject({ unansweredToday: 0, remainingToday: 3, limitReached: false, lastAttempt: null, nextCallbackAt: null });
  });
});
