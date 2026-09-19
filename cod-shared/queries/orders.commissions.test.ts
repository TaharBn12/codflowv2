import { describe, expect, it, vi } from "vitest";
import { createStaffCommissionStages, settleFollowUpCommission } from "./orders";

function commissionDb(row: Record<string, unknown>) {
  const inserted: any[] = [];
  const updates: any[] = [];
  const chain: any = { from: () => chain, leftJoin: () => chain, where: () => chain, get: async () => row };
  const db: any = {
    select: () => chain,
    insert: () => ({ values: (value: any) => { inserted.push(value); return { onConflictDoNothing: vi.fn(async () => undefined) }; } }),
    update: () => ({ set: (value: any) => { updates.push(value); return { where: vi.fn(async () => undefined) }; } }),
  };
  return { db, inserted, updates };
}

describe("staged staff commissions", () => {
  it("earns confirmation immediately and keeps follow-up pending", async () => {
    const fixture = commissionDb({ assigneeId: "agent-1", price: 12000, confirmationType: "fixed", confirmationValue: 300, followType: "percentage", followValue: 5 });
    await createStaffCommissionStages(fixture.db, "order-1", true);
    expect(fixture.inserted).toHaveLength(2);
    expect(fixture.inserted[0]).toMatchObject({ category: "confirmation", amount: 300, status: "earned", userId: "agent-1" });
    expect(fixture.inserted[0].earnedAt).toEqual(expect.any(String));
    expect(fixture.inserted[1]).toMatchObject({ category: "follow_up", amount: 600, status: "pending", earnedAt: null });
  });

  it("creates only a pending confirmation commission while an order is new", async () => {
    const fixture = commissionDb({ assigneeId: "agent-1", price: 12000, confirmationType: "fixed", confirmationValue: 300, followType: "fixed", followValue: 200 });
    await createStaffCommissionStages(fixture.db, "order-1", false);
    expect(fixture.inserted).toHaveLength(1);
    expect(fixture.inserted[0]).toMatchObject({ category: "confirmation", status: "pending", earnedAt: null });
  });

  it("earns or reverses only pending follow-up commission at terminal outcome", async () => {
    const delivered = commissionDb({});
    await settleFollowUpCommission(delivered.db, "order-1", "delivered");
    expect(delivered.updates[0]).toMatchObject({ status: "earned", earnedAt: expect.any(String) });
    const returned = commissionDb({});
    await settleFollowUpCommission(returned.db, "order-1", "reversed");
    expect(returned.updates[0]).toMatchObject({ status: "reversed", reversedAt: expect.any(String) });
  });
});
