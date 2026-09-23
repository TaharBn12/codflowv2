/**
 * Spreadsheet → order import: field definitions and header detection.
 *
 * Lives in cod-shared because both sides need the same truth: the server uses
 * it to auto-map an uploaded sheet, the dashboard uses it to render the mapping
 * picker and the "which columns did we detect?" preview. A merchant's sheet
 * arrives in Arabic, French, or English — usually a mix of all three, sometimes
 * with a title row above the headers — and the aliases below are what turns
 * "رقم الهاتف", "Téléphone" and "Phone Number" into the same field.
 *
 * Deliberately free of DB access and of the spreadsheet parser: this module is
 * pure string/number logic so it is unit-testable on its own.
 */

export type OrderImportFieldKey =
  | "customerName"
  | "phone"
  | "wilaya"
  | "commune"
  | "address"
  | "productName"
  | "productSku"
  | "variantLabel"
  | "quantity"
  | "price"
  | "deliveryFee"
  | "deliveryType"
  | "notes"
  | "externalReference";

export interface OrderImportField {
  key: OrderImportFieldKey;
  /** A row without this field cannot become an order. */
  required: boolean;
  /** Normalized header spellings — see normalizeHeaderKey. */
  aliases: string[];
}

/**
 * Every importable column. Order matters: it is the order the mapping UI lists
 * fields in, and the order the CSV template is generated in.
 */
export const ORDER_IMPORT_FIELDS: OrderImportField[] = [
  {
    key: "customerName",
    required: true,
    aliases: [
      "customername", "name", "fullname", "customer", "client", "clientname",
      "الاسم", "اسمالعميل", "اسمالزبون", "اسمالمشتري", "العميل", "الزبون",
      "nom", "nomclient", "nomduclient", "client",
    ],
  },
  {
    key: "phone",
    required: true,
    aliases: [
      "phone", "phonenumber", "phone1", "mobile", "mobilenumber", "tel",
      "telephone", "cellphone", "contactnumber", "msisdn",
      "الهاتف", "رقمالهاتف", "رقمالتلفون", "الهاتف1", "جوال", "موبايل",
      "تلفون", "رقمالجوال", "رقمالاتصال",
      "telephone", "tel", "numero", "numerodetelephone", "gsm", "portable",
    ],
  },
  {
    key: "wilaya",
    required: true,
    aliases: [
      "wilaya", "wilayaid", "wilayanumber", "state", "province", "region",
      "codepost", "dairawilaya",
      "الولاية", "رقمالولاية", "الولايةالرقم", "ولاية",
      "wilaya", "etats", "region", "departement",
    ],
  },
  {
    key: "commune",
    required: false,
    aliases: [
      "commune", "town", "city", "municipality", "district", "area", "daira",
      "baladiya",
      "البلدية", "بلدية", "المدينة", "مدينة", "الدائرة", "المنطقة",
      "commune", "ville", "municipalite", "localite", "quartier",
    ],
  },
  {
    key: "address",
    required: false,
    aliases: [
      "address", "street", "streetaddress", "location", "fulladdress",
      "deliveryaddress",
      "العنوان", "عنوان", "عنوانالتوصيل", "المكان", "الحي", "الشارع",
      "adresse", "lieu", "ruelle", "quartier",
    ],
  },
  {
    key: "productName",
    required: false,
    aliases: [
      "product", "productname", "item", "itemname", "article", "goods",
      "offering", "pack", "packagename",
      "المنتج", "اسمالمنتج", "السلعة", "المقال", "العنوانالمنتج", "العرض",
      "produit", "article", "designation", "nomproduit",
    ],
  },
  {
    key: "productSku",
    required: false,
    aliases: [
      "sku", "productsku", "productcode", "code", "reference", "itemid",
      "باركود", "barcode", "رمزالمنتج", "الرقمالمرجعي",
      "sku", "codearticle", "referenceproduit", "codeproduit",
    ],
  },
  {
    key: "variantLabel",
    required: false,
    aliases: [
      "variant", "variantlabel", "option", "options", "variation", "size",
      "color", "attribute",
      "الخيار", "المتغير", "التنويعة", "المقاس", "اللون", "الحجم",
      "variante", "option", "taille", "couleur",
    ],
  },
  {
    key: "quantity",
    required: false,
    aliases: [
      "quantity", "qty", "count", "units", "numberofitems", "pieces",
      "الكمية", "كمية", "عدد", "عددالقطع",
      "quantite", "qte", "nombre",
    ],
  },
  {
    key: "price",
    required: true,
    aliases: [
      "price", "total", "totalprice", "amount", "amountdue", "cod",
      "codamount", "value", "ordervalue", "sellingprice",
      "السعر", "المبلغ", "الثمن", "الاجمالي", "المجموع", "سعرالطلب",
      "prix", "montant", "total", "prixdevente",
    ],
  },
  {
    key: "deliveryFee",
    required: false,
    aliases: [
      "deliveryfee", "shippingfee", "shipping", "freight", "deliverycost",
      "رسومالتوصيل", "سعرالتوصيل", "التوصيل", "مصاريفالتوصيل",
      "fraisdslivraison", "fraisdelivraison", "livraison", "fraisdeport",
    ],
  },
  {
    key: "deliveryType",
    required: false,
    aliases: [
      "deliverytype", "shippingtype", "shippingmethod", "method", "stopdesk",
      "نوعالتوصيل", "طريقةالتوصيل", "التوصيل", "مكتب", "وقفمكتب",
      "typedelivraison", "modedelivraison", "livraison", "bureau", "stopdesk",
    ],
  },
  {
    key: "notes",
    required: false,
    aliases: [
      "notes", "note", "remarks", "remark", "comment", "comments", "observation",
      "ملاحظات", "ملاحظة", "تعليق", "تعليقات",
      "remarque", "remarques", "commentaire", "note",
    ],
  },
  {
    key: "externalReference",
    required: false,
    aliases: [
      "orderid", "ordernumber", "externalreference", "referenceid", "legacyid",
      "sourceid", "shopifyorderid",
      "رقمالطلب", "المرجع", "الرقمالمرجعي", "رمزالطلب",
      "numerodecommande", "commande", "referencecommande",
    ],
  },
];

