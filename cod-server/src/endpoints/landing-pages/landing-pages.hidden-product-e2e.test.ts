/**
 * Landing Pages — store-hidden products: the showInStore=false contract.
 *
 * A product hidden from the storefront catalog (showInStore=false) is a
 * landing-page-only product: its published LP renders and sells as normal,
 * while the catalog list and the product's own store page stay hidden.
 * Proven end-to-end on real D1 through the real store router.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppContext } from "@/types";
import { errorHandler } from "@/middleware/error";
import { openApiValidationHook } from "@/openapi/validation-hook";
import { storeAuthMiddleware } from "@/middleware/storeAuth";
import storeRouter from "../store/routes";
import * as schema from "@/db/schema";
import type { AppDb } from "@/db";

let db: AppDb;
let rawD1: D1Database;
let app: OpenAPIHono<AppContext>;
const STORE_KEY = "store-key-hidden-test";

beforeAll(async () => {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    d1Databases: { DB: "test-db" },
  });
  rawD1 = await mf.getD1Database("DB");
  const dir = resolve(__dirname, "../../db/migrations");
  const prepared: D1PreparedStatement[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const statements = readFileSync(`${dir}/${file}`, "utf8")
      .split("--> statement-breakpoint")
      .flatMap((s) => s.split(/;\s*\n/))
      .map((s) => s.replace(/;+\s*$/, "").trim())
      .filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
    for (const statement of statements) prepared.push(rawD1.prepare(statement));
  }
  for (let i = 0; i < prepared.length; i += 50) {
    await rawD1.batch(prepared.slice(i, i + 50));
  }
  db = drizzle(rawD1 as unknown as D1Database, { schema }) as unknown as AppDb;

  app = new OpenAPIHono<AppContext>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.env = { DB: rawD1 as any } as any;
    await next();
  });
  app.use("/store/*", storeAuthMiddleware);
  app.onError(errorHandler);
  app.route("/store", storeRouter);

  registry.push(mf);
}, 120_000);

const registry: Miniflare[] = [];
afterAll(async () => {
  for (const mf of registry) await mf.dispose();
});

const NOW = () => new Date().toISOString();
let seq = 0;

const STORE_HEADERS = { "X-Store-API-Key": STORE_KEY };

async function getAndSettle(path: string): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
    props: {} as Record<string, unknown>,
  };
  const res = await app.request(path, { headers: STORE_HEADERS }, undefined, executionCtx);
  await Promise.allSettled(pending);
  return res;
}

async function postAndSettle(path: string, body: unknown): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
    props: {} as Record<string, unknown>,
  };
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: { ...STORE_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    undefined,
    executionCtx,
  );
  await Promise.allSettled(pending);
  return res;
}

async function sha256hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seedStore(): Promise<string> {
  await db.insert(schema.stores).values({
    id: "store-hidden-1", name: "Hidden Product Store", lang: "ar", currency: "DZD",
    currencySymbol: "دج", createdAt: NOW(), updatedAt: NOW(),
  });
  await db.insert(schema.storeApiKeys).values({
    id: "sak-hidden-1", storeId: "store-hidden-1",
    keyHash: await sha256hex(STORE_KEY), name: "test",
    createdAt: NOW(),
  });
  return "store-hidden-1";
}

async function seedProduct(opts: { showInStore: boolean }): Promise<{ id: string; handle: string }> {
  const id = `prod-hid-${++seq}`;
  const handle = `hid-product-${seq}`;
  await db.insert(schema.products).values({
    id, name: `HID Product ${seq}`, handle, price: 5000,
    sku: `HID-SKU-${seq}`,
    hasVariants: false, inventory: 10, trackInventory: true, lowStockThreshold: 2,
    status: "ACTIVE", visibility: true, showInStore: opts.showInStore, storeFeatured: false,
    createdAt: NOW(), updatedAt: NOW(),
  });
  return { id, handle };
}

async function seedPublishedLp(slug: string, productId: string) {
  const now = NOW();
  await db.insert(schema.landingPages).values({
    id: slug, slug, name: `LP ${slug}`, productId, status: "published",
    publishedAt: now, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.landingPageImages).values({
    id: `${slug}-img-1`, landingPageId: slug,
    r2Key: `landing/${slug}-1.jpg`, src: `https://m.example/${slug}-1.jpg`,
    altText: "صورة 1", source: "upload", position: 1, createdAt: now,
  });
}

describe("store-hidden products (showInStore=false) — landing pages keep selling", () => {
  beforeAll(async () => {
    await seedStore();
  });

  it("a store-hidden product renders on its published LP in the full product shape", async () => {
    const { id, handle } = await seedProduct({ showInStore: false });
    await seedPublishedLp("hidden-live", id);

    const res = await getAndSettle("/store/landing-pages/hidden-live");
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.data.product).toMatchObject({
      id, handle, price: 5000, inventory: 10, showInStore: false,
    });
    expect(Array.isArray(body.data.product.offers)).toBe(true);
  });

  it("the same product is absent from the catalog list while visible products remain", async () => {
    const hidden = await seedProduct({ showInStore: false });
    const visible = await seedProduct({ showInStore: true });

    const res = await getAndSettle("/store/products?limit=100");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const handles = body.data.map((p: any) => p.handle);

    expect(handles).toContain(visible.handle);
    expect(handles).not.toContain(hidden.handle);
  });

  it("the hidden product's own store page 404s", async () => {
    const { handle } = await seedProduct({ showInStore: false });

    const res = await getAndSettle(`/store/products/${handle}`);
    expect(res.status).toBe(404);
  });

  it("orders for the hidden product via its LP succeed — catalog price, attribution, stock", async () => {
    const { id, handle } = await seedProduct({ showInStore: false });
    await seedPublishedLp("hidden-order", id);

    const res = await postAndSettle("/store/orders", {
      customerName: "Hidden Product Buyer",
      phone: "0555987654",
      wilayaId: 16,
      communeId: "c-16-001",
      address: "x",
      deliveryType: "home",
      productId: id,
      productName: `HID Product ${seq}`,
      quantity: 2,
      pricePerUnit: 5000,
      landingPageSlug: "hidden-order",
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.data.price).toBe(10000);

    const order = await db.select().from(schema.orders)
      .where(eq(schema.orders.id, body.data.orderId)).get();
    expect(order?.landingPageId).toBe("hidden-order");

    const product = await db.select().from(schema.products)
      .where(eq(schema.products.id, id)).get();
    expect(product?.inventory).toBe(8);

    // The handle stays resolvable only through the LP — the store page still 404s.
    const page = await getAndSettle(`/store/products/${handle}`);
    expect(page.status).toBe(404);
  });
});
