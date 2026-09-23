/**
 * Algerian phone normalization — re-exported from cod-shared.
 *
 * The implementation moved to `cod-shared/lib/phone.ts` so the blacklist,
 * duplicate detection, and spreadsheet import all normalize through the exact
 * same rules as the storefront OTP gate. This module stays as the import path
 * the store endpoints already use.
 */

export {
  normalizeAlgerianPhone,
  toLocalAlgerianMobile,
  isLocalAlgerianMobile,
  phoneMatchKey,
} from "../../../../cod-shared/lib/phone";
