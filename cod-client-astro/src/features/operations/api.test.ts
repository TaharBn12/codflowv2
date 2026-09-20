import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: seam.apiFetch }));

import { saveOperationAgentSettings, type OperationAgent } from "./api";

const agent: OperationAgent = {
  id: "agent/1",
  name: "Agent",
  email: "agent@example.com",
  status: "active",
  autoAssignEnabled: false,
  maxOpenOrders: 25,
  maxDailyOrders: 50,
  commissionType: "fixed",
  commissionValue: 10,
  confirmationCommissionType: "fixed",
  confirmationCommissionValue: 5,
};

describe("operations API adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seam.apiFetch.mockResolvedValue({ success: true, data: agent });
  });

  it("persists a disabled automatic-distribution switch as false", async () => {
    await saveOperationAgentSettings(agent);

    expect(seam.apiFetch).toHaveBeenCalledWith(
      "/api/operations/agents/agent%2F1/settings",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"autoAssignEnabled":false'),
      }),
    );
  });
});
