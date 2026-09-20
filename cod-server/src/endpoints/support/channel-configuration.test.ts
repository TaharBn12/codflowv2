import { describe, expect, it } from "vitest";
import { enabledChannelConfigurationError } from "./routes";

describe("support channel activation", () => {
  it("allows disabled channels to be saved before credentials are complete", () => {
    expect(enabledChannelConfigurationError({ type: "whatsapp", enabled: false })).toBeNull();
  });

  it("requires every WhatsApp credential before activation", () => {
    expect(enabledChannelConfigurationError({
      type: "whatsapp",
      enabled: true,
      senderId: "phone-id",
      accessToken: "token",
      verifyToken: "verify",
      appSecret: null,
    })).toMatch(/WhatsApp credentials/);
  });

  it("accepts a complete WhatsApp configuration", () => {
    expect(enabledChannelConfigurationError({
      type: "whatsapp",
      enabled: true,
      senderId: "phone-id",
      accessToken: "token",
      verifyToken: "verify",
      appSecret: "secret",
    })).toBeNull();
  });
});
