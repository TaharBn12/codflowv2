import { describe, expect, it } from "vitest";
import { ALL_SCOPES, ROLE_DEFAULT_SCOPES, SCOPES, SCOPE_CATEGORIES } from "./scopes";

describe("operations permission", () => {
  it("is independently assignable from order permissions", () => {
    expect(ALL_SCOPES).toContain("operations:view");
    expect(SCOPE_CATEGORIES.operations.scopes).toEqual([SCOPES.OPERATIONS_VIEW]);
  });

  it("preserves operations access for newly-created confirmer accounts", () => {
    expect(ROLE_DEFAULT_SCOPES.confirmer).toContain(SCOPES.OPERATIONS_VIEW);
  });
});
