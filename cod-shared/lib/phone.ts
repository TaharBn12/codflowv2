/**
 * Algerian phone normalization — the single source of truth.
 *
 * Every write path that stores a phone already funnels through this module:
 * the storefront order schema and the dashboard order schema both coerce to
 * the canonical local form `0[567]XXXXXXXX`, which is what makes phone
 * equality a reliable join key for duplicate detection, customer dedupe, and
 * blacklist matching. Read paths (wa.me / tel: links, carrier APIs, Meta CAPI
 * hashing) need the other shapes, so all three live here.
 *
 *   toLocalAlgerianMobile("00213 551-234 567") → "0551234567"   (storage key)
 *   normalizeAlgerianPhone("0551234567")       → "+213551234567" (E.164)
 *   phoneMatchKey("+33612345678")              → "+33612345678"  (never null)
 */

const ALGERIAN_COUNTRY_CODE = "213";
const ALGERIAN_MOBILE_PREFIX = /^[567]/;

/** Strip visual separators — dzverify and the carriers reject spaces/dashes. */
function clean(raw: string): string {
  return raw.replace(/[\s\-().]/g, "");
}

/**
 * E.164 form ("+213551234567"), or null when the input cannot be normalized.
 * Foreign numbers pass through when they are already "+CC…" shaped.
 */
export function normalizeAlgerianPhone(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let phone = clean(raw.trim());
  if (phone.length < 6 || phone.length > 20) return null;

  // International dialing prefix "00" (e.g. "00213551234567") — treat as "+".
  if (phone.startsWith("00")) {
    phone = `+${phone.slice(2)}`;
  }

  // Already international: keep the + form. E.164 allows 7–15 digits after +.
  if (phone.startsWith("+")) {
    return /^\+\d{7,15}$/.test(phone) ? phone : null;
  }

  // "213…" without the + — complete it.
  if (phone.startsWith(ALGERIAN_COUNTRY_CODE)) {
    const rest = phone.slice(ALGERIAN_COUNTRY_CODE.length);
    return ALGERIAN_MOBILE_PREFIX.test(rest) ? `+${phone}` : null;
  }

  // Local form: 0-prefixed or bare Algerian mobile.
  const local = phone.startsWith("0") ? phone.slice(1) : phone;
  if (local.length === 9 && ALGERIAN_MOBILE_PREFIX.test(local)) {
    return `+${ALGERIAN_COUNTRY_CODE}${local}`;
  }

  return null;
}

/**
 * Canonical local form of an Algerian mobile: "0551234567".
 * Returns null for anything that is not an Algerian mobile (foreign +CC,
 * landlines, too-short/long inputs). This is the format orders store and
 * customers are deduplicated on.
 */
export function toLocalAlgerianMobile(raw: string): string | null {
  const e164 = normalizeAlgerianPhone(raw);
  if (!e164 || !e164.startsWith("+213")) return null;
  const local = e164.slice(4); // strip "+213"
  return /^[567]\d{8}$/.test(local) ? `0${local}` : null;
}

/** True when the value is already in the canonical stored form. */
export function isLocalAlgerianMobile(value: string): boolean {
  return /^0[567]\d{8}$/.test(value);
}

/**
 * Best-effort match key that never returns null — for lookups where rejecting
 * the input is worse than matching loosely (blacklist entries typed by an
 * operator, spreadsheet imports). Algerian mobiles collapse to the canonical
 * local form; anything else falls back to its cleaned literal so a foreign
 * number or an odd legacy row can still be banned and matched exactly.
 */
export function phoneMatchKey(raw: string): string {
  if (typeof raw !== "string") return "";
  const local = toLocalAlgerianMobile(raw);
  if (local) return local;
  const e164 = normalizeAlgerianPhone(raw);
  if (e164) return e164;
  return clean(raw.trim());
}
