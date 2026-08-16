# 04 — API Specification

**الإصدار:** v0.1 · **الحالة:** Draft · **النمط:** REST + Server Actions

---

## 1. مبادئ التصميم

1. **ثلاث مساحات منفصلة بضوابط مختلفة:**

   | المساحة | المسار | المصادقة | Rate limit |
   |---------|--------|----------|------------|
   | **Public** | `/api/public/*` | لا شيء | صارم، حسب IP + المورد |
   | **App** | `/api/v1/*` | Session cookie | معتدل، حسب المستخدم |
   | **Admin** | `/api/admin/*` | Session + role + 2FA | صارم + Audit إجباري |
   | **Webhooks** | `/api/webhooks/{provider}` | تحقق توقيع | حسب المزوّد |

2. **الإصدارات:** `/api/v1` من اليوم الأول. تكلفتها صفر الآن، وغيابها لاحقاً مؤلم.

3. **الأخطاء بشكل واحد** في كل النظام (§3).

4. **كل مدخل يمرّ عبر Zod schema.** لا استثناء. الـ schema هو مصدر الحقيقة للتوثيق والأنواع.

5. **Server Actions لتحرير الـ Builder** (Autosave، تحديثات صغيرة) — أقل boilerplate وأسرع.
   **REST للقراءة، والعمليات الحساسة، وأي شيء قد يستهلكه عميل خارجي لاحقاً.**

6. **Idempotency إجبارية** على: النشر، الدفع، إرسال RSVP.

---

## 2. المصادقة

```
Cookie: __Host-zfaf_session=<opaque-32-byte-base64url>
        HttpOnly; Secure; SameSite=Lax; Path=/
```

- الرمز **معتم** — الخادم يبحث عن `sha256(token)` في `sessions`.
- انتهاء: 30 يوماً، مع تمديد انزلاقي عند الاستخدام (حد أقصى 90 يوماً مطلقاً).
- **حماية CSRF:** `SameSite=Lax` يغطي الأغلبية. بالإضافة إلى ذلك:
  - كل الطلبات المُغيِّرة تتحقق من ترويسة `Origin` مقابل قائمة بيضاء.
  - Server Actions محمية أصلاً بـ Next.js.
  - رموز CSRF صريحة للنماذج الحساسة (تغيير البريد، الحذف، الدفع).

---

## 3. شكل الاستجابة الموحّد

### نجاح
```json
{ "data": { ... }, "meta": { "requestId": "01J8X...", "page": {...} } }
```

### خطأ
```json
{
  "error": {
    "code": "INVITATION_SLUG_TAKEN",
    "message": "هذا الرابط مستخدم بالفعل",
    "messageEn": "This link is already taken",
    "details": [{ "field": "slug", "issue": "unique" }],
    "requestId": "01J8X..."
  }
}
```

**قواعد:**
- `code` ثابت وقابل للقراءة آلياً — لا تعتمد الواجهة على `message` أبداً.
- الرسائل بلغتين لتُعرض مباشرة.
- `requestId` في كل استجابة وفي كل سطر log → تتبع فوري لأي شكوى.
- **الأخطاء لا تسرّب معلومات:** «غير موجود» و«ممنوع» يعطيان **404 معاً** للموارد المملوكة لغيرك.
  إعطاء 403 يكشف وجود المورد — وهذا تسريب IDOR.

### رموز الحالة

| الرمز | الاستخدام |
|------|-----------|
| 200/201/204 | نجاح |
| 400 | مدخل غير صالح (فشل Zod) |
| 401 | لا جلسة / منتهية |
| 403 | جلسة صحيحة لكن الدور لا يكفي (لا يُستخدم لملكية الموارد) |
| 404 | غير موجود **أو** غير مملوك — متعمّد |
| 409 | تعارض (slug مأخوذ، تعارض autosave) |
| 410 | الدعوة انتهت |
| 422 | صحيح شكلاً لكن مرفوض بقواعد الأعمال |
| 429 | تجاوز الحد + ترويسة `Retry-After` |
| 451 | دعوة موقوفة لأسباب قانونية |
| 500 | خطأ داخلي (لا تفاصيل للعميل) |
| 503 | تبعية غير متاحة |

---

## 4. Public API

> ⚠️ هذه النقاط بلا مصادقة → أشد الأسطح تعرضاً للهجوم. كل واحدة لها حد معدل وتحقق مدخلات صارم.

### `GET /i/{slug}` — صفحة الدعوة (HTML، ليست JSON)

