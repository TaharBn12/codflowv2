import { Hono } from "hono";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { customerOrderLinks, orderProducts, orders, reviews, stores } from "@/db/schema";
import type { AppContext } from "@/types";
import { updateOrderStatus } from "../../../../cod-shared/queries/orders";

const routes = new Hono<AppContext>();
function escapeHtml(value: unknown) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function customerPage(token: string, data: any) {
  const order = data.order; const statusLabels: Record<string, string> = { new: "جديد", confirmed: "مؤكد", unreachable: "تعذر الاتصال", preparing: "قيد التحضير", ready: "جاهز", assigned: "تم التعيين", dispatched: "تم الشحن", out_for_delivery: "خرج للتوصيل", delivered: "تم التوصيل", returned: "مرتجع", cancelled: "ملغي" }; const products = data.products.map((item: any) => `<li><b>${escapeHtml(item.productName)}</b> × ${item.quantity}${item.variantLabel ? ` <small>${escapeHtml(item.variantLabel)}</small>` : ""}</li>`).join("");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>تتبع الطلب ${escapeHtml(order.orderNumber)}</title><style>body{margin:0;background:#f6f7fb;color:#17202a;font-family:system-ui,sans-serif}.wrap{max-width:680px;margin:40px auto;padding:18px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:24px;box-shadow:0 8px 30px #0000000a}h1{font-size:24px} .status{display:inline-block;background:#ede9fe;color:#6d28d9;padding:8px 14px;border-radius:99px;font-weight:700}li{padding:10px 0;border-bottom:1px solid #eee}button{border:0;border-radius:10px;padding:12px 18px;font-weight:700;cursor:pointer;background:#6d28d9;color:white;margin:5px}button.cancel{background:#fee2e2;color:#991b1b}textarea,input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #ddd;border-radius:10px;margin:6px 0}.muted{color:#667085}.hidden{display:none}</style></head><body><main class="wrap"><div class="card"><p class="muted">CodFlow</p><h1>مرحبًا ${escapeHtml(order.customerName)}</h1><p>طلبك <b>${escapeHtml(order.orderNumber)}</b></p><p class="status">${escapeHtml(statusLabels[order.status] ?? order.status)}</p><ul>${products}</ul><p><b>${Number(order.price).toLocaleString("fr-DZ")} دج</b></p>${order.trackingNumber ? `<p>رقم التتبع: <b>${escapeHtml(order.trackingNumber)}</b></p>` : ""}<div id="actions">${data.actions.canConfirm ? '<button data-action="confirm">تأكيد الطلب</button>' : ""}${data.actions.canCancel ? '<button class="cancel" data-action="cancel">إلغاء الطلب</button>' : ""}</div>${data.actions.canReview ? '<section><h2>قيّم تجربة التوصيل</h2><input id="rating" type="number" min="1" max="5" value="5"><textarea id="review" placeholder="اكتب تقييمك"></textarea><button data-action="review">إرسال التقييم</button></section>' : ""}<p id="result" class="muted"></p></div></main><script>document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{const action=b.dataset.action;const payload={action};if(action==='review'){payload.rating=Number(document.querySelector('#rating').value);payload.body=document.querySelector('#review').value}b.disabled=true;const r=await fetch('/customer-order/${encodeURIComponent(token)}/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});document.querySelector('#result').textContent=r.ok?'تم حفظ طلبك بنجاح':'تعذر تنفيذ العملية';if(r.ok)setTimeout(()=>location.reload(),700);else b.disabled=false})</script></body></html>`;
}

async function hashToken(token: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))).map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function resolve(c: any) {
  const db = getDb(c.env.DB); const tokenHash = await hashToken(c.req.param("token")); const now = new Date().toISOString();
  const link = await db.select().from(customerOrderLinks).where(and(eq(customerOrderLinks.tokenHash, tokenHash), isNull(customerOrderLinks.revokedAt), gt(customerOrderLinks.expiresAt, now))).get();
  if (!link) return null; const order = await db.select({ id: orders.id, orderNumber: orders.orderNumber, customerName: orders.customerName, status: orders.status, price: orders.price, trackingNumber: orders.trackingNumber, trackingUrl: orders.trackingUrl, deliveryType: orders.deliveryType, createdAt: orders.createdAt, updatedAt: orders.updatedAt }).from(orders).where(eq(orders.id, link.orderId)).get();
  if (!order) return null; await db.update(customerOrderLinks).set({ lastViewedAt: now }).where(eq(customerOrderLinks.id, link.id)); return { db, link, order };
}

