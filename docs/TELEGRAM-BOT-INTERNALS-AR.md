# كيف يعمل بوت Telegram في CodFlow — شرح تقني مفصّل

هذا المستند يشرح **بالتفصيل** أمرين:

1. كيف يتم **ربط** Telegram بالمتجر (من BotFather حتى ظهور القائمة داخل المحادثة).
2. كيف **بُرمج البوت بالأزرار**: كيف يُبنى الزر، ماذا يحمل من بيانات، وكيف يُنفَّذ
   الإجراء ويُعاد رسم الرسالة.

كل ما هنا مأخوذ من الكود الفعلي في المستودع، مع مسارات الملفات لتتبّعه.

---

## 0) خريطة الملفات

| الملف | الدور |
|---|---|
| `cod-server/src/index.ts` | يركّب `/webhooks/telegram` **قبل** مصادقة `/api/*`، ويشغّل الـ cron |
| `cod-server/src/endpoints/telegram-approvals/routes.ts` | مستقبِل الـ Webhook: سر + JSON + استدعاء الموزّع |
| `cod-server/src/endpoints/telegram-approvals/service.ts` | إعدادات البوت، `setWebhook`, `setMyCommands`, الموافقات |
| `cod-server/src/endpoints/telegram-bot/bot.ts` | **الموزّع**: يقرأ التحديث، يتعرّف على المستخدم، ينفّذ، يرد |
| `cod-server/src/endpoints/telegram-bot/callbacks.ts` | تكويد/فك تكويد `callback_data` (حد 64 بايت) |
| `cod-server/src/endpoints/telegram-bot/keyboards.ts` | بناء لوحات الأزرار (قائمة، نتائج، بطاقة، موافقات…) |
| `cod-server/src/endpoints/telegram-bot/render.ts` | نصوص الرسائل + الهروب من HTML + التنسيق |
| `cod-server/src/endpoints/telegram-bot/i18n.ts` | كل النصوص ar/fr/en + تسميات الحالات |
| `cod-server/src/endpoints/telegram-bot/store.ts` | القراءة/الكتابة: الروابط، الرموز، الجلسات، السجل، الملخصات |
| `cod-server/src/endpoints/telegram-bot/permissions.ts` | `can()` و`allowedStatusTargets()` |
| `cod-server/src/endpoints/telegram-bot/order-queries.ts` | استعلامات الطلبات للبوت (مرشّحات، بحث، تفاصيل) |
| `cod-server/src/endpoints/telegram-bot/reports.ts` | تقارير الفترة/المخزون/المالية/الفريق/العملاء |
| `cod-server/src/endpoints/telegram-bot/notify.ts` | الإشعارات الصادرة، ساعات الهدوء، الملخصات، التقارير المجدولة |
| `cod-server/src/endpoints/telegram-bot/api.ts` | عميل Bot API (send/edit/answer/getMe/setMyCommands + إعادة المحاولة) |
| `cod-server/src/cron/telegram-bot.ts` | صيانة كل 15 دقيقة |
| `cod-server/src/db/migrations/0037_telegram_bot.sql` | 8 جداول + عمودَي التذكير/التصعيد |
| `cod-client-astro/src/features/telegram/` | صفحة `/telegram` في اللوحة (رموز الربط، الحالة، الموافقات) |

---

## 1) القرار المعماري: Webhook لا Polling

Cloudflare Workers لا تحتفظ بعملية حيّة، لذلك لا يمكن استخدام `getUpdates`
(polling). البديل الطبيعي هو **Webhook**: Telegram يدفع كل تحديث كطلب HTTP إلى
عنوانك.

```
مستخدم Telegram
      │  يضغط زراً
      ▼
Telegram Bot API
      │  POST https://<WORKER_SELF_URL>/webhooks/telegram
      │  X-Telegram-Bot-Api-Secret-Token: <secret>
      ▼
index.ts  ──►  telegram-approvals/routes.ts   (سر ← JSON ← استدعاء)
                       │
                       ▼
             bot.ts#handleTelegramUpdate()
                       │
        ┌──────────────┼───────────────┐
        ▼              ▼               ▼
   claimUpdate     loadLinkedUser   handleCallback / handleMessage
   (منع التكرار)   (RBAC + نطاقات)        │
                                           ▼
                              reply() / toast() / audit()
                                           │
                                           ▼
                             Telegram Bot API (edit/send/answer)
```

نقطتان مهمتان في هذا التصميم:

- **`/webhooks/telegram` مركّب قبل `authMiddleware`** في `index.ts` (السطر ~105).
  لا جلسة ولا كوكي هنا؛ الحماية عبر السر + منطق البوت نفسه.
