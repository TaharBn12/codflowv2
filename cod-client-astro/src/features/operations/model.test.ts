import { describe, expect, it } from "vitest";
import { parseOperationAgentRoute } from "./model";

describe("parseOperationAgentRoute", () => {
  it("recognizes confirmer detail URLs served through the root fallback", () => {
    expect(parseOperationAgentRoute("/operations/agents/user_123")).toEqual({
      kind: "detail",
      id: "user_123",
    });
  });

  it("does not treat the operations overview as a detail page", () => {
    expect(parseOperationAgentRoute("/operations")).toEqual({ kind: "none" });
  });
});
