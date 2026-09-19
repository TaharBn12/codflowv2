import { describe, expect, it } from "vitest";
import { validSignature } from "./webhooks";
async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const value = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Array.from(new Uint8Array(value)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
describe("support webhook verification", () => {
  it("accepts a valid Meta signature", async () => { const body = '{"entry":[]}'; expect(await validSignature("app-secret", body, await sign("app-secret", body))).toBe(true); });
  it("rejects missing and forged signatures", async () => { expect(await validSignature("app-secret", "body", undefined)).toBe(false); expect(await validSignature("app-secret", "body", await sign("other-secret", "body"))).toBe(false); });
});