- **الرد دائماً 200** للتحديثات المقبولة. أي كود غير 2xx يجعل Telegram يعيد
  الإرسال، فيتكرّر للمستخدم نفس الرد.

---

## 2) الربط: من BotFather إلى القائمة داخل المحادثة

### 2.1 المرحلة صفر — إنشاء البوت

من `@BotFather`: `/newbot` ← اسم ← معرّف ينتهي بـ`bot` ← يعطيك توكناً مثل
`123456789:AAH...`. هذا التوكن **سرّ كامل الصلاحيات**، لا يُشارك مع أحد ولا
يُخزَّن في الواجهة نصّاً صريحاً (اللوحة تعرض `••••` + آخر 6 أحرف).

### 2.2 حفظ الإعدادات وتوليد سرّ الـ Webhook

المسار: **الإعدادات ← Telegram** ← `PUT /api/operations/telegram/config`.

```ts
// cod-server/src/endpoints/operations/routes.ts
routes.put("/telegram/config", async (c) => {
  if (!isAdmin(c)) return forbidden(c);
  const parsed = z.object({
    botToken: z.string().trim().default(""),
    chatId: z.string().trim().min(1),
    enabled: z.boolean().default(true),
  }).safeParse(await c.req.json());
  ...
  const values = {
    id: "default",
    botToken,
    chatId: parsed.data.chatId,
    enabled: parsed.data.enabled,
    // سرّ يُولَّد مرة واحدة ويُستخدم للتحقق من كل تحديث
    webhookSecret: existing?.webhookSecret ||
      `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", ""),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.insert(telegramApprovalConfig).values(values)
    .onConflictDoUpdate({ target: telegramApprovalConfig.id, set: { ... } });

  if (values.enabled) await configureTelegramWebhook(c.env);
});
```

ترتيب الأولوية في `resolveTelegramConfig`:

1. صفّ اللوحة `telegram_approval_config` (إن كان مفعّلاً وبكامل الحقول).
2. وإلا متغيّرات البيئة: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_APPROVAL_CHAT_ID` +
   `TELEGRAM_WEBHOOK_SECRET`.
3. وإلا `null` ← البوت معطّل وكل المسارات ترفض بأمان.

> فائدة هذا الترتيب: يمكن نشر السر عبر `wrangler secret` للطوارئ، ثم الانتقال
> إلى إعدادات اللوحة دون توقّف.

### 2.3 `setWebhook` + `setMyCommands`

```ts
// cod-server/src/endpoints/telegram-approvals/service.ts
export async function configureTelegramWebhook(env: Env) {
  const config = await resolveTelegramConfig(env);
  if (!config) throw new Error("Telegram approval settings are incomplete");
  const origin = new URL(env.WORKER_SELF_URL).origin;
  const webhookUrl = `${origin}/webhooks/telegram`;

  await telegram(config, "setWebhook", {
    url: webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });

  for (const [languageCode, commands] of Object.entries(commandLists)) {
    try {
      await telegram(config, "setMyCommands", { commands, language_code: languageCode });
    } catch (error) {
      console.warn(`[telegram] setMyCommands(${languageCode}) failed`, error);
    }
  }
  return webhookUrl;
}
```

- `allowed_updates` مقيّد بـ`message` و`callback_query` فقط: لا نستقبل تحديثات
  لا نستهلكها (توفير وتقليل سطح الهجوم).
- `setMyCommands` لكل لغة يجعل قائمة «/» داخل Telegram تظهر بلغة المستخدم.
- فشل الأوامر لا يُفشل تسجيل الـ Webhook (warn فقط) — الـ Webhook هو الأساس.

### 2.4 التحقّق من كل طلب + منع التكرار

```ts
// cod-server/src/endpoints/telegram-approvals/routes.ts
routes.post("/", async (c) => {
  const config = await resolveTelegramConfig(c.env);
  if (!config) return c.json({ ok: false, error: "not_configured" }, 403);
  if (c.req.header("X-Telegram-Bot-Api-Secret-Token") !== config.webhookSecret) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  let update: TelegramUpdate;
  try { update = await c.req.json(); }
  catch { return c.json({ ok: false, error: "invalid_json" }, 400); }

  const result = await handleTelegramUpdate({ env: c.env, waitUntil: ... }, update);
  return c.json({ ok: true, handled: result.handled });  // دائماً 200
});
```

ثم في الموزّع، **قبل** أي عمل:

```ts
// store.ts — إدخال ذرّي: من يفوز بالإدخال يعالج التحديث
const inserted = await db.insert(telegramUpdateLog)
  .values({ updateId: id, telegramUserId, kind, receivedAt: now.toISOString() })
  .onConflictDoNothing()
  .returning({ updateId: telegramUpdateLog.updateId })
  .all();
return inserted.length > 0;
```