```
Cache-Control: public, s-maxage=300, stale-while-revalidate=86400
Cache-Tag: inv:{invitationId}
Vary: Accept-Language
```
الحالات: `200` منشورة · `404` غير موجودة/مسودة/محذوفة · `410` منتهية · `451` موقوفة
· `401` محمية بكلمة مرور (Phase 2)

### `GET /api/public/invitations/{id}/summary`

بيانات خفيفة للعد التنازلي وتزامن الساعة:
```json
{ "data": {
    "id": "...", "status": "PUBLISHED",
    "eventLocalDateTime": "2026-09-20T20:00:00",
    "timezone": "Asia/Riyadh",
    "serverNowUtc": "2026-08-16T10:22:31.482Z",
    "rsvpEnabled": true, "rsvpDeadline": "2026-09-15",
    "maxPartySize": 5
}}
```
`serverNowUtc` هو الأهم — يصحّح ساعات الهواتف الخاطئة.

### `POST /api/public/invitations/{id}/rsvp`

```jsonc
// الطلب
{
  "name": "خالد العتيبي",
  "attending": true,
  "partySize": 3,
  "phone": "+966501234567",   // اختياري
  "note": "سنصل متأخرين قليلاً",  // اختياري، ≤500
  "guestToken": "…",           // اختياري (Phase 3)
  "website": "",               // honeypot — يجب أن يبقى فارغاً
  "turnstileToken": "…"        // عند الطلب
}
```

**الضوابط بالترتيب:**
1. Rate limit: **5 / 10 دقائق** لكل `(ipHash, invitationId)` + **20 / ساعة** لكل `invitationId`
2. Honeypot ممتلئ → `202` كاذب (لا نُعلم البوت)
3. Turnstile عند تجاوز عتبة الاشتباه
4. Zod: `name` 2–80 حرفاً، `partySize` 0–50
5. الدعوة PUBLISHED + RSVP مفعّل + الموعد لم يمرّ
6. `partySize ≤ maxPartySize` — **server-side، دائماً**
7. Dedupe عبر `dedupe_hash` → UPSERT

```jsonc
// 201
{ "data": {
    "rsvpId": "...",
    "editToken": "…",  // يسمح بالتعديل خلال 24 ساعة
    "message": "شكراً لك! تم تسجيل ردّك."
}}
```

### `PATCH /api/public/rsvps/{id}` — تعديل الرد
يتطلب `editToken` صالحاً · نافذة 24 ساعة · حد معدل 3 تعديلات.

### `POST /api/public/analytics/event`
مجهّل بالكامل، Fire-and-forget، `204` دائماً (لا يفشل أبداً على العميل).
```json
{ "invitationId": "...", "type": "view", "meta": { "section": "gallery" } }
```
الخادم يستخرج الدولة/الجهاز من الترويسات. **العميل لا يرسل أي معرّف.**

### `POST /api/public/reports` — الإبلاغ عن دعوة
حد معدل: 3/ساعة لكل IP · بريد المبلّغ اختياري.

---

## 5. App API — الحسابات

| الطريقة | المسار | الوصف |
|---------|--------|-------|
| POST | `/api/v1/auth/register` | تسجيل (rate limit 3/ساعة/IP) |
| POST | `/api/v1/auth/login` | دخول (5 محاولات ثم قفل تصاعدي) |
| POST | `/api/v1/auth/logout` | إبطال الجلسة الحالية |
| POST | `/api/v1/auth/logout-all` | إبطال كل الجلسات |
| POST | `/api/v1/auth/verify-email` | تأكيد بالرمز |
| POST | `/api/v1/auth/resend-verification` | (2/ساعة) |
| POST | `/api/v1/auth/forgot-password` | **دائماً 200** — لا نكشف وجود البريد |
| POST | `/api/v1/auth/reset-password` | + إبطال كل الجلسات |
| GET | `/api/v1/auth/session` | الجلسة والمستخدم الحالي |
| GET/PATCH | `/api/v1/me` | الملف الشخصي |
| POST | `/api/v1/me/delete` | طلب حذف الحساب (نافذة تراجع 30 يوماً) |
| GET | `/api/v1/me/sessions` | الأجهزة النشطة |
| GET | `/api/v1/me/export` | تصدير البيانات (حق قانوني) |

---

## 6. App API — الدعوات

### `GET /api/v1/invitations`
`?status=&page=&limit=&sort=` · مقصورة على دعوات المستخدم (owner أو member).

### `POST /api/v1/invitations`
```json
{ "templateKey": "classic-luxury", "locale": "ar", "title": "عرس أحمد وسارة" }
```
- يتحقق من Entitlement: `maxActiveInvitations`
- ينشئ `draft_document` من `template.defaults`
- `201` → `{ "data": { "id": "...", "builderUrl": "/builder/..." } }`

