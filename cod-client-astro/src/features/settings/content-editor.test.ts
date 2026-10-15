import { describe, expect, it } from "vitest";
import { CONTENT_DEFAULTS } from "./content-catalog";
import {
  buildContentJson,
  customizedCount,
  emptyOverrides,
  effectiveValue,
  hasPlaceholders,
  isCustomized,
  parseContentOverrides,
} from "./content-editor";

const CUSTOM = "My custom hero title";
const AR_DEFAULT = CONTENT_DEFAULTS.ar.heroTitle;

describe("parseContentOverrides", () => {
  it("returns empty overrides for null/empty/invalid input", () => {
    for (const raw of [null, undefined, "", "   ", "not json", "[1,2]", '"str"']) {
      const parsed = parseContentOverrides(raw, "ar");
      expect(parsed).toEqual({ ar: {}, en: {} });
    }
  });

  it("parses the per-language format", () => {
    const parsed = parseContentOverrides(
      JSON.stringify({ ar: { heroTitle: "عنواني" }, en: { heroTitle: CUSTOM } }),
      "ar",
    );
    expect(parsed.ar.heroTitle).toBe("عنواني");
    expect(parsed.en.heroTitle).toBe(CUSTOM);
    expect(parsed.ar.heroEyebrow).toBeUndefined();
  });

  it("migrates the legacy flat format onto the store's language", () => {
    const parsed = parseContentOverrides(JSON.stringify({ heroTitle: CUSTOM }), "ar");
    expect(parsed.ar.heroTitle).toBe(CUSTOM);
    expect(parsed.en.heroTitle).toBeUndefined();
  });

  it("drops non-string values", () => {
    const parsed = parseContentOverrides(
      JSON.stringify({ ar: { heroTitle: 42, heroEyebrow: "ok", heroSubtitle: null } }),
      "ar",
    );
    expect(parsed.ar).toEqual({ heroEyebrow: "ok" });
  });
});

describe("effectiveValue / isCustomized", () => {
  it("falls back to the theme default without overrides", () => {
    expect(effectiveValue("ar", "heroTitle", emptyOverrides())).toBe(AR_DEFAULT);
    expect(isCustomized("ar", "heroTitle", emptyOverrides())).toBe(false);
  });

  it("returns the override when customized", () => {
    const overrides = parseContentOverrides(JSON.stringify({ ar: { heroTitle: CUSTOM } }), "ar");
    expect(effectiveValue("ar", "heroTitle", overrides)).toBe(CUSTOM);
    expect(isCustomized("ar", "heroTitle", overrides)).toBe(true);
    expect(isCustomized("en", "heroTitle", overrides)).toBe(false);
  });

  it("treats a value equal to the default as not customized", () => {
    const overrides = { ar: { heroTitle: AR_DEFAULT }, en: {} };
    expect(isCustomized("ar", "heroTitle", overrides)).toBe(false);
    expect(effectiveValue("ar", "heroTitle", overrides)).toBe(AR_DEFAULT);
  });
});

describe("buildContentJson", () => {
  it("returns null when nothing is customized", () => {
    expect(buildContentJson(emptyOverrides())).toBeNull();
    expect(buildContentJson({ ar: { heroTitle: AR_DEFAULT }, en: {} })).toBeNull();
    expect(buildContentJson({ ar: { heroTitle: "" }, en: {} })).toBeNull();
  });

  it("keeps only non-default values, per language", () => {
    const json = buildContentJson({ ar: { heroTitle: CUSTOM }, en: {} });
    expect(json).toBe(JSON.stringify({ ar: { heroTitle: CUSTOM }, en: {} }));
  });

  it("round-trips with parseContentOverrides", () => {
    const original = { ar: { heroTitle: "عنواني", footerAbout: "نبذتي" }, en: { heroTitle: CUSTOM } };
    const parsed = parseContentOverrides(JSON.stringify(original), "ar");
    const rebuilt = buildContentJson(parsed);
    expect(JSON.parse(rebuilt ?? "")).toEqual(original);
  });

  it("keeps unknown keys (forward compatibility with newer themes)", () => {
    const parsed = parseContentOverrides(
      JSON.stringify({ ar: { futureKey: "value" } }),
      "ar",
    );
    const rebuilt = JSON.parse(buildContentJson(parsed) ?? "");
    expect(rebuilt.ar.futureKey).toBe("value");
  });
});

describe("helpers", () => {
  it("customizedCount counts non-empty values", () => {
    const overrides = { ar: { heroTitle: "a", footerAbout: "b" }, en: { heroTitle: "" } };
    expect(customizedCount("ar", overrides)).toBe(2);
    expect(customizedCount("en", overrides)).toBe(0);
  });

  it("hasPlaceholders detects {token} markers", () => {
    expect(hasPlaceholders("ar", "offerAddMore")).toBe(true);
    expect(hasPlaceholders("en", "ariaProductCard")).toBe(true);
    expect(hasPlaceholders("ar", "heroTitle")).toBe(false);
  });
});
