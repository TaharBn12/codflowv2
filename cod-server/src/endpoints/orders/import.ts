/**
 * Spreadsheet → orders import.
 *
 * POST /orders/import (multipart/form-data)
 *
 * The merchant arrives with a Facebook-page export, a Google Sheet, or a
 * colleague's Excel file. The endpoint's job is to turn that into real orders
 * without the merchant re-typing 200 rows — and, just as importantly, to refuse
 * loudly when it cannot.
 *
 * Two-phase by design:
 *   • `dryRun=true` parses, maps, resolves and validates, then reports. Nothing
 *     is written. This is what the dashboard shows before the merchant commits,
 *     including the detected column mapping so a wrong guess is fixable.
 *   • `dryRun=false` creates orders for the valid rows in `[offset, offset+limit)`.
 *     Paging keeps a 2 000-row sheet out of a single Worker invocation; the
 *     dashboard walks the pages and shows progress.
 *
 * Every order goes through the same `createOrder` query the dashboard uses, so
 * stock deduction, customer auto-creation, confirmation auto-assignment — and
 * the blacklist skip — behave identically. An imported order is not a special
 * kind of order.
 *
 * Money rule: the sheet's price wins. Merchants import promo prices and
 * negotiated totals that the catalog does not know about; silently substituting
 * the catalog price would change what a driver collects at the door.
 */

import { Context } from "hono";
import type { AppContext } from "@/types";
import { getDb } from "@/db";
import { communes, productVariants, products, wilayas } from "@/db/schema";
import { inArray, isNull } from "drizzle-orm";
import * as queries from "./queries";
import { resolveDeliveryFee } from "./resolve-fee";
import { findOrCreateCustomer } from "../../../../cod-shared/queries/store";
import { findActiveBlacklistReasonsByPhone } from "../../../../cod-shared/queries/blacklist";
import { countRecentOrdersByPhone } from "../../../../cod-shared/queries/orders";
import { toLocalAlgerianMobile } from "../../../../cod-shared/lib/phone";
import {
  cellDeliveryType,
  cellMoney,
  cellQuantity,
  cellText,
  detectHeaderRowIndex,
  detectImportMapping,
  normalizeHeaderKey,
  ORDER_IMPORT_FIELDS,
  type ImportMapping,
  type OrderImportFieldKey,
} from "../../../../cod-shared/lib/order-import";
import {
  SPREADSHEET_MAX_ROWS,
  SpreadsheetError,
  readSpreadsheet,
} from "@/lib/spreadsheet";
import { logActivity, ACTIONS } from "@/lib/activity";
import { ValidationError } from "@/lib/errors/classes";
import { ERROR_CODES } from "../../../../cod-shared/errors/codes";

/** Rows created per commit call — the Worker CPU budget, not an arbitrary cap. */
export const IMPORT_BATCH_LIMIT = 100;
/** Rows described in a dry-run preview (the rest are counted, not listed). */
const PREVIEW_ROWS = 50;

export interface ImportRowIssue {
  /** 1-based spreadsheet row number, as the merchant sees it in Excel. */
  row: number;
  field: OrderImportFieldKey | "sheet" | "product";
  code:
    | "MISSING_REQUIRED_COLUMN"
    | "EMPTY_ROW"
    | "INVALID_NAME"
    | "INVALID_PHONE"
    | "WILAYA_NOT_FOUND"
    | "COMMUNE_NOT_FOUND"
    | "ADDRESS_REQUIRED"
    | "INVALID_PRICE"
    | "INVALID_QUANTITY"
    | "PRODUCT_NOT_FOUND"
    | "VARIANT_REQUIRED"
    | "BLACKLISTED_PHONE"
    | "DUPLICATE_IN_SHEET"
    | "DUPLICATE_RECENT_ORDER"
    | "CREATION_FAILED";
  severity: "error" | "warning";
  message: string;
  value?: string;
}

