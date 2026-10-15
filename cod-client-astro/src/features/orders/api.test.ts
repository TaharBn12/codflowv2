import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ apiFetch: vi.fn(), apiFetchBlob: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: seam.apiFetch, apiFetchBlob: seam.apiFetchBlob }));

import { addOrderNote, getOrderActivity, listContactAttempts, logContactAttempt } from "./api";

describe("order contact API adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seam.apiFetch.mockResolvedValue({ success: true, data: { ok: true } });
  });

  it("posts a contact attempt to the encoded order path and unwraps data", async () => {
    const data = await logContactAttempt("ord/1", { channel: "whatsapp", outcome: "message_sent", note: "sent" });
    expect(data).toEqual({ ok: true });
    expect(seam.apiFetch).toHaveBeenCalledWith(
      "/api/orders/ord%2F1/contact-attempts",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ channel: "whatsapp", outcome: "message_sent", note: "sent" }),
      }),
    );
  });

  it("reads contact attempts, notes and the activity feed through the API seam", async () => {
    await listContactAttempts("ord_1");
    await getOrderActivity("ord_1");
    await addOrderNote("ord_1", "Evening delivery");
    expect(seam.apiFetch).toHaveBeenNthCalledWith(1, "/api/orders/ord_1/contact-attempts");
    expect(seam.apiFetch).toHaveBeenNthCalledWith(2, "/api/orders/ord_1/activity");
    expect(seam.apiFetch).toHaveBeenNthCalledWith(
      3,
      "/api/orders/ord_1/notes",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ note: "Evening delivery" }) }),
    );
  });
});
