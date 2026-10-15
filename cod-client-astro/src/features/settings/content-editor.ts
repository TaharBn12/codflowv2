/**
 * Pure logic for the storefront text customizer.
 *
 * `stores.content_json` is a JSON string of text overrides for the storefront
 * theme. Two shapes are supported:
 *   - Per-language (current format): {"ar": {"heroTitle": "..."}, "en": {...}}
 *   - Legacy flat: {"heroTitle": "..."} — applied to the store's language.
 *
 * The theme (theme01 resolveContent) merges these overrides on top of its own
 * language packs; keys that are absent or equal to the theme default fall back
 * to the theme strings.
 */
import { CONTENT_DEFAULTS, CONTENT_LANGS, type StoreContentLang } from "./content-catalog";

export type ContentOverrides = Record<StoreContentLang, Record<string, string | null>>;

export function emptyOverrides(): ContentOverrides {
  return { ar: {}, en: {} };
}

function takeStrings(value: unknown): Record<string, string> {
  const target: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return target;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.length > 0) target[key] = entry;
  }
  return target;
}

/** Parse stored contentJson into per-language overrides (unknown keys are kept). */
export function parseContentOverrides(
  raw: string | null | undefined,
  storeLang: StoreContentLang,
): ContentOverrides {
  const out = emptyOverrides();
  if (!raw || !raw.trim()) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;

  const obj = parsed as Record<string, unknown>;
  const isPerLang = CONTENT_LANGS.some(
    (code) => obj[code] && typeof obj[code] === "object" && !Array.isArray(obj[code]),
  );

  if (isPerLang) {
    for (const code of CONTENT_LANGS) {
      Object.assign(out[code], takeStrings(obj[code]));
    }
  } else {
    // Legacy flat format: overrides were applied to whichever language was
    // active. Migrate them onto the store's current language only.
    Object.assign(out[storeLang], takeStrings(obj));
  }
  return out;
}

/** The value the storefront would render for (lang, key). */
export function effectiveValue(
  lang: StoreContentLang,
  key: string,
  overrides: ContentOverrides,
): string {
  const value = overrides[lang][key];
  return value && value !== "" ? value : (CONTENT_DEFAULTS[lang][key] ?? "");
}

/** True when (lang, key) renders a merchant override rather than the theme default. */
export function isCustomized(
  lang: StoreContentLang,
  key: string,
  overrides: ContentOverrides,
): boolean {
  const value = overrides[lang][key];
  if (value == null || value === "") return false;
  return value !== (CONTENT_DEFAULTS[lang][key] ?? "");
}

export function customizedCount(lang: StoreContentLang, overrides: ContentOverrides): number {
  return Object.values(overrides[lang]).filter((value) => value != null && value !== "").length;
}

/**
 * Serialize overrides back to contentJson, dropping values that equal the theme
 * defaults (or are empty) so the stored JSON stays minimal. Returns null when
 * nothing is customized (clears the column).
 */
export function buildContentJson(overrides: ContentOverrides): string | null {
  const out: Record<StoreContentLang, Record<string, string>> = { ar: {}, en: {} };
  for (const code of CONTENT_LANGS) {
    for (const [key, value] of Object.entries(overrides[code])) {
      if (value == null || value === "") continue;
      if (value === CONTENT_DEFAULTS[code][key]) continue;
      out[code][key] = value;
    }
  }
  if (Object.keys(out.ar).length === 0 && Object.keys(out.en).length === 0) return null;
  return JSON.stringify(out);
}

/** Keys whose theme default contains a {placeholder} token (must be preserved). */
export function hasPlaceholders(lang: StoreContentLang, key: string): boolean {
  const value = CONTENT_DEFAULTS[lang][key] ?? "";
  return /\{[a-zA-Z0-9_]+\}/.test(value);
}