export interface ImportRowPreview {
  row: number;
  valid: boolean;
  customerName: string | null;
  phone: string | null;
  wilayaId: number | null;
  wilaya: string | null;
  communeId: string | null;
  commune: string | null;
  address: string | null;
  productId: string | null;
  productName: string | null;
  variantLabel: string | null;
  quantity: number;
  price: number | null;
  deliveryFee: number | null;
  deliveryType: "home" | "stop_desk";
  notes: string | null;
  externalReference: string | null;
  issues: ImportRowIssue[];
}

interface ImportOptions {
  dryRun: boolean;
  offset: number;
  limit: number;
  orderType: "online" | "offline";
  fallbackProductId: string | null;
  sheetName: string | null;
  /** Explicit field → column index overrides from the mapping picker. */
  mapping: Partial<Record<OrderImportFieldKey, number>> | null;
}

// ─── Reference lookups ────────────────────────────────────────────────────────

interface WilayaRef {
  id: number;
  name: string;
}
interface CommuneRef {
  id: string;
  name: string;
}
interface ProductRef {
  id: string;
  name: string;
  hasVariants: boolean;
  trackInventory: boolean;
}

interface ReferenceData {
  wilayaById: Map<number, WilayaRef>;
  wilayaByName: Map<string, WilayaRef>;
  communesByWilaya: Map<number, Map<string, CommuneRef>>;
  productByName: Map<string, ProductRef>;
  productBySku: Map<string, ProductRef>;
  productById: Map<string, ProductRef>;
  variantsByProduct: Map<string, Array<{ id: string; label: string; sku: string | null }>>;
}

async function loadReferenceData(db: ReturnType<typeof getDb>): Promise<ReferenceData> {
  const [wilayaRows, communeRows, productRows] = await Promise.all([
    db.select({ id: wilayas.id, name: wilayas.name, nameAr: wilayas.nameAr }).from(wilayas).all(),
    db
      .select({ id: communes.id, wilayaId: communes.wilayaId, name: communes.name, nameAr: communes.nameAr })
      .from(communes)
      .all(),
    db
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        hasVariants: products.hasVariants,
        trackInventory: products.trackInventory,
      })
      .from(products)
      .where(isNull(products.deletedAt))
      .all(),
  ]);

  const reference: ReferenceData = {
    wilayaById: new Map(),
    wilayaByName: new Map(),
    communesByWilaya: new Map(),
    productByName: new Map(),
    productBySku: new Map(),
    productById: new Map(),
    variantsByProduct: new Map(),
  };

  for (const row of wilayaRows) {
    const wilaya = { id: row.id, name: row.nameAr };
    reference.wilayaById.set(row.id, wilaya);
    reference.wilayaByName.set(normalizeHeaderKey(row.nameAr), wilaya);
    reference.wilayaByName.set(normalizeHeaderKey(row.name), wilaya);
    reference.wilayaByName.set(String(row.id), wilaya);
  }

  for (const row of communeRows) {
    const commune = { id: row.id, name: row.nameAr };
    let bucket = reference.communesByWilaya.get(row.wilayaId);
    if (!bucket) {
      bucket = new Map();
      reference.communesByWilaya.set(row.wilayaId, bucket);
    }
    bucket.set(normalizeHeaderKey(row.nameAr), commune);
    bucket.set(normalizeHeaderKey(row.name), commune);
  }

  for (const row of productRows) {
    const product: ProductRef = {
      id: row.id,
      name: row.name,
      hasVariants: Boolean(row.hasVariants),
      trackInventory: Boolean(row.trackInventory),
    };
    reference.productById.set(row.id, product);
    reference.productByName.set(normalizeHeaderKey(row.name), product);
    if (row.sku) reference.productBySku.set(normalizeHeaderKey(row.sku), product);
  }

  const variantProducts = productRows.filter((row) => row.hasVariants).map((row) => row.id);
  if (variantProducts.length > 0) {
    const variantRows = await db
      .select({
        productId: productVariants.productId,
        id: productVariants.id,
        variations: productVariants.variations,
        sku: productVariants.sku,
      })
      .from(productVariants)
      .where(inArray(productVariants.productId, variantProducts))
      .all();

    for (const row of variantRows) {
      const label = variantLabel(row.variations);
      const bucket = reference.variantsByProduct.get(row.productId) ?? [];
      bucket.push({ id: row.id, label, sku: row.sku });
      reference.variantsByProduct.set(row.productId, bucket);
    }
  }

  return reference;
}

