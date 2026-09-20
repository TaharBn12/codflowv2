import { describe, expect, it, vi } from "vitest";
import { chooseLeastLoadedConfirmer, isAutomaticConfirmationAssignmentEnabled } from "./orders";

function dbWithSetting(setting: { enabled: boolean } | undefined) {
  const get = vi.fn(async () => setting);
  const where = vi.fn(() => ({ get }));
  const from = vi.fn(() => ({ where }));
  return { db: { select: vi.fn(() => ({ from })) } as any, get };
}

describe("automatic confirmation assignment setting", () => {
  it("honors an administrator-disabled global setting", async () => {
    const { db } = dbWithSetting({ enabled: false });
    await expect(isAutomaticConfirmationAssignmentEnabled(db)).resolves.toBe(false);
  });

  it("defaults to enabled before a settings row exists", async () => {
    const { db } = dbWithSetting(undefined);
    await expect(isAutomaticConfirmationAssignmentEnabled(db)).resolves.toBe(true);
  });
});

function dbWithCandidates(candidates: Array<Record<string, unknown>>) {
  const all = vi.fn(async () => candidates);
  const orderBy = vi.fn(() => ({ all }));
  const where = vi.fn(() => ({ orderBy }));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin }));
  return { select: vi.fn(() => ({ from })) } as any;
}

describe("automatic confirmation assignment capacity", () => {
  it("skips the least-loaded agent after their daily assignment limit", async () => {
    const db = dbWithCandidates([
      { id: "daily-full", openOrders: 1, maxOpenOrders: 25, assignedToday: 10, maxDailyOrders: 10 },
      { id: "available", openOrders: 2, maxOpenOrders: 25, assignedToday: 3, maxDailyOrders: 10 },
    ]);

    await expect(chooseLeastLoadedConfirmer(db)).resolves.toMatchObject({ id: "available" });
  });

  it("returns no agent when both open and daily capacity are exhausted", async () => {
    const db = dbWithCandidates([
      { id: "open-full", openOrders: 25, maxOpenOrders: 25, assignedToday: 1, maxDailyOrders: 10 },
      { id: "daily-full", openOrders: 1, maxOpenOrders: 25, assignedToday: 10, maxDailyOrders: 10 },
    ]);

    await expect(chooseLeastLoadedConfirmer(db)).resolves.toBeNull();
  });
});
