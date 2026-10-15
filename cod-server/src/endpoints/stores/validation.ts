import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "Invalid hex color");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the shape of stores.content_json. The server stays theme-agnostic
 * (it does not know the theme's content keys), so only the structure is
 * checked. Two shapes are accepted:
 *   - Per-language (dashboard format): {"ar": {"key": "…"}, "en": {…}}
 *   - Legacy flat: {"key": "…"}
 */
export function isValidContentJson(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return true;
  const perLang = entries.some(([, entry]) => isPlainObject(entry));
  if (perLang) {
    return entries.every(
      ([, entry]) =>
        isPlainObject(entry) && Object.values(entry).every((v) => typeof v === "string"),
    );
  }
  return entries.every(([, entry]) => typeof entry === "string");
}

export const contentJsonField = z
  .string()
  .nullable()
  .optional()
  .superRefine((value, ctx) => {
    if (value == null) return;
    if (!isValidContentJson(value)) {
      ctx.addIssue({
        code: "custom",
        message:
          "contentJson must be a JSON object mapping content keys to strings, or language codes (ar/en/fr) to such objects",
      });
    }
  });

export const updateStoreSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  logoUrl: z.string().url().nullable().optional(),
  /**
   * The storefront's custom domain (e.g. "demo.codflow.store"). Merchants
   * connect their own domain and set it here; landing page links and share
   * URLs are built from it. No scheme — https is always assumed. null clears
   * it (links fall back to the deployment's storefront URL or relative paths).
   */
  domain: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i, "Domain must be a hostname like store.example.com")
    .max(200)
    .nullable()
    .optional(),
  primaryColor: hexColor.optional(),
  accentColor: hexColor.optional(),
  bgColor: hexColor.optional(),
  fontFamily: z.string().min(1).max(200).optional(),
  fontUrl: z.string().url().nullable().optional(),
  lang: z.enum(["ar", "en"]).optional(),
  currencySymbol: z.string().min(1).max(10).optional(),
  contentJson: contentJsonField,
  metaTitle: z.string().max(200).nullable().optional(),
  metaDescription: z.string().max(500).nullable().optional(),
  ogImage: z.string().url().nullable().optional(),
  announcementBar: z.string().max(500).nullable().optional(),
  reviewsEnabled: z.boolean().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;