/** "أحمر / XL" out of the stored variations JSON — same shape the UI uses. */
function variantLabel(variations: string | null): string {
  if (!variations) return "";
  try {
    const parsed = JSON.parse(variations) as Record<string, unknown>;
    return Object.values(parsed)
      .map((value) => String(value))
      .join(" / ");
  } catch {
    return "";
  }
}

// ─── Request parsing ──────────────────────────────────────────────────────────

function parseOptions(form: FormData): ImportOptions {
  const raw = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value.trim() : "";
  };

  const limit = Number(raw("limit") || IMPORT_BATCH_LIMIT);
  const offset = Number(raw("offset") || 0);

  let mapping: ImportOptions["mapping"] = null;
  const mappingRaw = raw("mapping");
  if (mappingRaw) {
    try {
      const parsed = JSON.parse(mappingRaw) as Record<string, unknown>;
      mapping = {};
      for (const field of ORDER_IMPORT_FIELDS) {
        const value = parsed[field.key];
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
          mapping[field.key] = value;
        }
      }
    } catch {
      throw new ValidationError(
        "mapping must be a JSON object of field → column index",
        ERROR_CODES.INVALID_FORMAT,
      );
    }
  }

  return {
    dryRun: raw("dryRun") === "true" || raw("dryRun") === "1",
    offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0,
    limit: Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), IMPORT_BATCH_LIMIT)
      : IMPORT_BATCH_LIMIT,
    orderType: raw("orderType") === "online" ? "online" : "offline",
    fallbackProductId: raw("fallbackProductId") || null,
    sheetName: raw("sheetName") || null,
    mapping,
  };
}

// ─── Row resolution ───────────────────────────────────────────────────────────

interface DraftRow {
  preview: ImportRowPreview;
  issues: ImportRowIssue[];
  /** Resolved variant id for variant products — null for simple products. */
  variantId: string | null;
}