routes.get("/:token", async (c) => {
  const value = await resolve(c); if (!value) return c.json({ success: false, code: "LINK_INVALID", error: "This customer link is invalid or expired" }, 404);
  const products = await value.db.select({ id: orderProducts.id, productId: orderProducts.productId, productName: orderProducts.productName, variantLabel: orderProducts.variantLabel, quantity: orderProducts.quantity }).from(orderProducts).where(eq(orderProducts.orderId, value.order.id)).all();
  const existingReview = await value.db.select({ id: reviews.id, rating: reviews.rating, status: reviews.status }).from(reviews).where(eq(reviews.orderId, value.order.id)).get();
  const data = { order: value.order, products, actions: { canConfirm: ["new", "unreachable"].includes(value.order.status), canCancel: ["new", "confirmed", "unreachable"].includes(value.order.status), canReview: value.order.status === "delivered" && !existingReview }, review: existingReview ?? null };
  if (c.req.header("accept")?.includes("text/html")) return c.html(customerPage(c.req.param("token"), data));
  return c.json({ success: true, data });
});

routes.post("/:token/action", async (c) => {
  const parsed = z.discriminatedUnion("action", [z.object({ action: z.literal("confirm") }), z.object({ action: z.literal("cancel") }), z.object({ action: z.literal("review"), rating: z.number().int().min(1).max(5), title: z.string().trim().max(120).optional(), body: z.string().trim().min(2).max(2000) })]).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, code: "VALIDATION_FAILED", error: parsed.error.flatten() }, 400); const value = await resolve(c); if (!value) return c.json({ success: false, code: "LINK_INVALID", error: "This customer link is invalid or expired" }, 404);
  if (parsed.data.action === "confirm") { if (!["new", "unreachable"].includes(value.order.status)) return c.json({ success: false, code: "ACTION_NOT_ALLOWED", error: "Order cannot be confirmed now" }, 409); await updateOrderStatus(value.db, value.order.id, "confirmed", undefined, "Customer"); }
  if (parsed.data.action === "cancel") { if (!["new", "confirmed", "unreachable"].includes(value.order.status)) return c.json({ success: false, code: "ACTION_NOT_ALLOWED", error: "Order cannot be cancelled now" }, 409); await updateOrderStatus(value.db, value.order.id, "cancelled", undefined, "Customer"); }
  if (parsed.data.action === "review") { if (value.order.status !== "delivered") return c.json({ success: false, code: "ACTION_NOT_ALLOWED", error: "Only delivered orders can be reviewed" }, 409); const product = await value.db.select({ productId: orderProducts.productId }).from(orderProducts).where(eq(orderProducts.orderId, value.order.id)).get(); const store = await value.db.select({ id: stores.id, reviewsEnabled: stores.reviewsEnabled }).from(stores).get(); if (!product || !store?.reviewsEnabled) return c.json({ success: false, code: "REVIEWS_DISABLED", error: "Reviews are not available" }, 409); const now = new Date().toISOString(); await value.db.insert(reviews).values({ id: crypto.randomUUID(), storeId: store.id, productId: product.productId, orderId: value.order.id, orderNumber: value.order.orderNumber, customerName: value.order.customerName, rating: parsed.data.rating, title: parsed.data.title ?? null, body: parsed.data.body, status: "pending", helpfulCount: 0, createdAt: now, updatedAt: now }).onConflictDoNothing({ target: reviews.orderId }); }
  return c.json({ success: true });
});

export default routes;