لماذا الإدخال وليس «اقرأ ثم أدرج»؟ لأن Telegram يسلّم «على الأقل مرة واحدة»،
وطلبان متزامنان قد يقرآن «غير موجود» معاً ثم يطبّقان تغيير الحالة مرتين.
`INSERT … ON CONFLICT DO NOTHING RETURNING` يجعل السباق محسوماً في قاعدة البيانات.

### 2.5 ربط حساب العضو: رمز لمرة واحدة

**الفكرة:** لا أحد يشارك توكن البوت. المدير يولّد رمزاً لعضو محدّد، والعضو
يستهلكه من حسابه الشخصي.

#### أ) التوليد من اللوحة

`POST /api/operations/telegram/bot/link-codes` ← `createLinkCode`:

```ts
const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بلا O/0/I/1
const ttl = Math.max(5, Math.min(input.ttlMinutes ?? 60, 24 * 60));
const expiresAt = new Date(now.getTime() + ttl * 60_000).toISOString();
await db.insert(telegramLinkCodes).values({ code, userId, createdBy, expiresAt, createdAt });
```

الرمز 8 أحرف من أبجدية بلا حروف متشابهة (تُنسخ يدوياً بلا أخطاء). الاستجابة
تحتوي ثلاثة أشياء جاهزة للنسخ:

```json
{
  "code": "K7QM4XPD",
  "command": "/link K7QM4XPD",
  "deepLink": "https://t.me/codflow_bot?start=K7QM4XPD"
}
```

`deepLink` يعتمد على `getMe` لمعرفة اسم البوت، ويُبنى كـ
`https://t.me/<username>?start=<code>`.

#### ب) الاستهلاك داخل Telegram

العضو يفتح الرابط ← Telegram يرسل `/start K7QM4XPD` ← البوت **غير مرتبط بعد**،
فيمرّ في فرع «غير مرتبط» الذي لا يسمح إلا بالربط:

```ts
if (!link) {
  const parsed = parseCommand((message?.text ?? "").trim());
  if (parsed && (parsed.command === "start" || parsed.command === "link") && parsed.args[0]) {
    await redeemLinkCode(ctx, parsed.args[0]);
    return { handled: true, reason: "linking" };
  }
  ...
  await reply(ctx, renderNotLinked(language));   // شرح كيف يطلب الرمز
}
```

`redeemLinkCode` هو قلب العملية:

```ts
const code = rawCode.trim().toUpperCase();
const record = await peekLinkCode(ctx.db, code);
if (!record || record.usedAt || record.expiresAt < ctx.now.toISOString()) {
  await reply(ctx, botText(ctx.language, "link_invalid"));
  await audit(ctx, "link.failed", { type: "link_code", id: code }, "failed", "invalid_or_expired");
  return;
}
// العضو المستهدف قد يكون مرتبطاً بحساب Telegram آخر بالفعل
if (targetLink && !targetLink.revokedAt && targetLink.telegramUserId !== ctx.telegramUserId) {
  await reply(ctx, botText(ctx.language, "link_target_has_account"));
  return;
}
await markLinkCodeUsed(ctx.db, code, ctx.telegramUserId, ctx.now);   // لمرة واحدة
const link = await linkAccount(ctx.db, { telegramUserId, chatId, userId: record.userId, ... });
```

`linkAccount` يضمن ثلاث حقائق:

1. `telegram_user_id` مفتاح أساسي ← حساب Telegram واحد = عضو واحد.
2. `user_id` عليه فهرس فريد ← عضو واحد = حساب Telegram واحد نشط.
3. إذا كان معرّف Telegram مرتبطاً بعضو آخر، يُلغى الربط القديم
   (`revoked_at`) قبل الإنشاء — لا «كتابة فوق» صامتة تُفسد سجل التدقيق.

```
telegram_link_codes                telegram_user_links
┌────────────┬─────────┐          ┌──────────────────┬─────────┬─────────┐
│ code (PK)  │ user_id │          │ telegram_user_id │ user_id │ revoked │
├────────────┼─────────┤          ├──────────────────┼─────────┼─────────┤
│ K7QM4XPD   │ u-123   │──مستهلك──▶│ 987654321        │ u-123   │ NULL    │
│ used_at    │         │          │ chat_id, lang…   │ unique  │         │
└────────────┴─────────┘          └──────────────────┴─────────┴─────────┘
```

الحالات الحدّية المعالَجة صراحةً:

| الحالة | النتيجة |
|---|---|
| رمز غير موجود / مستعمل / منتهي | «الرمز غير صالح» + حدث `link.failed` |
| العضو المستهدف مرتبط بحساب آخر | «هذا العضو مرتبط بحساب آخر» |
| العضو نفسه يربط حساباً ثانياً | يُلغى القديم ويُنشأ الجديد |
| مستخدم `inactive` | `loadLinkedUser` يُرجع `null` ← رسالة تعطيل |
| البوت معطّل من الإعدادات | كل التحديثات ترد بـ«البوت معطّل» |

بعد النجاح: `link.success` في السجل + رسالة ترحيب بالاسم والدور + القائمة
الرئيسية بلغة العضو.

### 2.6 من هو المستخدم في كل تحديث؟

```ts
const link = await findLinkByTelegramId(db, telegramUserId);   // نشط فقط
if (!link) return notLinkedFlow();
const identity = await loadLinkedUser(db, link);               // users + user_scopes
if (!identity) return disabledFlow();                          // حساب موقوف
await touchLink(db, telegramUserId, now);                      // last_seen_at
```

`loadLinkedUser` يجمع الدور والنطاقات: المدير يحصل على `["*"]`، وغيره من جدول
`user_scopes`. هذه هي المادة الخام لكل قرار صلاحية لاحق.

### 2.7 إلغاء الربط

- من البوت: زر «إلغاء الربط» ← تأكيد ← `revokeLink` (يضع `revoked_at`).
- من اللوحة: `DELETE /api/operations/telegram/bot/links/:telegramUserId`.
- إعادة الربط ممكنة برمز جديد؛ السجل القديم يبقى للتدقيق.

---

## 3) برمجة الأزرار

### 3.1 أي نوع من الأزرار؟

Telegram يعطي نوعين:

| النوع | مكانه | مناسب لـ |
|---|---|---|
| `ReplyKeyboardMarkup` | أسفل الشاشة، يستبدل لوحة المفاتيح | «قائمة ثابتة» بلا سياق |
| `InlineKeyboardMarkup` | ملتصقة برسالة معيّنة، تبقى معها | **كل شاشاتنا** |

اخترنا **Inline** لأن الزر يحمل بيانات (`callback_data`) تخصّ الرسالة نفسها:
أي طلب، أي صفحة، أي حالة. لا حالة عالمية، ولا أزرار «عالقة» بعد انتهاء السياق.

الشكل على السلك:

```json
{
  "chat_id": "987654321",
  "text": "<b>الطلبات · جديد</b> …",
  "parse_mode": "HTML",
  "reply_markup": {
    "inline_keyboard": [
      [{ "text": "1. ORD-20261019-0042 · أمين", "callback_data": "ov:9f1c…" },
       { "text": "✅ مؤكد", "callback_data": "os:9f1c…:cf" }],
      [{ "text": "🔎 بحث", "callback_data": "sr:o" },
       { "text": "↩️ رجوع", "callback_data": "mn:orders" }]
    ]
  }
}
```

### 3.2 حدّ 64 بايت — ولماذا يوجد ملف `callbacks.ts`

Telegram يرفض `callback_data` أطول من **64 بايت**. ومعرّفات الطلبات UUID
(36 حرفاً)، فـ`order_status:<uuid>:confirmed` يتجاوز الحد. الحل: ترميز مضغوط.

```ts
// الحالات: كود من حرفين
const STATUS_CODE = {
  new: "nw", confirmed: "cf", unreachable: "un", preparing: "pr",
  ready: "rd", assigned: "as", dispatched: "ds", out_for_delivery: "of",
  delivered: "dv", returned: "rt", cancelled: "cn",
};
// البادئات: نوع الإجراء
const CALLBACK_PREFIX = {
  menu: "mn", ordersList: "ol", orderView: "ov", orderStatus: "os",
  orderStatusConfirm: "oc", approvalView: "aw", approvalDecision: "ad",
  report: "rp", search: "sr", customerView: "cv", language: "lg",
  alertToggle: "at", alertDigest: "ag", alertMute: "am", alertUnmute: "ax",
  showPhone: "ph", unlink: "ul", noop: "np",
};
```

أمثلة الناتج (كلها ≤ 64 بايت):

| الزر | `callback_data` | الطول |
|---|---|---|
| فتح طلب | `ov:9f1c2b8e-…-a1` | 39 |
| تعيين حالة «مؤكد» | `os:9f1c2b8e-…-a1:cf` | 42 |
| تأكيد الإلغاء | `oc:9f1c2b8e-…-a1:cn` | 42 |
| موافقة | `ad:y:3d7e…` | 39 |
| تقرير المخزون | `rp:stock` | 8 |
| القائمة الرئيسية | `mn:main` | 7 |