export const ORDER_IMPORT_FIELD_KEYS = ORDER_IMPORT_FIELDS.map(
  (field) => field.key,
);

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const ARABIC_TATWEEL = /\u0640/g;
/** Arabic-Indic (٠١٢٣٤٥٦٧٨٩) and Eastern Arabic (۰۱۲۳۴۵۶۷۸۹) digits. */
const NON_ASCII_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

/**
 * Fold Arabic-Indic digits to ASCII. Sheets typed in Arabic routinely carry
 * "٠٥٥١٢٣٤٥٦٧" in the phone column, and a digit that cannot be parsed is an
 * order that cannot be delivered.
 */
export function foldDigits(raw: string): string {
  return raw.replace(NON_ASCII_DIGITS, (digit) =>
    String(digit.charCodeAt(0) % 16 === 0 ? 0 : (digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660))),
  );
}

/**
 * Fold a header cell into something comparable: no accents, no Arabic diacritics
 * or tatweel, alef/ya/ta-marbuta unified, every separator removed, lowercased.
 * "رقم الهاتف" and "رقمالهاتف" and "Phone Number" all end up as stable keys.
 */
export function normalizeHeaderKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return foldDigits(raw)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(ARABIC_DIACRITICS, "")
    .replace(ARABIC_TATWEEL, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/[\s\-_.:/\\()[\]{}"'`*#+=|,;!?~^@$%&<>]/g, "");
}

export interface ImportMapping {
  /** field key → column index in the sheet's row arrays. */
  columns: Partial<Record<OrderImportFieldKey, number>>;
  /** Header text as the merchant wrote it, per mapped field. */
  headers: Partial<Record<OrderImportFieldKey, string>>;
  /** Columns that matched nothing — shown so a typo'd header is visible. */
  unmapped: Array<{ index: number; header: string }>;
  /** Required fields with no column — the sheet cannot be imported as-is. */
  missingRequired: OrderImportFieldKey[];
}

/**
 * Auto-map a header row onto the import fields.
 *
 * Two passes so a short alias never steals a column from a longer, better one:
 * first exact normalized matches, then "contains" matches for headers that carry
 * decoration ("رقم الهاتف (مطلوب)", "Phone Number 1"). A column is claimed by at
 * most one field, best match first.
 */
export function detectImportMapping(headers: unknown[]): ImportMapping {
  const normalized = headers.map((header) => normalizeHeaderKey(header));
  const columns: ImportMapping["columns"] = {};
  const headerText: ImportMapping["headers"] = {};
  const claimed = new Set<number>();

  const claim = (key: OrderImportFieldKey, index: number) => {
    columns[key] = index;
    headerText[key] = String(headers[index] ?? "").trim();
    claimed.add(index);
  };

  for (const field of ORDER_IMPORT_FIELDS) {
    const index = normalized.findIndex(
      (value, position) => !claimed.has(position) && field.aliases.includes(value),
    );
    if (index >= 0) claim(field.key, index);
  }

  for (const field of ORDER_IMPORT_FIELDS) {
    if (columns[field.key] !== undefined) continue;
    // Longest alias first: "phonenumber" must win over "phone" when the sheet
    // has both a "Phone Number" and a bare "Phone" column.
    const aliases = [...field.aliases].sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      const index = normalized.findIndex(
        (value, position) =>
          !claimed.has(position) && value.length > alias.length && value.includes(alias),
      );
      if (index >= 0) {
        claim(field.key, index);
        break;
      }
    }
  }

  const unmapped = headers
    .map((header, index) => ({ index, header: String(header ?? "").trim() }))
    .filter((entry) => !claimed.has(entry.index) && entry.header.length > 0);

  const missingRequired = ORDER_IMPORT_FIELDS.filter(
    (field) => field.required && columns[field.key] === undefined,
  ).map((field) => field.key);

  return { columns, headers: headerText, unmapped, missingRequired };
}

