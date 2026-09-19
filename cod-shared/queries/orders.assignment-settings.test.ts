import { describe, expect, it, vi } from "vitest";
import { isAutomaticConfirmationAssignmentEnabled } from "./orders";

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