**التكويد** يتم في مكان واحد، و**الفك** صارم:

- بادئة غير معروفة ← `null`.
- حالة غير معروفة (`zz`) ← `null`.
- صفحة غير رقمية أو سالبة ← تُثبَّت على `0`.
- كتم بأقل من 15 دقيقة أو أكثر من 24 ساعة ← يُقصّ إلى المدى المسموح.

هذا يعني أن أي بيانات دخول من العميل تُعامَل كمدخل غير موثوق، ولا تصل أبداً
إلى SQL أو إلى منطق التنفيذ قبل التحقق منها.

### 3.3 بناء اللوحة من الصلاحيات

القائمة الرئيسية لا تُبنى نصّاً ثابتاً، بل تُبنى من `can()`:

```ts
export function mainMenuKeyboard(language, identity?) {
  const rows = [];
  const allow = (permission) => !identity || can(identity, permission);
  const first = [];
  if (allow("orders.read")) first.push(button(t("menu_orders"), { type: "menu", view: "orders" }));
  if (allow("reports.view")) first.push(button(t("menu_reports"), { type: "menu", view: "reports" }));
  ...
  if (allow("approvals.view")) second.push(button(t("menu_approvals"), { type: "menu", view: "approvals" }));
  ...
}
```

نتيجة عملية: مؤكّد الطلبات لا يرى زر «الموافقات» أصلاً، وموظف المخزون لا يرى
«المالية». والأهم: **إخفاء الزر ليس الحماية** — كل معالج يعيد الفحص:

```ts
async function showOrdersMenu(ctx, identity, messageId?) {
  if (!can(identity, "orders.read")) {
    await reply(ctx, botText(ctx.language, "permission_denied"),
                backKeyboard(ctx.language, "main"), messageId);
    return;
  }
  ...
}
```

### 3.4 الحالة → أزرار الحالة

لكل طلب، الأزرار المسموحة تُحسب من **الحالة الحالية في قاعدة البيانات** +
الصلاحية، لا من الحالة المرسومة في الرسالة:

```ts
// permissions.ts
if (!can(identity, "orders.update")) return [];
const targets = [...allowedNextStatuses(currentStatus)];   // خريطة الانتقالات
if (identity.user.role === "confirmer") {
  return targets.filter((status) => {
    if (status === "cancelled") return currentStatus === "new" || currentStatus === "unreachable";
    return CONFIRMATION_STATUSES.includes(status);
  });
}
return targets.filter((status) =>
  (status === "cancelled" || status === "returned") ? can(identity, "orders.cancel") : true);
```

ثم تُرسم في البطاقة (3 أزرار في الصف):

```ts
for (let index = 0; index < input.targets.length; index += 3) {
  rows.push(input.targets.slice(index, index + 3).map((status) =>
    button(`${STATUS_EMOJI[status]} ${statusLabel(language, status)}`,
      { type: "order_status", orderId: input.orderId, status })));
}
```

وتحت النتائج مباشرة (إجراآن سريعان لكل صف، بلا إلغاء/استرجاع):

```ts
const quick = (quickTargets[row.id] ?? []).filter((s) => s !== "cancelled").slice(0, 2);
return [
  button(label.slice(0, quick.length ? 34 : 60), { type: "order_view", orderId: row.id }),
  ...quick.map((status) => button(`${STATUS_EMOJI[status]} ${statusLabel(language, status)}`,
    { type: "order_status", orderId: row.id, status })),
];
```

### 3.5 دورة حياة الضغطة (بالترتيب)

```
1. Telegram: POST /webhooks/telegram { callback_query: { id, data, from, message } }
2. routes.ts: تحقق السر ← JSON ← handleTelegramUpdate
3. bot.ts: claimUpdate(update_id)            ← مكرّر؟ توقّف
4. bot.ts: findLinkByTelegramId + loadLinkedUser  ← غير مرتبط/موقوف؟ رسالة
5. bot.ts: touchLink                          ← آخر نشاط
6. bot.ts: decodeCallback(data)               ← مشوّه؟ «أمر غير معروف»
7. bot.ts: handleCallback → فحص صلاحية → تنفيذ (DB / موافقة / تقرير)
8. api.ts: answerCallbackQuery                ← إزالة دوّام الانتظار + نص قصير
9. api.ts: editMessageText                    ← نفس الرسالة بالحالة الجديدة
10. store.ts: recordBotEvent                  ← من، ماذا، النتيجة
```

نقطتان تُنسَيان كثيراً في بوتات Telegram:

