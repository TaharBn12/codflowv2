import { describe, expect, it, vi } from "vitest";
import { APPROVAL_ACTIONS, requiresTelegramApproval } from "./service";

function dbWithPolicies(rows: Array<{ action: string; enabled: boolean }>) {
  const all = vi.fn(async () => rows);
  const where = vi.fn(() => ({ all }));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) } as any;
}

describe("Telegram approval policies", () => {
  it("publishes actions for every supported team role", () => {
    for (const role of ["admin", "staff", "confirmer", "driver"]) {
      expect(APPROVAL_ACTIONS.some((action) => (action.roles as readonly string[]).includes(role))).toBe(true);
    }
  });

  it("keeps commission payouts protected until the primary admin changes the policy", async () => {
    await expect(requiresTelegramApproval(dbWithPolicies([]), "admin-1", "commissions.mark_paid")).resolves.toBe(true);
    await expect(requiresTelegramApproval(dbWithPolicies([{ action: "commissions.mark_paid", enabled: false }]), "admin-1", "commissions.mark_paid")).resolves.toBe(false);
  });
});
