/**
 * Stores — contentJson shape validation
 *
 * The server stays theme-agnostic: it validates the structure of the JSON
 * blob without knowing the theme's content keys.
 */
import { describe, it, expect } from "vitest";
import { isValidContentJson, updateStoreSchema } from "./validation";

describe("isValidContentJson", () => {
  it("accepts the per-language dashboard format", () => {
    expect(isValidContentJson('{"ar": {"heroTitle": "عنوان"}, "en": {"heroTitle": "Title"}}')).toBe(true);
    expect(isValidContentJson('{"ar": {}}')).toBe(true);
  });

  it("accepts the legacy flat format", () => {
    expect(isValidContentJson('{"heroTitle": "Title"}')).toBe(true);
    expect(isValidContentJson("{}")).toBe(true);
  });

  it("rejects invalid JSON", () => {
    expect(isValidContentJson("not json")).toBe(false);
    expect(isValidContentJson("")).toBe(false);
  });

  it("rejects non-object JSON", () => {
    expect(isValidContentJson("[1,2]")).toBe(false);
    expect(isValidContentJson('"flat"')).toBe(false);
    expect(isValidContentJson("42")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidContentJson('{"heroTitle": 42}')).toBe(false);
    expect(isValidContentJson('{"ar": {"heroTitle": null}}')).toBe(false);
  });

  it("rejects mixed per-language/flat shapes", () => {
    expect(isValidContentJson('{"ar": {"heroTitle": "x"}, "heroTitle": "y"}')).toBe(false);
  });

  it("accepts unknown language keys as long as the shape is consistent", () => {
    expect(isValidContentJson('{"fr": {"heroTitle": "x"}}')).toBe(true);
  });
});

describe("updateStoreSchema.contentJson", () => {
  it("passes valid values through", () => {
    const parsed = updateStoreSchema.parse({
      contentJson: '{"ar": {"heroTitle": "عنوان"}}',
    });
    expect(parsed.contentJson).toBe('{"ar": {"heroTitle": "عنوان"}}');
  });

  it("allows null to clear the field", () => {
    expect(updateStoreSchema.parse({ contentJson: null }).contentJson).toBeNull();
    expect(updateStoreSchema.parse({}).contentJson).toBeUndefined();
  });

  it("fails on malformed contentJson", () => {
    const result = updateStoreSchema.safeParse({ contentJson: "not json" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["contentJson"]);
    }
  });
});
