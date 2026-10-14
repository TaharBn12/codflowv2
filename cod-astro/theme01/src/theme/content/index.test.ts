import { describe, expect, it, vi } from "vitest";
import { ar } from "./ar";
import { en } from "./en";
import { fr } from "./fr";
import { getSupportedLanguages, isLanguageSupported, resolveContent } from "./index";

describe("resolveContent", () => {
  it("returns the language defaults without overrides", () => {
    expect(resolveContent("ar").heroTitle).toBe(ar.heroTitle);
    expect(resolveContent("en").heroTitle).toBe(en.heroTitle);
    expect(resolveContent("fr").heroTitle).toBe(fr.heroTitle);
  });

  it("merges per-language overrides for the active language only", () => {
    const json = JSON.stringify({
      ar: { heroTitle: "عنواني" },
      en: { heroTitle: "My Title" },
    });
    expect(resolveContent("ar", json).heroTitle).toBe("عنواني");
    expect(resolveContent("en", json).heroTitle).toBe("My Title");
    expect(resolveContent("ar", json).heroEyebrow).toBe(ar.heroEyebrow);
  });

  it("falls back to defaults for a language with no overrides", () => {
    const json = JSON.stringify({ ar: { heroTitle: "عنواني" } });
    expect(resolveContent("en", json).heroTitle).toBe(en.heroTitle);
    expect(resolveContent("en", json).heroSubtitle).toBe(en.heroSubtitle);
  });

  it("still supports the legacy flat override format", () => {
    const json = JSON.stringify({ heroTitle: "Legacy Title" });
    expect(resolveContent("ar", json).heroTitle).toBe("Legacy Title");
    expect(resolveContent("en", json).heroTitle).toBe("Legacy Title");
    expect(resolveContent("ar", json).heroEyebrow).toBe(ar.heroEyebrow);
  });

  it("ignores non-string override values", () => {
    const json = JSON.stringify({ ar: { heroTitle: 42, heroEyebrow: "ok" } });
    const content = resolveContent("ar", json);
    expect(content.heroEyebrow).toBe("ok");
    expect(content.heroTitle).toBe(ar.heroTitle);
  });

  it("returns defaults for invalid JSON (with a warning)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveContent("ar", "not json")).toEqual(ar);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns defaults for non-object JSON", () => {
    expect(resolveContent("ar", "[1,2,3]")).toEqual(ar);
    expect(resolveContent("ar", '"flat"')).toEqual(ar);
  });
});

describe("language registry", () => {
  it("exposes ar/en/fr", () => {
    expect(getSupportedLanguages()).toEqual(["ar", "en", "fr"]);
    expect(isLanguageSupported("ar")).toBe(true);
    expect(isLanguageSupported("de")).toBe(false);
  });
});