- **الرد على كل `callback_query`**، وإلا يظل الزر يدور في واجهة المستخدم.
  لذلك كل فرع ينتهي بـ`toast(...)`.
- **`answerCallbackQuery` لا يقبل HTML ولا يزيد عن 200 حرف**، لذا يستخدم
  للرسائل القصيرة فقط («تم التحديث»، «غير مصرّح»)، أما التفاصيل ففي الرسالة.

### 3.6 تعديل الرسالة بدل إرسال رسالة جديدة

```ts
async function reply(ctx, text, keyboard?, messageId?) {
  if (messageId) {
    await editBotMessage(ctx.config, { chatId: ctx.chatId, messageId, text, keyboard });
    return;
  }
  await sendBotMessage(ctx.config, { chatId: ctx.chatId, text, keyboard });
}
```

- ضغطة زر تحمل `message.message_id` ← **تعديل**، فتتحوّل نفس الرسالة من قائمة
  إلى بطاقة إلى تأكيد إلى نتيجة، ويبقى السجل نظيفاً.
- أمر نصي جديد ← **إرسال** رسالة جديدة.

`editBotMessage` يتجاهل خطأ `message is not modified` (يحدث عند إعادة الضغط على
نفس الزر) بدل اعتباره فشلاً.

### 3.7 خطوة التأكيد للإجراءات النهائية

الإلغاء والاسترجاع لا يُنفَّذان مباشرة:

```ts
const DESTRUCTIVE_TARGETS = ["cancelled", "returned"];

if (DESTRUCTIVE_TARGETS.includes(target)) {
  // تحقق من الصلاحية على الحالة الحيّة أولاً
  if (!allowedStatusTargets(identity, detail.order.status).includes(target)) { ...deny... }
  await reply(ctx, `⚠️ <b>${statusLabel(...)}</b>\n\n${botText(language, "confirm_status_body", {...})}`,
    [[{ text: t("confirm_status_yes"), callback_data: `oc:${orderId}:${code}` }],
     [{ text: t("confirm_status_no"),  callback_data: `ov:${orderId}` }]],
    messageId);
  await toast(ctx, callbackId, "");
  return;
}
await commitStatus(ctx, identity, orderId, target, callbackId, messageId);
```

الضغطة الثانية تصل كـ`order_status_confirm` ← `commitStatus`، فيُعاد الفحص
مرة أخرى قبل الكتابة. إن تغيّرت الحالة بين الضغطتين، تفشل العملية برسالة
واضحة بدل تطبيق انتقال غير صالح.

### 3.8 تنفيذ تغيير الحالة (ولماذا لا SQL مباشر)

```ts
await updateOrderStatus(ctx.db, orderId, target, identity.user.id, identity.user.name);
await logActivity(ctx.db, asAuthUser(identity), ACTIONS.ORDER_STATUS_CHANGED,
  { type: "order", id: orderId, label: detail.order.orderNumber },
  { from: detail.order.status, to: target, source: "telegram" });

if (shouldTriggerCapiConfirmed(target) || shouldTriggerCapiPurchase(target, detail.order.wilayaId)) {
  const promise = ctx.env.CAPI_WORKFLOW.create({ ... }).catch(logError);
  ctx.deps.waitUntil?.(promise);
}
```

نفس الدالة المستخدمة في اللوحة، وبالتالي نفس السلوك: سجل الحالات، الخطّافات،
إرجاع المخزون، رصيد السائق، وأحداث Meta CAPI. لو كتب البوت `UPDATE orders` بنفسه
لانفصلت الأرقام بين اللوحة والتقارير.

إن كانت سياسة العضو تُلزم بموافقة (`requiresTelegramApproval`)، لا تُكتب الحالة
إطلاقاً؛ بل يُنشأ **طلب موافقة** ويُرسل إلى المسؤولين مع أزرار
`ad:y:<id>` / `ad:n:<id>` / `aw:<id>`.

### 3.9 الجلسات: عندما يحتاج البوت نصاً حرّاً

بعض الخطوات تحتاج إدخالاً من المستخدم (نص بحث، سبب رفض). لذلك يوجد جدول جلسة:

```sql
telegram_bot_sessions (telegram_user_id PK, state, payload JSON, updated_at)
```

الحالات: `idle` · `awaiting_link_code` · `awaiting_order_search` ·
`awaiting_customer_search` · `awaiting_rejection_reason` · `awaiting_unlink_confirm`.

```ts
if (session.state === "awaiting_order_search") {
  await clearSession(ctx.db, ctx.telegramUserId);   // استهلاك مرة واحدة
  await handleSearchOrders(ctx, identity, text);
  return;
}
```

