import { z } from "zod";

// Base object — no refinements so .partial() works cleanly for updates
const landingPageBaseSchema = z.object({
  name: z.string().min(2).max(200),
  slug: z
    .string()
    .regex(/^[a-z0-9-]{3,60}$/, "Slug must be 3-60 chars: lowercase letters, digits, hyphens")
    .optional(),
  productId: z.string().min(1),
  imageGap: z.number().int().min(0).max(200),
  sidePadding: z.number().int().min(0).max(120),
  contentMaxWidth: z.number().int().min(0).max(2400),
  showImages: z.boolean(),
  showOrderForm: z.boolean(),
  showStickyCta: z.boolean(),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  buttonColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  buttonTextColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  buttonRadius: z.number().int().min(0).max(100),
  metaTitle: z.string().max(200).nullable().optional(),
  metaDescription: z.string().max(300).nullable().optional(),
});

export const createLandingPageSchema = landingPageBaseSchema.extend({
  imageGap: landingPageBaseSchema.shape.imageGap.default(0),
  sidePadding: landingPageBaseSchema.shape.sidePadding.default(0),
  contentMaxWidth: landingPageBaseSchema.shape.contentMaxWidth.default(0),
  showImages: landingPageBaseSchema.shape.showImages.default(true),
  showOrderForm: landingPageBaseSchema.shape.showOrderForm.default(true),
  showStickyCta: landingPageBaseSchema.shape.showStickyCta.default(true),
  backgroundColor: landingPageBaseSchema.shape.backgroundColor.default("#ffffff"),
  buttonColor: landingPageBaseSchema.shape.buttonColor.default("#7c3aed"),
  buttonTextColor: landingPageBaseSchema.shape.buttonTextColor.default("#ffffff"),
  buttonRadius: landingPageBaseSchema.shape.buttonRadius.default(12),
});

export const updateLandingPageSchema = landingPageBaseSchema
  .omit({ productId: true })
  .partial();

export const reorderLandingPageImagesSchema = z.object({
  imageIds: z
    .array(z.string().min(1))
    .min(1),
});

export const saveLandingPageImageSchema = z.object({
  key: z.string().min(1),
  src: z.string().min(1),
  altText: z.string().nullable().optional(),
  position: z.number().int().min(1).optional(),
  /** Intrinsic pixel dimensions (client-measured at upload) — optional,
   *  fail-open: an image without dims still saves, the storefront just
   *  can't reserve its layout space. */
  width: z.number().int().min(1).max(20000).nullable().optional(),
  height: z.number().int().min(1).max(20000).nullable().optional(),
});

export type CreateLandingPageInput = z.infer<typeof createLandingPageSchema>;
export type UpdateLandingPageInput = z.infer<typeof updateLandingPageSchema>;
export type SaveLandingPageImageInput = z.infer<typeof saveLandingPageImageSchema>;