function buildDrafts(
  tableRows: unknown[][],
  headerIndex: number,
  mapping: ImportMappingColumns,
  reference: ReferenceData,
  fallbackProductId: string | null,
): DraftRow[] {
  const drafts: DraftRow[] = [];
  const seenPhones = new Map<string, number>();

  for (let index = headerIndex + 1; index < tableRows.length; index += 1) {
    const cells = tableRows[index] ?? [];
    const rowNumber = index + 1; // spreadsheet numbering: header row is 1
    const text = (key: OrderImportFieldKey) => {
      const column = mapping.columns[key];
      return column === undefined ? "" : cellText(cells[column]);
    };
    const issues: ImportRowIssue[] = [];
    const push = (issue: Omit<ImportRowIssue, "row">) =>
      issues.push({ ...issue, row: rowNumber });

    const rawName = text("customerName");
    const rawPhone = text("phone");
    const rawPrice = text("price");

    if (!rawName && !rawPhone && !rawPrice && cells.every((cell) => !cellText(cell))) {
      continue; // a genuinely blank line — not an error, sheets have them
    }

    const customerName = rawName.replace(/\s+/g, " ").trim();
    if (customerName.length < 2) {
      push({
        field: "customerName",
        code: "INVALID_NAME",
        severity: "error",
        message: "Customer name is missing or too short",
        value: rawName || undefined,
      });
    }

    const phone = toLocalAlgerianMobile(rawPhone);
    if (!phone) {
      push({
        field: "phone",
        code: "INVALID_PHONE",
        severity: "error",
        message: "Not a valid Algerian mobile number (expected 05/06/07 + 8 digits)",
        value: rawPhone || undefined,
      });
    }

    const wilayaRaw = text("wilaya");
    const wilaya =
      reference.wilayaByName.get(normalizeHeaderKey(wilayaRaw)) ??
      reference.wilayaById.get(Number(wilayaRaw)) ??
      null;
    if (!wilaya) {
      push({
        field: "wilaya",
        code: "WILAYA_NOT_FOUND",
        severity: "error",
        message: "Wilaya not recognised — use the number (1-58) or the official name",
        value: wilayaRaw || undefined,
      });
    }

    const communeRaw = text("commune");
    const commune = wilaya
      ? (reference.communesByWilaya.get(wilaya.id)?.get(normalizeHeaderKey(communeRaw)) ?? null)
      : null;
    if (wilaya && !commune) {
      push({
        field: "commune",
        code: "COMMUNE_NOT_FOUND",
        severity: "error",
        message: `Commune "${communeRaw || "(empty)"}" is not in wilaya ${wilaya.id}`,
        value: communeRaw || undefined,
      });
    }

    const deliveryType = cellDeliveryType(text("deliveryType")) ?? "home";
    const address = text("address").replace(/\s+/g, " ").trim();
    if (deliveryType === "home" && address.length < 3) {
      push({
        field: "address",
        code: "ADDRESS_REQUIRED",
        severity: "error",
        message: "Home delivery needs an address (or set the delivery type to stop desk)",
        value: address || undefined,
      });
    }

    const price = cellMoney(text("price"));
    if (price === null || price <= 0) {
      push({
        field: "price",
        code: "INVALID_PRICE",
        severity: "error",
        message: "Price must be a positive amount",
        value: text("price") || undefined,
      });
    }

    const quantityRaw = text("quantity");
    const quantity = quantityRaw ? cellQuantity(quantityRaw) : 1;
    if (quantity === null) {
      push({
        field: "quantity",
        code: "INVALID_QUANTITY",
        severity: "error",
        message: "Quantity must be a whole number between 1 and 999",
        value: quantityRaw,
      });
    }

    const deliveryFeeRaw = text("deliveryFee");
    const deliveryFee = deliveryFeeRaw ? cellMoney(deliveryFeeRaw) : null;
    if (deliveryFeeRaw && deliveryFee === null) {
      push({
        field: "deliveryFee",
        code: "INVALID_PRICE",
        severity: "warning",
        message: "Delivery fee unreadable — it will be resolved from the shipping profile",
        value: deliveryFeeRaw,
      });
    }

    // ── Product resolution: SKU first, then name, then the merchant's chosen
    // fallback. An order line is a foreign key, so an unknown product cannot be
    // imported as free text — that is what the fallback product is for.
    const productNameRaw = text("productName");
    const productSkuRaw = text("productSku");
    let product: ProductRef | null = null;
    if (productSkuRaw) {
      product = reference.productBySku.get(normalizeHeaderKey(productSkuRaw)) ?? null;
    }
    if (!product && productNameRaw) {
      product = reference.productByName.get(normalizeHeaderKey(productNameRaw)) ?? null;
    }

    if (!product && fallbackProductId) {
      product = reference.productById.get(fallbackProductId) ?? null;
    }
    if (!product) {
      push({
        field: "product",
        code: "PRODUCT_NOT_FOUND",
        severity: "error",
        message: productNameRaw || productSkuRaw
          ? `No catalog product matches "${productNameRaw || productSkuRaw}" — pick a fallback product or add it to the catalog`
          : "No product column and no fallback product selected",
        value: productNameRaw || productSkuRaw || undefined,
      });
    }

    const variantLabelRaw = text("variantLabel");
    let variantId: string | null = null;
    let resolvedVariantLabel: string | null = variantLabelRaw || null;
    if (product?.hasVariants) {
      const variants = reference.variantsByProduct.get(product.id) ?? [];
      const wanted = normalizeHeaderKey(variantLabelRaw);
      const match = wanted
        ? variants.find(
            (variant) =>
              normalizeHeaderKey(variant.label) === wanted ||
              (variant.sku && normalizeHeaderKey(variant.sku) === wanted),
          ) ??
          variants.find((variant) => wanted && normalizeHeaderKey(variant.label).includes(wanted))
        : null;
      if (match) {
        variantId = match.id;
        resolvedVariantLabel = match.label;
      } else {
        push({
          field: "variantLabel",
          code: "VARIANT_REQUIRED",
          severity: "error",
          message: `"${product.name}" has variants — the sheet must name one of: ${variants
            .map((variant) => variant.label)
            .filter(Boolean)
            .slice(0, 6)
            .join(" | ") || "(none loaded)"}`,
          value: variantLabelRaw || undefined,
        });
      }
    }

    if (phone) {
      const firstSeen = seenPhones.get(phone);
      if (firstSeen !== undefined) {
        push({
          field: "phone",
          code: "DUPLICATE_IN_SHEET",
          severity: "warning",
          message: `Same phone as row ${firstSeen} in this sheet`,
          value: phone,
        });
      } else {
        seenPhones.set(phone, rowNumber);
      }
    }

    const valid = !issues.some((issue) => issue.severity === "error");
    drafts.push({
      variantId,
      issues,
      preview: {
        row: rowNumber,
        valid,
        customerName: customerName || null,
        phone,
        wilayaId: wilaya?.id ?? null,
        wilaya: wilaya?.name ?? null,
        communeId: commune?.id ?? null,
        commune: commune?.name ?? null,
        address: address || null,
        productId: product?.id ?? null,
        productName: productNameRaw || product?.name || null,
        variantLabel: resolvedVariantLabel,
        quantity: quantity ?? 1,
        price,
        deliveryFee,
        deliveryType,
        notes: text("notes") || null,
        externalReference: text("externalReference") || null,
        issues,
      },
    });
  }

  return drafts;
}