الجلسة تُمسح دائماً قبل التنفيذ، فلا يبقى البوت «عالقاً» في وضع انتظار.

### 3.10 أزرار في الرسائل الصادرة (لا يبدأها المستخدم)

- **طلب جديد** (`notifyNewOrder`): بطاقة + زر فتح الطلب + زر تأكيد فوري.
- **موافقة**: `ad:y` / `ad:n` / `aw`.
- **تنبيه حرج**: بلا أزرار عادةً، لتقليل الضغط الخطأ.

كل رسالة صادرة تُبنى بلغة **المستلم** عبر `render: (link) => …`، لا بلغة من
أنشأ الحدث:

```ts
await broadcastAlert(ctx, {
  category: "orders", severity: "info",
  dedupeKey: `new-order:${order.id}`, minIntervalMinutes: 24 * 60,
  render: (link) => {
    const language = link.language as BotLanguage;
    return { text: composedIn(language), keyboard: [[...]] };
  },
});
```

---

## 4) الصلاحيات: ثلاث طبقات

| الطبقة | المكان | تمنع |
|---|---|---|
| إخفاء الزر | `mainMenuKeyboard(lang, identity)` | إرباك المستخدم بوظائف لا تخصّه |
| فحص المعالج | `can(identity, "orders.read")` داخل كل `show*` | استدعاء callback محفوظ/مُعاد |
| فحص القيمة | `allowedStatusTargets(identity, liveStatus)` قبل الكتابة | انتقال غير صالح أو تجاوز دور |

مصفوفة `can()` الحالية:

| الصلاحية | من يملكها |
|---|---|
| `orders.read` / `orders.update` | نطاق `orders:*` أو دور `confirmer` |
| `orders.cancel` | مدير أو نطاق حذف الطلبات |
| `reports.view` | مدير أو `dashboard:view` أو `analytics:finance` |
| `reports.finance` | مدير أو `analytics:finance` |
| `reports.team` | مدير أو `operations:view` |
| `customers.view` | مدير أو `customers:read` |
| `stock.view` | مدير أو `stock:read` |
| `approvals.view` / `approvals.decide` | مدير فقط |

---

## 5) اللغات والاتجاه

- كل النصوص في `i18n.ts` كقاموس واحد `STRINGS.ar|fr|en`، والدالة
  `botText(lang, key, vars)` تستبدل `{name}`.
- لغة المستخدم من `telegram_user_links.language`، وإلا اللغة الافتراضية من
  `telegram_bot_config.default_language`.
- الرسائل بتنسيق HTML فقط (`parse_mode: "HTML"`) وكل نص ديناميكي يمرّ عبر
  `escapeHtml` — اسم عميل فيه `<` لا يفسد الرسالة.
- تسميات الحالات موحّدة (`statusLabel`) مع رموز تعبيرية ثابتة
  (`STATUS_EMOJI`)، فتبدو كل الشاشات بنفس اللغة البصرية.
- الاختبارات تتحقق من اكتمال 26+ مفتاحاً × 3 لغات، فلا تظهر مفاتيح خام في
  الواجهة.

---

## 6) الأمان: ما الذي يمنع العبث؟

1. **السرّ في كل طلب** — بدون `X-Telegram-Bot-Api-Secret-Token` الصحيح: 403.
2. **حدّ التحديثات** — `allowed_updates` يقيّد الأنواع.
3. **منع التكرار** — `telegram_update_log` بإدخال ذرّي.
4. **الهوية لا تُرسل من العميل** — لا نأخذ `userId` من `callback_data` أبداً؛
   الهوية من `telegram_user_id` المرتبط في القاعدة.
5. **صلاحيات مُعاد فحصها** في كل معالج، على الحالة الحيّة.
6. **سجل تدقيق** لكل قرار: `telegram_bot_events` (`ok`/`denied`/`failed`).
7. **إخفاء التوكن** في اللوحة (`••••` + آخر 6)، ولا يُعاد إرساله للواجهة.
8. **لا أسرار في المحادثة** — الرموز لمرة واحدة، وتنتهي، وتُستهلك مرة واحدة.

---

## 7) التشغيل والاختبار

### تشغيل محلي

```bash
# 1) قاعدة محلية + الترحيلات
cd cod-server && npm run db:migrate:local

# 2) خادم التطوير
npx wrangler dev --local --port 8787

# 3) نفق عام (Telegram يحتاج https)
cloudflare tunnel --url http://localhost:8787
# أو: ngrok http 8787

# 4) اجعل WORKER_SELF_URL = عنوان النفق ثم احفظ إعدادات Telegram من اللوحة
#    (الحفظ يستدعي setWebhook تلقائياً)
```

### الاختبارات