// ─── Cell coercion ────────────────────────────────────────────────────────────

/** Text out of a cell — spreadsheets hand us numbers and booleans too. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    // A phone stored as the number 551234567 has already lost its leading zero
    // in the sheet itself — nothing here can restore it, but at least the text
    // stays stable and never turns into 1.23e+11.
    return foldDigits(String(value));
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value instanceof Date) return value.toISOString();
  return foldDigits(String(value).trim());
}

/**
 * Money out of a cell. Accepts "2 500 DA", "2,500.00", "2.500,00" and plain
 * numbers — Algerian sheets mix the French grouping convention with the
 * English one, and rejecting a valid price is worse than guessing.
 */
export function cellMoney(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
  }
  const text = cellText(value)
    .replace(/[^\d.,\-]/g, "")
    .trim();
  if (!text) return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  let normalized = text;
  if (lastComma > lastDot) {
    // "2.500,00" → comma is the decimal separator.
    normalized = text.replace(/\./g, "").replace(",", ".");
  } else if (lastDot >= 0) {
    // "2,500.00" → commas are grouping.
    normalized = text.replace(/,/g, "");
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100) / 100;
}

/** Quantity out of a cell — integers only, 1..999, defaults handled by caller. */
export function cellQuantity(value: unknown): number | null {
  if (value === null || value === undefined || cellText(value) === "") return null;
  const parsed = cellMoney(value);
  if (parsed === null) return null;
  const quantity = Math.round(parsed);
  return quantity >= 1 && quantity <= 999 ? quantity : null;
}

const HOME_WORDS = ["home", "door", "domicile", "maison", "livraison", "المنزل", "منزل", "باب", "توصيل للمنزل"];
const STOP_DESK_WORDS = [
  "stopdesk", "stop", "desk", "pickup", "pick", "point", "bureau", "agence",
  "relais", "المكتب", "مكتب", "نقطة", "وقف", "استلام",
];

/** Delivery type out of free text; null when the sheet says nothing usable. */
export function cellDeliveryType(value: unknown): "home" | "stop_desk" | null {
  const key = normalizeHeaderKey(cellText(value));
  if (!key) return null;
  if (STOP_DESK_WORDS.some((word) => key.includes(normalizeHeaderKey(word)))) return "stop_desk";
  if (HOME_WORDS.some((word) => key.includes(normalizeHeaderKey(word)))) return "home";
  return null;
}

/**
 * Pick the header row. Merchants export sheets with a title or a blank row
 * above the real headers, and a header row is recognizable: it is mostly text,
 * and it matches at least one known column.
 */
export function detectHeaderRowIndex(rows: unknown[][], maxScan = 5): number {
  let best = 0;
  let bestScore = -1;
  for (let index = 0; index < Math.min(maxScan, rows.length); index += 1) {
    const row = rows[index] ?? [];
    const filled = row.filter((cell) => cellText(cell) !== "").length;
    if (filled < 2) continue;
    const mapping = detectImportMapping(row);
    const score = ORDER_IMPORT_FIELD_KEYS.filter(
      (key) => mapping.columns[key] !== undefined,
    ).length;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

/** A ready-to-paste CSV header line for the import template download. */
export function importTemplateHeaders(): string[] {
  return [
    "customerName",
    "phone",
    "wilaya",
    "commune",
    "address",
    "productName",
    "productSku",
    "variantLabel",
    "quantity",
    "price",
    "deliveryFee",
    "deliveryType",
    "notes",
    "externalReference",
  ];
}