### `GET /api/v1/invitations/{id}`
المستند الكامل للـ Builder. `404` إن لم تكن مملوكة.

### `PATCH /api/v1/invitations/{id}/document` — **Autosave**

```jsonc
{
  "baseVersion": 42,              // النسخة التي بُني عليها التعديل
  "patch": [                      // RFC 6902 JSON Patch
    { "op": "replace", "path": "/content/couple/groomName", "value": "أحمد" },
    { "op": "replace", "path": "/theme/colors/primary", "value": "#B8860B" }
  ]
}
```

**لماذا JSON Patch لا المستند كاملاً؟**
- حمولة أصغر بكثير (عشرات البايتات بدل عشرات الكيلوبايتات كل 1.5 ثانية).
- تسمح بكشف التعارض بدقة على مستوى الحقل.

**كشف التعارض:**
```
إذا baseVersion ≠ النسخة الحالية:
    → 409 مع { currentVersion, currentDocument, conflictingPaths }
    → الواجهة: إن كانت المسارات المتعارضة لا تتقاطع → دمج تلقائي صامت
                وإلا → «فُتحت هذه الدعوة في مكان آخر» + خيار (إبقاء تعديلاتي / إعادة تحميل)
```

**استجابة النجاح:** `{ "data": { "version": 43, "savedAt": "..." } }`

### `POST /api/v1/invitations/{id}/publish`

