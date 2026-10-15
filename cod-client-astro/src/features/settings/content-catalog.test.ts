import { describe, expect, it } from "vitest";
import {
  CONTENT_DEFAULTS,
  CONTENT_SECTIONS,
  CONTENT_LANGS,
  type ContentLocale,
} from "./content-catalog";
import { CONTENT_FIELD_LABELS, CONTENT_SECTION_TITLES } from "./content-labels";
// Drift guard: the catalog must stay in sync with the actual theme packs.
import { ar as themeAr } from "../../../../cod-astro/theme01/src/theme/content/ar";
import { en as themeEn } from "../../../../cod-astro/theme01/src/theme/content/en";

const ALL_KEYS = CONTENT_SECTIONS.flatMap((section) => section.keys);
const LOCALES: ContentLocale[] = ["ar", "en", "fr"];

describe("content catalog", () => {
  it("covers exactly the theme01 keys, in the same order (ar and en)", () => {
    expect(ALL_KEYS).toEqual(Object.keys(themeAr));
    expect(ALL_KEYS).toEqual(Object.keys(themeEn));
  });

  it("defaults match the theme01 packs exactly", () => {
    for (const key of ALL_KEYS) {
      expect(CONTENT_DEFAULTS.ar[key]).toBe(themeAr[key as keyof typeof themeAr]);
      expect(CONTENT_DEFAULTS.en[key]).toBe(themeEn[key as keyof typeof themeEn]);
    }
  });

  it("sections do not duplicate keys", () => {
    const seen = new Set<string>();
    for (const key of ALL_KEYS) {
      expect(seen.has(key), `duplicate key ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("labels every key in all dashboard locales", () => {
    for (const locale of LOCALES) {
      const missing = ALL_KEYS.filter(
        (key) => !CONTENT_FIELD_LABELS[locale][key] || !CONTENT_FIELD_LABELS[locale][key].trim(),
      );
      expect(missing, `missing labels in ${locale}`).toEqual([]);
    }
  });

  it("labels every section in all dashboard locales", () => {
    for (const section of CONTENT_SECTIONS) {
      for (const locale of LOCALES) {
        const title = CONTENT_SECTION_TITLES[section.id]?.[locale];
        expect(title, `missing title for ${section.id} (${locale})`);
        expect(title?.trim().length, `empty title for ${section.id} (${locale})`).toBeGreaterThan(0);
      }
    }
  });

  it("supports only the store languages (ar/en)", () => {
    expect(CONTENT_LANGS).toEqual(["ar", "en"]);
  });
});