type ImportMappingColumns = ImportMapping;

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function importOrders(c: Context<AppContext>) {
  const db = getDb(c.env.DB);
  const actor = c.get("user");
  const options = await readImportRequest(c);

  let tables;
  try {
    tables = readSpreadsheet(options.bytes, {
      filename: options.filename,
      sheetName: options.parsed.sheetName ?? undefined,
      maxRows: SPREADSHEET_MAX_ROWS,
    });
  } catch (err) {
    if (err instanceof SpreadsheetError) {
      throw new ValidationError(err.message, ERROR_CODES.INVALID_FILE_TYPE, { code: err.code });
    }
    throw err;
  }

  const table = tables[0];
  const headerIndex = detectHeaderRowIndex(table.rows);
  const headers = (table.rows[headerIndex] ?? []).map((header) => cellText(header));
  const detected = detectImportMapping(headers);

  // An explicit mapping from the UI wins over detection, field by field. The
  // required-column check runs on the merged result, so fixing one wrong guess
  // in the picker is enough to make the sheet importable.
  const columns = { ...detected.columns, ...(options.parsed.mapping ?? {}) };
  const mapping: ImportMapping = {
    ...detected,
    columns,
    missingRequired: ORDER_IMPORT_FIELDS.filter(
      (field) => field.required && columns[field.key] === undefined,
    ).map((field) => field.key),
  };

  if (mapping.missingRequired.length > 0) {
    return c.json(
      {
        success: false,
        error: `Missing required column(s): ${mapping.missingRequired.join(", ")}`,
        code: ERROR_CODES.REQUIRED_FIELD_MISSING,
        data: {
          sheetName: table.sheetName,
          sheetNames: tables.map((sheet) => sheet.sheetName),
          headers,
          headerRow: headerIndex + 1,
          mapping,
          rows: [],
          totals: emptyTotals(),
        },
      },
      422,
    );
  }

  const reference = await loadReferenceData(db);
  const drafts = buildDrafts(
    table.rows,
    headerIndex,
    mapping,
    reference,
    options.parsed.fallbackProductId,
  );

  // Batch risk lookups — one query each for the whole sheet, not one per row.
  const phones = drafts
    .map((draft) => draft.preview.phone)
    .filter((phone): phone is string => Boolean(phone));
  const [blacklistReasons, recentCounts] = await Promise.all([
    findActiveBlacklistReasonsByPhone(db, phones),
    countRecentOrdersByPhone(db, phones),
  ]);

  for (const draft of drafts) {
    const phone = draft.preview.phone;
    if (!phone) continue;
    if (blacklistReasons.has(phone)) {
      draft.issues.push({
        row: draft.preview.row,
        field: "phone",
        code: "BLACKLISTED_PHONE",
        severity: "warning",
        message: `This number is blacklisted${
          blacklistReasons.get(phone) ? `: ${blacklistReasons.get(phone)}` : ""
        } — the order will be created but kept out of the confirmation queue`,
        value: phone,
      });
      draft.preview.issues = draft.issues;
    }
    const recent = recentCounts.get(phone) ?? 0;
    if (recent > 0) {
      draft.issues.push({
        row: draft.preview.row,
        field: "phone",
        code: "DUPLICATE_RECENT_ORDER",
        severity: "warning",
        message: `This customer already has ${recent} order(s) in the last 48h`,
        value: phone,
      });
      draft.preview.issues = draft.issues;
    }
  }

  const validDrafts = drafts.filter((draft) => draft.preview.valid);
  const totals = {
    rowsInSheet: table.rows.length - headerIndex - 1,
    parsed: drafts.length,
    valid: validDrafts.length,
    invalid: drafts.length - validDrafts.length,
    warnings: drafts.filter((draft) =>
      draft.issues.some((issue) => issue.severity === "warning"),
    ).length,
    created: 0,
    failed: 0,
  };

  const envelope = {
    dryRun: options.parsed.dryRun,
    sheetName: table.sheetName,
    sheetNames: tables.map((sheet) => sheet.sheetName),
    truncated: table.truncated,
    headers,
    headerRow: headerIndex + 1,
    mapping,
    totals,
  };

  if (options.parsed.dryRun) {
    return c.json(
      {
        success: true,
        data: {
          ...envelope,
          rows: drafts.slice(0, PREVIEW_ROWS).map((draft) => draft.preview),
          nextOffset: validDrafts.length > 0 ? 0 : null,
          createdOrders: [],
        },
      },
      200,
    );
  }

  const batch = validDrafts.slice(options.parsed.offset, options.parsed.offset + options.parsed.limit);
  const createdOrders: Array<{ row: number; orderId: string; orderNumber: string }> = [];
  const failures: ImportRowIssue[] = [];

  for (const [position, draft] of batch.entries()) {
    const preview = draft.preview;
    try {
      const created = await createImportedOrder(db, draft, {
        orderType: options.parsed.orderType,
        sequence: options.parsed.offset + position,
        actor,
      });
      createdOrders.push({ row: preview.row, ...created });
    } catch (err) {
      failures.push({
        row: preview.row,
        field: "sheet",
        code: "CREATION_FAILED",
        severity: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  totals.created = createdOrders.length;
  totals.failed = failures.length;

  if (createdOrders.length > 0) {
    await logActivity(
      db,
      actor,
      ACTIONS.ORDERS_IMPORTED,
      { type: "order", id: "import", label: `${createdOrders.length} orders` },
      {
        source: options.filename,
        sheet: table.sheetName,
        created: createdOrders.length,
        failed: failures.length,
        offset: options.parsed.offset,
        orderType: options.parsed.orderType,
      },
    );
  }

  const nextOffset =
    options.parsed.offset + batch.length < validDrafts.length
      ? options.parsed.offset + batch.length
      : null;

  return c.json(
    {
      success: true,
      data: {
        ...envelope,
        rows: batch.map((draft) => draft.preview),
        failures,
        createdOrders,
        nextOffset,
      },
    },
    200,
  );
}

function emptyTotals() {
  return {
    rowsInSheet: 0,
    parsed: 0,
    valid: 0,
    invalid: 0,
    warnings: 0,
    created: 0,
    failed: 0,
  };
}

/** Multipart upload + the import options that travel beside the file. */
async function readImportRequest(c: Context<AppContext>) {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new ValidationError(
      "Expected multipart/form-data with a `file` field",
      ERROR_CODES.INVALID_FORMAT,
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ValidationError(
      "A spreadsheet file is required in the `file` field",
      ERROR_CODES.REQUIRED_FIELD_MISSING,
    );
  }

  return {
    filename: file.name || "import.xlsx",
    bytes: await file.arrayBuffer(),
    parsed: parseOptions(form),
  };
}

/**
 * Create one imported order through the shared query — the same path the
 * dashboard's manual order form uses, so stock, customer stats, confirmation
 * assignment and the blacklist skip all behave identically.
 */
async function createImportedOrder(
  db: ReturnType<typeof getDb>,
  draft: DraftRow,
  opts: {
    orderType: "online" | "offline";
    sequence: number;
    actor: { id: string; name?: string | null; role: string };
  },
): Promise<{ orderId: string; orderNumber: string }> {
  const preview = draft.preview;
  if (
    !preview.customerName ||
    !preview.phone ||
    preview.wilayaId === null ||
    !preview.communeId ||
    !preview.productId ||
    preview.price === null
  ) {
    // Defensive: buildDrafts already refused these rows.
    throw new ValidationError(`Row ${preview.row} is not importable`, ERROR_CODES.VALIDATION_FAILED);
  }

  const now = new Date().toISOString();

  let deliveryFee = preview.deliveryFee ?? 0;
  if (preview.deliveryFee === null) {
    try {
      const resolved = await resolveDeliveryFee(db, {
        wilayaId: preview.wilayaId,
        communeId: preview.communeId,
        deliveryType: preview.deliveryType,
        productIds: [preview.productId],
      });
      deliveryFee = resolved.deliveryFee;
    } catch {
      // An uncovered commune must not fail a whole sheet: the merchant imported
      // these orders knowingly, so the fee falls back to 0 and stays editable.
      deliveryFee = 0;
    }
  }

  const customer = await findOrCreateCustomer(db, {
    phone: preview.phone,
    name: preview.customerName,
    wilayaId: preview.wilayaId,
    communeId: preview.communeId,
  });

  const orderId = crypto.randomUUID();
  const orderNumber = importOrderNumber(opts.sequence, now);
  const quantity = preview.quantity;
  const pricePerUnit = Math.round((preview.price / quantity) * 100) / 100;

  await queries.createOrder(
    db,
    {
      id: orderId,
      orderNumber,
      customerId: customer.id,
      customerName: preview.customerName,
      phone: preview.phone,
      wilayaId: preview.wilayaId,
      communeId: preview.communeId,
      city: preview.commune,
      address: preview.address,
      price: preview.price,
      notes: preview.notes,
      status: "new",
      orderType: opts.orderType,
      driverId: null,
      companyId: null,
      deliveryType: preview.deliveryType,
      deliveryFee,
      codAmount: preview.price + deliveryFee,
      photos: null,
      externalOrderId: preview.externalReference,
      createdAt: now,
      updatedAt: now,
    },
    [
      {
        id: crypto.randomUUID(),
        orderId,
        productId: preview.productId,
        productName: preview.productName ?? "Imported product",
        variantId: draft.variantId,
        variantLabel: preview.variantLabel,
        quantity,
        pricePerUnit,
        lineTotal: preview.price,
        createdAt: now,
      },
    ],
    { id: opts.actor.id, name: opts.actor.name ?? "Import" },
  );

  return { orderId, orderNumber };
}

/**
 * ORD-YYYYMMDD-NNNN with a sequence-derived suffix.
 *
 * A random suffix per row would collide inside a 100-row batch often enough to
 * matter (birthday problem over 10 000 values), and `order_number` is UNIQUE —
 * so the suffix walks forward from a random start instead.
 */
function importOrderNumber(sequence: number, now: string): string {
  const dateStr = now.split("T")[0].replace(/-/g, "");
  const base = IMPORT_NUMBER_BASE;
  return `ORD-${dateStr}-${String((base + sequence) % 10000).padStart(4, "0")}`;
}

/** Per-request random start, fixed for the whole batch (see importOrderNumber). */
const IMPORT_NUMBER_BASE = Math.floor(Math.random() * 9000) + 500;
