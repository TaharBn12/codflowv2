# نشر CodFlow على Cloudflare — دليل خطوة واحدة

> هذا الدليل ينفّذ الـ runbook الرسمي للمشروع حرفياً:
> [`.agents/skills/codflow-setup/SKILL.md`](../.agents/skills/codflow-setup/SKILL.md)
> عبر سكربت واحد آلي: [`scripts/cloudflare-deploy.mjs`](../scripts/cloudflare-deploy.mjs)

السكربت ينشئ كل شيء في حسابك: قاعدة بيانات **D1** + حزمة صور **R2** +
نطاقي **KV**، يربط معرّفاتها الحقيقية في ملفي `wrangler.toml`، يولّد الأسرار،
يطبّق الـ migrations ويسكب البيانات التجريبية، ينشر الـ Workers الثلاثة
(**API + لوحة التحكم + المتجر**)، يربط الروابط الحقيقية بينها، ثم يختبر كل شيء.

إعادة التشغيل آمنة (idempotent): الموارد الموجودة يُعاد استخدامها، والأسرار
الموجودة لا تتغيّر، والـ seed لا يتكرر.

## المتطلبات

- حساب **Cloudflare** + تفعيل **R2**
  (لوحة Cloudflare ← R2 — يتطلب بطاقة بنكية على الملف، ضمن الشريحة المجانية)
