/**
 * Content Loader
 * 
 * Loads and resolves content based on language and dashboard overrides.
 * 
 * @example
 * ```typescript
 * import { resolveContent } from "@/theme/content";
 * 
 * const content = resolveContent("ar", dashboardContentJson);
 * ```
 */

import { ar } from "./ar";
import { en } from "./en";
import { fr } from "./fr";
import type { StoreFrontContent } from "./types";

/**
 * Language registry
 * Add new languages here as they become available
 */
const languages = {
  ar,
  en,
  fr,
} as const;

export type SupportedLanguage = keyof typeof languages;

/**
 * Resolve content for a given language with optional dashboard overrides
 *
 * Two override formats are accepted in `contentJson`:
 *   - Per-language (dashboard format): {"ar": {"heroTitle": "…"}, "en": {…}}
 *   - Legacy flat: {"heroTitle": "…"} — merged into whatever language is active.
 *
 * @param lang - Language code ("ar" or "en")
 * @param contentJson - Optional JSON string from dashboard with content overrides
 * @returns Complete StoreFrontContent object with all required keys
 *
 * @example
 * ```typescript
 * // Use default Arabic content
 * const content = resolveContent("ar");
 *
 * // Use Arabic with dashboard overrides (per-language or legacy flat)
 * const content = resolveContent("ar", '{"ar": {"heroTitle": "Custom Title"}}');
 * ```
 */
function stringOverrides(value: unknown): Partial<StoreFrontContent> {
  const out: Partial<StoreFrontContent> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") (out as Record<string, string>)[key] = entry;
  }
  return out;
}

export function resolveContent(
  lang: SupportedLanguage,
  contentJson?: string | null
): StoreFrontContent {
  // Get default content for language
  const defaults = languages[lang] || languages.ar;

  // No overrides - return defaults
  if (!contentJson) {
    return defaults;
  }

  // Parse and merge overrides
  try {
    const parsed: unknown = JSON.parse(contentJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaults;
    }
    const obj = parsed as Record<string, unknown>;
    const isPerLang = Object.keys(languages).some(
      (code) => obj[code] && typeof obj[code] === "object" && !Array.isArray(obj[code])
    );
    const overrides = isPerLang ? stringOverrides(obj[lang]) : stringOverrides(obj);
    return { ...defaults, ...overrides };
  } catch (error) {
    // Invalid JSON - return defaults
    console.warn("Failed to parse content JSON, using defaults:", error);
    return defaults;
  }
}

/**
 * Get list of supported languages
 * 
 * @returns Array of language codes
 */
export function getSupportedLanguages(): SupportedLanguage[] {
  return Object.keys(languages) as SupportedLanguage[];
}

/**
 * Check if a language is supported
 * 
 * @param lang - Language code to check
 * @returns true if language is supported
 */
export function isLanguageSupported(lang: string): lang is SupportedLanguage {
  return lang in languages;
}

// Re-export types for convenience
export type { StoreFrontContent } from "./types";