```json
{ "slug": "ahmad-sarah", "idempotencyKey": "01J8X..." }
```
تسلسل التحقق في [01-system-architecture.md §4.3](01-system-architecture.md#43-نشر-دعوة-publish).

```jsonc
// 200
{ "data": {
  "url": "https://zfaf.app/i/ahmad-sarah",
  "qrUrl": "https://zfaf.app/api/v1/invitations/{id}/qr.svg",
  "whatsappShareUrl": "https://wa.me/?text=...",
  "version": 3, "publishedAt": "..."
}}
```
الأخطاء: `409 INVITATION_SLUG_TAKEN` · `422 INVITATION_INCOMPLETE` (مع قائمة الحقول الناقصة)
· `403 EMAIL_NOT_VERIFIED` · `402 PLAN_LIMIT_EXCEEDED`

### باقي عمليات الدعوة

| الطريقة | المسار | ملاحظات |
|---------|--------|---------|
| POST | `/api/v1/invitations/{id}/unpublish` | → PAUSED، يبقى الـ snapshot |
| DELETE | `/api/v1/invitations/{id}` | حذف ناعم + purge للـ CDN |
| POST | `/api/v1/invitations/{id}/restore` | خلال 30 يوماً |
| GET | `/api/v1/invitations/{id}/versions` | قائمة النسخ |
| POST | `/api/v1/invitations/{id}/rollback` | `{ "versionNumber": 2 }` |
| GET | `/api/v1/invitations/{id}/slug-check?slug=x` | (حد 20/دقيقة) |
| GET | `/api/v1/invitations/{id}/qr.svg` | `?size=&format=svg\|png` |
| POST | `/api/v1/invitations/{id}/duplicate` | Phase 3 |

### الأحداث والأقسام

```
GET   /api/v1/invitations/{id}/events
POST  /api/v1/invitations/{id}/events
PATCH /api/v1/invitations/{id}/events/{eventId}
DELETE /api/v1/invitations/{id}/events/{eventId}
POST  /api/v1/invitations/{id}/events/reorder   { "order": ["id1","id2"] }
POST  /api/v1/invitations/{id}/sections/reorder { "order": [...] }
PATCH /api/v1/invitations/{id}/sections/{sectionId}  { "enabled": false }
```

---

## 7. App API — الوسائط

### الرفع بثلاث مراحل (لا يمرّ الملف عبر خادمنا أبداً)

```
① POST /api/v1/media/upload-url
   { "kind":"image", "purpose":"gallery", "invitationId":"...",
     "filename":"IMG_1234.jpg", "contentType":"image/jpeg", "sizeBytes":2400000 }

   الخادم يتحقق: النوع مسموح · الحجم ضمن الحد · حصة التخزين متاحة
   → { "mediaId":"...", "uploadUrl":"https://…r2…?X-Amz-Signature=…", "expiresIn":900,
       "requiredHeaders": { "Content-Type":"image/jpeg" } }

② PUT <uploadUrl>   ← العميل يرفع مباشرة إلى R2

③ POST /api/v1/media/{mediaId}/complete
   الخادم: يقرأ الترويسات من R2، يتحقق من magic bytes، يضع في الطابور
   → { "status": "processing" }

④ GET /api/v1/media/{mediaId}   ← استطلاع أو SSE حتى status=ready
   → { "status":"ready", "variants":{...}, "blurhash":"L6Pj0^..." }
```

**لماذا رفع مباشر؟** يوفّر عرض النطاق ووقت الخادم، ويتجاوز حدود حجم الطلب في serverless،
ويسرّع التجربة على الجوال. تفاصيل الأمان في [10-storage-and-media.md](10-storage-and-media.md).

### باقي عمليات الوسائط
`GET /api/v1/media?invitationId=` · `DELETE /api/v1/media/{id}` (يرفض إن كانت مستخدمة في نسخة منشورة)
· `POST /api/v1/media/{id}/crop`

---

## 8. App API — RSVP والتحليلات

```
GET  /api/v1/invitations/{id}/rsvps?attending=&q=&page=&limit=&sort=
GET  /api/v1/invitations/{id}/rsvps/stats
       → { totalResponses, attending, declined, totalGuests, responseRate, lastResponseAt }
GET  /api/v1/invitations/{id}/rsvps/export.csv    ← UTF-8 مع BOM
DELETE /api/v1/invitations/{id}/rsvps/{rsvpId}
POST /api/v1/invitations/{id}/rsvps               ← إدخال يدوي (ردّ عبر الهاتف)

GET  /api/v1/invitations/{id}/analytics?from=&to=&granularity=day
       → { totals: {...}, series: [...], breakdown: { devices, countries, referrers } }
```

⚠️ **CSV injection:** أي خلية تبدأ بـ `= + - @ TAB CR` تُسبَق بـ `'`.
اسم ضيف مثل `=cmd|'/c calc'!A0` يجب ألا ينفّذ شيئاً في Excel. هذا هجوم حقيقي وشائع.

---

## 9. App API — القوالب والفوترة

```
GET /api/v1/templates                    ← المنشورة، مع علم isLocked حسب الباقة
GET /api/v1/templates/{key}
GET /api/v1/music?mood=&plan=            ← مكتبة الموسيقى المرخّصة

GET  /api/v1/plans
GET  /api/v1/me/subscription
GET  /api/v1/me/entitlements             ← تُستخدم للواجهة فقط، لا للتفويض
POST /api/v1/checkout/session            ← Phase 2
POST /api/v1/billing/portal              ← Phase 2
```

> **تنبيه:** `/me/entitlements` **لتلوين الواجهة فقط**. كل عملية تُنفَّذ يُعاد التحقق منها
> على الخادم. عميل مُعدَّل لا يكسب صلاحية.

---

## 10. Admin API

كلها تتطلب `role ∈ {support, admin, superadmin}` + جلسة حديثة (< 4 ساعات) + **تسجيل في `audit_logs`**.

```
GET   /api/admin/stats/overview
GET   /api/admin/users?q=&status=&role=
POST  /api/admin/users/{id}/suspend         { "reason": "..." }
POST  /api/admin/users/{id}/unsuspend
GET   /api/admin/invitations?q=&status=
POST  /api/admin/invitations/{id}/suspend   ⚠️ Kill switch — في MVP
POST  /api/admin/invitations/{id}/unsuspend
GET   /api/admin/reports?status=
POST  /api/admin/reports/{id}/resolve
GET   /api/admin/audit-logs?actor=&action=&from=&to=
# Phase 2:
POST  /api/admin/templates            POST /api/admin/templates/{id}/versions
POST  /api/admin/templates/{id}/publish
GET   /api/admin/payments             POST /api/admin/payments/{id}/refund
GET   /api/admin/plans                PATCH /api/admin/plans/{id}
```

**مصفوفة صلاحيات الأدوار الإدارية:**

| الإجراء | support | admin | superadmin |
|---------|:-------:|:-----:|:----------:|
| عرض المستخدمين والدعوات | ✅ | ✅ | ✅ |
| إيقاف دعوة | ✅ | ✅ | ✅ |
| إيقاف مستخدم | ❌ | ✅ | ✅ |
| نشر قالب | ❌ | ✅ | ✅ |
| استرداد مبلغ | ❌ | ✅ | ✅ |
| تعديل الباقات والأسعار | ❌ | ❌ | ✅ |
| تغيير أدوار المستخدمين | ❌ | ❌ | ✅ |
| قراءة سجلات التدقيق | ❌ | ✅ | ✅ |

---

## 11. Webhooks

```
POST /api/webhooks/stripe
POST /api/webhooks/{provider}
```

**تسلسل المعالجة الإلزامي:**
```
1. اقرأ الجسم الخام (raw body) — قبل أي تحليل
2. تحقق من التوقيع بالسر الخاص بالمزوّد   ← فشل ⇒ 401 وتوقف
3. تحقق من الطابع الزمني (نافذة ±5 دقائق) ← منع إعادة الإرسال
4. INSERT في webhook_events (provider_event_id UNIQUE)
       تعارض ⇒ سبق معالجته ⇒ 200 فوراً (idempotent)
5. رد 200 فوراً    ⚠️ لا تعالج داخل الطلب
6. عالج في الخلفية عبر الطابور مع إعادة محاولة أسّية
```

**قاعدة ذهبية:** حالة الاشتراك والدفع **لا تتغير أبداً** إلا عبر webhook مُتحقَّق منه.
ما يعود من المتصفح بعد الدفع مجرد تلميح لتجربة المستخدم، لا مصدر حقيقة.

---

## 12. حدود المعدل (Rate Limits)

| النقطة | الحد | المفتاح |
|--------|------|---------|
| `POST /public/*/rsvp` | 5 / 10د · 20 / س للدعوة | ipHash + invitationId |
| `POST /public/reports` | 3 / س | ipHash |
| `POST /public/analytics/event` | 100 / د | ipHash |
| `POST /auth/register` | 3 / س | ipHash |
| `POST /auth/login` | 5 / 15د + قفل تصاعدي | ipHash + email |
| `POST /auth/forgot-password` | 3 / س | ipHash + email |
| `POST /media/upload-url` | 60 / س | userId |
| `POST /invitations/{id}/publish` | 10 / س | userId |
| `PATCH /invitations/{id}/document` | 120 / د | userId |
| عام (App API) | 300 / د | userId |
| عام (Public API) | 600 / د | ipHash |

**التنفيذ:** نافذة منزلقة في Redis. **ترويسات في كل رد:**
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, و`Retry-After` عند 429.

---

## 13. Idempotency

النقاط الحساسة تقبل `Idempotency-Key` (UUID من العميل):

```
Idempotency-Key: 01J8XKQ2M3N4P5R6S7T8V9W0XY
```
- المفتاح + الاستجابة يُخزَّنان 24 ساعة.
- تكرار المفتاح بنفس الحمولة → الاستجابة المخزّنة (بلا إعادة تنفيذ).
- تكرار المفتاح بحمولة مختلفة → `422 IDEMPOTENCY_KEY_REUSE`.

**إلزامي على:** `publish`, `checkout/session`, معالجة الدفع, `rsvp` (عبر dedupe hash).

---

## 14. صفحات المشاركة و OG

```
GET /api/og/invitation/{id}.png     ← صورة معاينة مولّدة (1200×630)
```
- تُولَّد عند النشر وتُخزَّن في R2 (لا تُولَّد عند كل طلب — WhatsApp يستدعيها كثيراً).
- تحتوي: أسماء العروسين، التاريخ، ألوان القالب.
- `Cache-Control: public, max-age=31536000, immutable` مع URL يتضمن hash النسخة.

**Meta tags في `/i/{slug}`:**
```html
<meta property="og:title"       content="أحمد & سارة — دعوة زفاف" />
<meta property="og:description" content="بكل الحب ندعوكم… ٢٠ سبتمبر ٢٠٢٦" />
<meta property="og:image"       content="https://cdn.zfaf.app/og/{id}-{v}.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:locale"      content="ar_SA" />
<meta name="twitter:card"       content="summary_large_image" />
<meta name="robots"             content="noindex, nofollow" /> <!-- ما لم يفعّل المستخدم الفهرسة -->
```

⚠️ **WhatsApp لا يجلب صوراً > 600KB ويهمل بعض العلامات.** صورة OG يجب أن تكون ≤ 300KB،
بأبعاد 1200×630 بالضبط، وبروابط مطلقة عبر HTTPS. **يُختبَر يدوياً قبل كل إطلاق.**

---

## 15. توثيق الـ API

- **مصدر الحقيقة:** Zod schemas في `packages/shared/schemas/`.
- **التوليد:** `zod-to-openapi` → `openapi.json` في CI.
- **الاختبار التعاقدي:** أي تغيير كاسر في الـ schema يُفشل CI ما لم تُرفع نسخة الـ API.
- **العرض:** Scalar/Redoc على `/docs/api` (محمي في Phase 1).