- توكن API بصلاحيات: Workers + D1 + R2 + KV (الأسهل: توكن بصلاحيات واسعة للحساب)
- للطريقتين 2 و3 فقط: **Node.js 22.12+** ([تحميل](https://nodejs.org/))

## الطريقة 1: زر واحد من GitHub (الأسهل — بدون أي تثبيت)

1. افتح: `Settings ← Secrets and variables ← Actions ← New repository secret`
   وأضف 3 أسرار:
   | الاسم | القيمة |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | توكن Cloudflare |
   | `CLOUDFLARE_ACCOUNT_ID` | معرّف الحساب (32 خانة) |
   | `ADMIN_PASSWORD` | كلمة مرور مدير لوحة التحكم (اخترها بنفسك) |
2. افتح تبويب **Actions** ← اختر **Deploy to Cloudflare** ← **Run workflow**
   (اترك القيم الافتراضية أو غيّر البادئة والبريد) ← **Run workflow**
3. انتظر ~15 دقيقة — في النهاية تجد الروابط الثلاثة في صفحة **Summary**،
   وكلمة المرور هي نفس `ADMIN_PASSWORD` الذي أدخلته.

## الطريقة 2: من جهازك (دقيقتان)

```bash
git clone <repo-url> codflow && cd codflow
git checkout arena/01a0b39c-codflowv2

# المصادقة — اختر واحدة:
npx wrangler login
# .. أو بدون متصفح:
export CLOUDFLARE_API_TOKEN='<التوكن>' CLOUDFLARE_ACCOUNT_ID='<معرّف الحساب>'

# النشر الكامل بأمر واحد:
npm run deploy:cloudflare
```

تخصيص اختياري:

```bash
PROJECT_PREFIX=mystore ADMIN_EMAIL=me@example.com ADMIN_NAME=Me \
  npm run deploy:cloudflare
```

| متغيّر | الافتراضي | المعنى |
|---|---|---|
| `PROJECT_PREFIX` | `codflowv2` | بادئة أسماء الموارد والـ Workers (يجب أن تكون فريدة) |
| `ADMIN_EMAIL` | `admin@codflow.store` | بريد مدير لوحة التحكم |
| `ADMIN_NAME` | `Admin` | اسم المدير |
| `ADMIN_PASSWORD` | مولّدة عشوائياً | كلمة مرور المدير |
| `MEDIA_DOMAIN` | — | نطاق صور R2 (مثال: `media.yourdomain.com`) — يُستكمل لاحقاً |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | — | توكن R2 لرفع الصور — يُستكمل لاحقاً |
| `SKIP_SEED=1` | — | تخطّي البيانات التجريبية (متجر فارغ) |

## الطريقة 2: من المتصفح فقط (GitHub Codespaces)

بدون تثبيت أي شيء على جهازك:

1. افتح صفحة المستودع على GitHub ← زر **Code** ← تبويب **Codespaces** ← **Create codespace**
2. في الطرفية داخل Codespaces نفّذ نفس أمري المصادقة والنشر أعلاه
3. انسخ بيانات الدخول من ملف `~/codflow-<prefix>-credentials.md`

## ماذا ينشئ السكربت؟

| المورد | الاسم (`<prefix>` = البادئة) |
|---|---|
| D1 database | `<prefix>-db` |
| R2 bucket | `<prefix>-images` |
| KV namespace | `<prefix>-rate-limit` |
| KV namespace | `<prefix>-oauth` |
| Worker: API | `<prefix>-server` |
| Worker: لوحة التحكم | `<prefix>-dashboard` |
| Worker: المتجر | `<prefix>-theme01` |

في النهاية يطبع السكربت جدول الموارد + الروابط الثلاثة، ويحفظ ملف بيانات
الدخول والمفاتيح في `~/codflow-<prefix>-credentials.md` بصلاحيات `600`.
انقلها إلى مدير كلمات المرور ثم احذف الملف.

## بعد النشر — خطوتان يدويتان (تتطلبان لوحة Cloudflare)

### 1. رفع الصور (R2)

1. لوحة Cloudflare ← **R2** ← الباكت `<prefix>-images` ← Settings ←
   **Custom Domains** ← اربط `media.yourdomain.com` (أضف سجل DNS المطلوب)
2. **R2** ← **Manage R2 API Tokens** ← Create API Token ← صلاحية
   **Object Read & Write** على نفس الباكت ← انسخ الـ Access Key ID والـ Secret
3. أعد تشغيل النشر مع القيم الجديدة (آمن — يُعاد استخدام كل شيء آخر):
   ```bash
   MEDIA_DOMAIN=media.yourdomain.com \
   R2_ACCESS_KEY_ID='<id>' R2_SECRET_ACCESS_KEY='<secret>' \
     npm run deploy:cloudflare
   ```
4. **R2** ← الباكت ← Settings ← **CORS Policy** ← الصق الـ JSON الذي يطبعه
   السكربت في النهاية (مخصوماً بنطاق لوحتك)

### 2. نطاق مخصص للـ API (مستحسن للمتجر)

Cloudflare تمنع اتصال Worker-to-Worker بين نطاقي `*.workers.dev` (خطأ 1042)،
لذلك قد يظهر المتجر بدون منتجات حتى تضع الـ API على نطاقك:

Workers ← `<prefix>-server` ← Settings ← **Domains & Routes** ← أضف
`api.yourdomain.com`، ثم أعد النشر مع:

```bash
npm run deploy:cloudflare -- \
  --server-url=https://api.yourdomain.com \
  --dashboard-url=https://<prefix>-dashboard.<sub>.workers.dev
```

## التحقق السريع

```bash
# الـ API:
curl -s -o /dev/null -w "%{http_code}\n" https://<prefix>-server.<sub>.workers.dev/api/docs  # 200
# الدخول (لاحظ ترويسة Origin — إلزامية):
curl -s -X POST https://<prefix>-dashboard.<sub>.workers.dev/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -H "Origin: https://<prefix>-dashboard.<sub>.workers.dev" \
  -d '{"email":"<admin>","password":"<pass>"}'
```

## التحديثات مستقبلاً

لا تُعد تشغيل هذا السكربت من الصفر. عند صدور تحديث لـ CodFlow اطلب من
مساعد الذكاء الاصطناعي: **«حدّث CodFlow»** — سيتبع
[`.agents/skills/codflow-update/SKILL.md`](../.agents/skills/codflow-update/SKILL.md)
الذي يحدّث الكود والـ migrations مع الحفاظ على مواردك وبياناتك.

## استكشاف الأخطاء

| المشكلة | الحل |
|---|---|
| `R2 bucket create` يفشل | فعّل R2 من اللوحة (يتطلب بطاقة بنكية) ثم أعد التشغيل |
| `Authentication error [10000]` | سجّل الدخول (`wrangler login`) أو صدّر `CLOUDFLARE_API_TOKEN` الصحيح |
| الدخول من المتصفح يفشل بـ 403 | أعد النشر — السكربت يضبط `PUBLIC_TRUSTED_ORIGINS` تلقائياً |
| المتجر فارغ (بدون منتجات) | انظر «نطاق مخصص للـ API» أعلاه (قيد 1042) |
| `Address already in use :8787` | عملية wrangler قديمة — أوقفها قبل التشغيل المحلي |