```bash
cd cod-server && npx vitest --run src/endpoints/telegram-bot src/endpoints/telegram-approvals
cd cod-client-astro && npx vitest --run src/i18n
```

تغطي الاختبارات: تكويد/فك تكويد الـ callback وحدّ 64 بايت، الحالات المشوّهة،
مصفوفة الصلاحيات، خريطة الانتقالات، اكتمال اللغات، الهروب من HTML، أزرار
الحالة داخل القائمة، أمن الـ Webhook، وقرار الموافقة.

---

## 8) وصفة عملية: أضف زراً جديداً في 5 خطوات

مثال: زر «تصدير قائمة الطلبات».

1. **النوع** في `callbacks.ts`:
   ```ts
   | { type: "export_orders"; filter: OrderFilter }
   const CALLBACK_PREFIX = { ..., exportOrders: "eo" };
   // encode
   case "export_orders": return `${CALLBACK_PREFIX.exportOrders}:${filterCode(callback.filter)}`;
   // decode
   case CALLBACK_PREFIX.exportOrders: return { type: "export_orders", filter: filterFromCode(rest[0] ?? "al") };
   ```
2. **النص** في `i18n.ts` (الثلاث لغات) — أضفه قبل نهاية كل قاموس.
3. **الزر** في `keyboards.ts`:
   ```ts
   rows.push([button(botText(language, "export_orders"), { type: "export_orders", filter: input.filter })]);
   ```
4. **المعالج** في `bot.ts#handleCallback`:
   ```ts
   case "export_orders": {
     if (!can(identity, "orders.read")) { await toast(ctx, callback.id, botText(ctx.language, "permission_denied"), true); return; }
     const rows = await listOrders(ctx.db, { filter: decoded.filter, page: 0 });
     await reply(ctx, renderExport(ctx.language, rows), backKeyboard(ctx.language, "orders"), messageId);
     await toast(ctx, callback.id, "");
     await audit(ctx, "orders.export", { type: "orders", id: decoded.filter });
     return;
   }
   ```
5. **اختبار** في `telegram-bot.test.ts`: التكويد/الفك + وجود الزر + حدّ 64 بايت.

القاعدة الذهبية: **لا تُنفّذ كتابة قبل فحص الصلاحية، ولا تُغيّر حالة قبل
`allowedStatusTargets` على الحالة الحيّة.**

---

## 9) مزالق واجهناها فعلاً

| المزلق | الحل المطبّق |
|---|---|
| `callback_data` يتجاوز 64 بايت | أكواد من حرفين + UUID فقط |
| Telegram يعيد إرسال التحديث عند البطء | رد 200 دائماً + منع تكرار ذرّي |
| ضغطتان متتاليتان على «تأكيد» | إعادة فحص الحالة + انتقال صالح فقط |
| `editMessageText` يفشل بلا تغيير | تجاهل `message is not modified` |
| أزرار تدور بلا نهاية | `answerCallbackQuery` في كل فرع |
| اسم عميل فيه `<` يفسد الرسالة | `escapeHtml` على كل نص ديناميكي |
| حدّ 429 من Telegram | إعادة محاولة واحدة بعد `retry_after` (بحد 5 ثوانٍ) |
| تقرير/ملخص طويل | تقسيم على 3800 حرف في الملخصات |
| ساعات الهدوء بتوقيت UTC | `localClock(now, timezone)` من إعدادات التقارير |
| مستخدم موقوف لكنه مرتبط | `loadLinkedUser` يتحقق من `status === "active"` |

---

## 10) ملخّص في ست جمل

1. Telegram يدفع التحديثات إلى `/webhooks/telegram`، والمسار مركّب قبل المصادقة
   ومحمي بسرّ في الترويسة.
2. كل تحديث يُسجَّل بـ`update_id` ذرّياً لمنع التنفيذ المزدوج.
3. الربط يتم برمز لمرة واحدة من اللوحة (`/link CODE` أو `?start=CODE`)، ويُخزَّن
   في `telegram_user_links` بعلاقة واحد-لواحد.
4. الأزرار كلها Inline، ويحمل كل زر `callback_data` مضغوطاً (بادئة + UUID + كود
   حالة) ليبقى تحت 64 بايت.
5. المعالج يفكّ البيانات، يتحقق من الصلاحية على **الحالة الحيّة**، ينفّذ عبر نفس
   دوال اللوحة، ثم يعدّل الرسالة نفسها ويسجّل الحدث.
6. الإجراءات النهائية (إلغاء/استرجاع) تتطلب تأكيداً ثانياً، والقرارات الحسّاسة
   تمرّ عبر طلب موافقة قابل للتتبّع.
