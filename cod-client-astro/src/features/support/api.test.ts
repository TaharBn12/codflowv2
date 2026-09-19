import { beforeEach, describe, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: seam.apiFetch }));
import { createCustomerLink, listChannels, sendMessage } from "./api";
describe("support API", () => {
  beforeEach(() => vi.clearAllMocks());
  it("reads only the server channel projection", async () => { const channel = { id: "wa", type: "whatsapp", accessTokenMasked: "••••token" }; seam.apiFetch.mockResolvedValue({ success: true, data: [channel] }); await expect(listChannels()).resolves.toEqual([channel]); expect(channel).not.toHaveProperty("accessToken"); });
  it("sends replies and creates customer links", async () => { seam.apiFetch.mockResolvedValueOnce({ success: true, data: { id: "m1" } }); await sendMessage("c1", "Hello"); expect(seam.apiFetch).toHaveBeenCalledWith("/api/support/conversations/c1/messages", expect.objectContaining({ method: "POST", body: JSON.stringify({ body: "Hello", internal: false }) })); seam.apiFetch.mockResolvedValueOnce({ success: true, data: { url: "https://api.example/customer-order/token", expiresAt: "later" } }); await createCustomerLink("o1"); expect(seam.apiFetch).toHaveBeenLastCalledWith("/api/support/orders/o1/customer-link", expect.objectContaining({ method: "POST" })); });
});
