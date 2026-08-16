# 01 — System Architecture

**الإصدار:** v0.1 · **الحالة:** Draft

---

## 1. المبادئ المعمارية الحاكمة

كل قرار في هذه الوثيقة مشتق من هذه المبادئ الستة. عند التعارض، الأولوية بالترتيب:

1. **الصفحة العامة مقدَّسة.**
   هي المنتج الذي يراه 99% من البشر الذين يلمسون النظام. يجب أن تكون الأسرع، الأثبت، والأقل تبعيات.
   كل شيء آخر (Dashboard, Admin, Builder) يخدمها ولا يعطّلها.

2. **افصل قراءة الدعوة عن كتابتها.**
   الكتابة معقّدة ونادرة (آلاف العمليات يومياً). القراءة بسيطة وضخمة (مئات الآلاف).
   → نموذج **Snapshot عند النشر**: القراءة لا تلمس منطق الأعمال ولا العلاقات المعقّدة.

3. **البساطة التشغيلية تتفوق على النقاء المعماري في هذه المرحلة.**
   فريق صغير + منتج غير مثبت السوق = Modular Monolith. Microservices الآن قرار انتحاري.
   لكن **الحدود المنطقية صارمة** حتى يكون التقسيم لاحقاً عملية استخراج لا إعادة كتابة.

4. **منطق الأعمال لا يعرف الإطار.**
   `packages/core` لا يستورد Next.js ولا HTTP ولا Prisma. يستقبل ويرجع بيانات خالصة.
   هذا هو ما يجعل الانتقال لاحقاً إلى NestJS/Fastify منفصل ممكناً في أيام لا أشهر.

5. **التفويض في مكان واحد.**
   نقطة واحدة تجيب: «هل يستطيع هذا الفاعل فعل هذا بهذا المورد؟» لا شروط متناثرة في الـ handlers.

6. **صمّم للتدهور المتدرج.**
   سقوط Redis لا يجب أن يُسقط الموقع. سقوط قاعدة البيانات لا يجب أن يُسقط الدعوات المنشورة.

---

## 2. نظرة عامة — C4 Level 1 (System Context)

```
                       ┌──────────────────────────────┐
                       │        الضيف (Guest)         │
                       │   جوال · WhatsApp browser    │
                       └──────────────┬───────────────┘
                                      │ يفتح /i/{slug}
                                      │ يرسل RSVP
                                      ▼
  ┌──────────────┐          ┌─────────────────────────┐          ┌──────────────────┐
  │   Customer   │─────────▶│                         │─────────▶│  Google Maps     │
  │ (عريس/عروس/  │  ينشئ    │      Zfaf Platform      │  روابط   │  (deep links)    │
  │   planner)   │  ينشر    │                         │          └──────────────────┘
  └──────────────┘  يتابع   │                         │
                            │                         │─────────▶┌──────────────────┐
  ┌──────────────┐          │                         │  يرسل    │  Email Provider  │
  │    Admin     │─────────▶│                         │          │  (Resend)        │
  └──────────────┘  يدير    │                         │          └──────────────────┘
                            │                         │
                            │                         │◀────────▶┌──────────────────┐
                            │                         │  دفع     │ Payment Provider │
                            │                         │ webhooks │ (Phase 2)        │
                            └───────────┬─────────────┘          └──────────────────┘
                                        │
                        ┌───────────────┼───────────────┐
                        ▼               ▼               ▼
                  ┌───────────┐  ┌────────────┐  ┌────────────┐
                  │PostgreSQL │  │ Object     │  │  Redis     │
                  │           │  │ Storage R2 │  │ (rate/jobs)│
                  └───────────┘  └────────────┘  └────────────┘
                                        │
                                        ▼
                                 ┌────────────┐
                                 │ CDN        │
                                 │ Cloudflare │
                                 └────────────┘
```

---

## 3. C4 Level 2 — Containers

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                              Cloudflare (CDN + WAF)                              ║
║   • Cache للصفحات العامة والوسائط     • Bot protection     • Turnstile CAPTCHA   ║
╚═══════════════════════════════════════╤══════════════════════════════════════════╝
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
        ▼                               ▼                               ▼
┌────────────────────┐    ┌──────────────────────────┐    ┌──────────────────────┐
│  PUBLIC SURFACE    │    │    AUTHENTICATED APP     │    │   ADMIN SURFACE      │
│  apps/web          │    │    apps/web              │    │   apps/web           │
│  (route group)     │    │    (route group)         │    │   (route group)      │
│                    │    │                          │    │                      │
│ /                  │    │ /dashboard               │    │ /admin/*             │
│ /templates         │    │ /dashboard/invitations   │    │                      │
│ /pricing           │    │ /builder/{id}            │    │ • kill switch        │
│ /i/{slug}   ★      │    │ /dashboard/rsvp/{id}     │    │ • users / invites    │
│ /i/{slug}/rsvp     │    │                          │    │ • audit log          │
│                    │    │ Session cookie required  │    │ Role: admin + 2FA    │
│ RSC · ISR · Cached │    │ Mostly dynamic           │    │                      │
└─────────┬──────────┘    └────────────┬─────────────┘    └──────────┬───────────┘
          │                            │                             │
          └────────────────────────────┼─────────────────────────────┘
                                       │  كلها تستدعي نفس الطبقة
                                       ▼
              ╔═══════════════════════════════════════════════════╗
              ║          APPLICATION LAYER (Route Handlers)       ║
              ║   • Zod validation   • Auth guard   • Rate limit  ║
              ║   • Request ID       • Error mapping              ║
              ╚════════════════════════╤══════════════════════════╝
                                       ▼
              ╔═══════════════════════════════════════════════════╗
              ║              packages/core  (DOMAIN)              ║
              ║  invitation · template · rsvp · guest · billing   ║
              ║  media · analytics · identity · moderation        ║
              ║                                                   ║
              ║  ⚠️ لا يستورد: Next.js · HTTP · Prisma · fetch    ║
              ║  يعتمد فقط على Ports (interfaces)                  ║
              ╚════════════════════════╤══════════════════════════╝
                                       ▼
              ╔═══════════════════════════════════════════════════╗
              ║              ADAPTERS (Infrastructure)            ║
              ║  packages/db (Prisma) · storage(R2) · mail        ║
              ║  cache(Redis) · payments · queue · geo             ║
              ╚════════════════════════╤══════════════════════════╝
                                       │
        ┌──────────────┬───────────────┼──────────────┬───────────────┐
        ▼              ▼               ▼              ▼               ▼
  ┌──────────┐  ┌────────────┐  ┌───────────┐  ┌──────────┐  ┌─────────────┐
  │PostgreSQL│  │Object Store│  │  Redis    │  │  Email   │  │ apps/worker │
  │          │  │  (R2)      │  │           │  │ (Resend) │  │  BullMQ     │
  └──────────┘  └────────────┘  └───────────┘  └──────────┘  └─────────────┘
```

★ = المسار الحرج للأداء

---

## 4. المسارات الحرجة (Request Flows)

### 4.1 قراءة دعوة منشورة — المسار الأهم في النظام

```
ضيف يفتح  https://zfaf.app/i/ahmad-sarah
   │
   ├─▶ Cloudflare Edge
   │      │
   │      ├─ HIT  ──▶ إرجاع HTML مخزَّن مسبقاً        ⏱ ~40ms   ✅ (الحالة الغالبة ~95%)
   │      │
   │      └─ MISS ──▶ الأصل (Next.js)
   │                     │
   │                     ├─ 1. تطبيع الـ slug + بحث في `invitations` (فهرس فريد)
   │                     ├─ 2. تحقق الحالة: PUBLISHED؟ غير موقوفة؟ غير منتهية؟
   │                     │      ├─ DRAFT/DELETED   → 404
   │                     │      ├─ SUSPENDED       → 451 + صفحة توضيح
   │                     │      └─ EXPIRED         → 410 + صفحة "انتهت"
   │                     ├─ 3. جلب `invitation_versions.published_document` (JSONB)
   │                     │      ⚠️ استعلام واحد فقط. لا JOINs. لا N+1.
   │                     ├─ 4. InvitationRenderer(document) → HTML
   │                     │      • دالة خالصة، حتمية، بلا I/O
   │                     │      • Theme → CSS variables inline
   │                     ├─ 5. حقن OG meta + JSON-LD
   │                     └─ 6. رد مع:
   │                            Cache-Control: public, s-maxage=300,
   │                                           stale-while-revalidate=86400
   │                            Cache-Tag: inv:{id}
   │
   └─▶ العميل: صور من CDN (R2) · خطوط preloaded · صوت عند الطلب فقط
```

**خصائص مقصودة:**
- استعلام DB واحد للحالة الشائعة، ولا شيء عند وجود cache.
- عند النشر أو التعديل → `purge` مستهدف بالـ `Cache-Tag` فقط لتلك الدعوة.
- `stale-while-revalidate=86400` يعني: **الدعوة تظل تعمل 24 ساعة حتى لو سقط الأصل بالكامل.**

### 4.2 إرسال RSVP

```
POST /api/public/invitations/{id}/rsvp
   │
   ├─ 1. Rate limit: 5 محاولات / 10 دقائق لكل (IP hash + invitationId)   [Redis]
   ├─ 2. Honeypot field فارغ؟ وإلا → 202 كاذب (لا نكشف للبوت أنه اكتُشف)
   ├─ 3. Turnstile token (يُفعَّل عند تجاوز عتبة اشتباه)
   ├─ 4. Zod validation: name, attending, partySize, phone?, note?
   ├─ 5. جلب الدعوة → PUBLISHED؟ RSVP مفعّل؟ الموعد النهائي لم يمرّ؟
   ├─ 6. تحقق المقاعد server-side:  partySize ≤ maxPartySize
   │      (⚠️ لا نثق أبداً بحد الـ Frontend)
   ├─ 7. كشف التكرار: hash(name + phone + invitationId) موجود؟ → تحديث بدل إنشاء
   ├─ 8. INSERT في `rsvps` + تحديث عدّادات مجمّعة (نفس الـ transaction)
   ├─ 9. Enqueue: إشعار بريدي لصاحب الدعوة (خارج المسار الحرج)
   └─ 10. رد 201 + رسالة شكر
```

**ملاحظة معمارية:** الردّ لا ينتظر البريد. المستخدم يرى التأكيد في < 300ms.

### 4.3 نشر دعوة (Publish)

```
POST /api/invitations/{id}/publish
   │
   ├─ 1. Authorize: هل الفاعل owner/editor لهذه الدعوة؟         [Policy layer]
   ├─ 2. تحقق البريد مُفعَّل؟ (شرط مكافحة إساءة)
   ├─ 3. تحقق Entitlements: الباقة تسمح بدعوة نشطة إضافية؟
   ├─ 4. Validate: الحقول الإجبارية موجودة، القالب منشور، slug متاح
   ├─ 5. تسوية Slug:
   │        • تطبيع (lowercase, ASCII-safe, transliteration للعربية)
   │        • رفض الكلمات المحجوزة
   │        • unique constraint على مستوى DB (لا نعتمد على فحص مسبق فقط)
   ├─ 6. بناء الـ Snapshot:
   │        resolveDocument(draft, template@version, theme, media, events)
   │        → JSONB كامل ومكتفٍ ذاتياً (روابط وسائط مطلقة، نصوص محلولة)
   ├─ 7. INSERT invitation_versions (رقم نسخة جديد، immutable)
   ├─ 8. UPDATE invitations SET status=PUBLISHED, published_version_id=...
   │        (6→8 في transaction واحدة)
   ├─ 9. توليد OG image (job غير متزامن، مع fallback فوري)
   ├─ 10. Purge CDN بالـ Cache-Tag inv:{id}
   └─ 11. رد: { url, qrUrl, whatsappShareUrl }
```

**لماذا Snapshot؟** انظر [ADR-0005](adr/0005-published-snapshot-versioning.md).
باختصار: يمنع أن يؤدي تعديل قالب أو حذف صورة إلى كسر دعوة منشورة ليلة الحفل.

### 4.4 التدهور المتدرج

| ما الذي سقط | التأثير | السلوك |
|-------------|---------|--------|
| **Redis** | Rate limiting + jobs | Fail-open للقراءة، Fail-closed للكتابة الحساسة (RSVP يستخدم حد احتياطي في الذاكرة). الموقع يعمل. |
| **PostgreSQL** | كل الكتابة | الدعوات المنشورة **تظل تعمل** من CDN (SWR). Dashboard و RSVP يعطيان 503 برسالة واضحة. |
| **Object Storage** | الصور | نصّ الدعوة يظهر، الصور بـ placeholder. لا تُكسَر الصفحة. |
| **Email provider** | التفعيل والإشعارات | تُوضع في طابور وتُعاد المحاولة. لا يمنع النشر إن كان البريد مفعّلاً سابقاً. |
| **Payment provider** | الدفع | تظهر رسالة «حاول لاحقاً». لا تتغير حالة الاشتراك أبداً بلا webhook مؤكَّد. |

---

## 5. حدود الوحدات (Module Boundaries)

`packages/core` مقسّم إلى وحدات ذات حدود صريحة. **قاعدة: لا تستدعي وحدة مستودع
(repository) وحدة أخرى مباشرة — التواصل عبر واجهات الخدمات أو الأحداث.**

| الوحدة | المسؤولية | تملك الجداول |
|--------|-----------|--------------|
| `identity` | مستخدمون، جلسات، بريد، كلمات مرور، أدوار | users, sessions, email_verifications, password_resets |
| `invitation` | دورة حياة الدعوة، الأقسام، الـ slug، النسخ، النشر | invitations, invitation_versions, invitation_sections, invitation_members, slug_history, events |
| `template` | القوالب، نسخها، manifest validation | templates, template_versions |
| `media` | الرفع، التحقق، التحويل، الحذف | media_assets |
| `music` | مكتبة الموسيقى المرخّصة | music_tracks |
| `rsvp` | الردود، العدّادات، التصدير | rsvps |
| `guest` | قائمة الضيوف، الرموز الفردية (Phase 3) | guests |
| `billing` | الباقات، الاشتراكات، المدفوعات، Entitlements | plans, subscriptions, payments, entitlement_overrides |
| `analytics` | الأحداث المجهّلة، التجميعات | analytics_events, analytics_daily |
| `moderation` | البلاغات، الإيقاف، Audit | reports, audit_logs |
| `domains` | النطاقات المخصصة (Phase 3) | custom_domains |

### شروط الاستخراج إلى خدمة مستقلة

لا نقسّم قبل ظهور **إشارة قياسية** حقيقية. المحفّزات المتفق عليها:

| الوحدة | محفّز الاستخراج |
|--------|------------------|
| صفحة الدعوة العامة | > 500 req/s مستدام أو تعارض موارد مع Dashboard |
| معالجة الوسائط | زمن معالجة p95 > 20s أو حاجة لـ CPU مخصص |
| Analytics ingestion | > 200 events/s أو تأثير الكتابة على أداء OLTP |
| Worker | موجود مستقل من اليوم الأول (process منفصلة، نفس المستودع) |

---

## 6. تدفق البيانات — نموذج الـ Document

هذا مفهوم مركزي: **الدعوة ليست صفاً واحداً في جدول، بل مستنداً مركّباً.**

```
                      ┌────────────────────────────────┐
                      │        DRAFT DOCUMENT          │
                      │  (invitations.draft_document)  │
                      │            JSONB               │
                      │                                │
                      │  { templateId, templateVersion,│
                      │    theme: {...},               │
                      │    sections: [                 │
                      │      {id,type,variant,         │
                      │       enabled,order,props}     │
                      │    ],                          │
                      │    content: {couple, events,   │
                      │              location, media}  │
                      │  }                             │
                      └───────────┬────────────────────┘
                                  │
        Builder يعدّل ─────────────┤
        (Autosave, JSON Patch)    │
                                  │
                    PUBLISH ──────┤ resolveDocument()
                                  │   • حلّ روابط الوسائط إلى URLs مطلقة
                                  │   • تجميد نسخة القالب
                                  │   • حساب القيم المشتقة
                                  ▼
                      ┌────────────────────────────────┐
                      │      PUBLISHED SNAPSHOT        │
                      │ invitation_versions            │
                      │   .published_document (JSONB)  │
                      │        ⚠️ IMMUTABLE            │
                      └───────────┬────────────────────┘
                                  │
                                  ▼
                      ┌────────────────────────────────┐
                      │      InvitationRenderer        │
                      │   دالة خالصة · حتمية · بلا I/O │
                      └───────────┬────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
            Public Page (SSR)            Builder Preview
            من الـ snapshot              من الـ draft
```

**فائدة جوهرية:** نفس الـ Renderer يخدم المعاينة والصفحة العامة → **ما تراه هو ما يُنشر فعلاً**،
وليس تقريباً له. هذا يقتل أكبر مصدر شكاوى في منتجات مشابهة.

---

## 7. البيئات

| البيئة | الغرض | البيانات | النطاق |
|--------|-------|----------|--------|
| **local** | تطوير | Docker Compose (Postgres + Redis + MinIO) | localhost:3000 |
| **preview** | مراجعة PR | DB منفصلة لكل PR (branch DB) · بيانات مولّدة | `pr-{n}.preview.zfaf.app` |
| **staging** | ما قبل الإنتاج | نسخة مجهَّلة من بنية الإنتاج | `staging.zfaf.app` |
| **production** | حي | حقيقي | `zfaf.app` |

**قواعد صارمة:**
- ممنوع الوصول لبيانات الإنتاج من أي بيئة أخرى.
- كل بيئة لها مفاتيح تشفير و secrets منفصلة تماماً.
- Staging يستخدم مفاتيح الدفع الاختبارية فقط.
- بيانات الإنتاج لا تُنسخ إلى staging إلا بعد تجهيل كامل (أسماء، هواتف، صور).

---

## 8. القرارات المعمارية المرتبطة

| القرار | ADR |
|--------|-----|
| Monorepo + Modular Monolith | [0001](adr/0001-monorepo-and-modular-monolith.md) |
| Next.js full-stack بدل API منفصل | [0002](adr/0002-nextjs-fullstack-over-separate-api.md) |
| PostgreSQL + Prisma | [0003](adr/0003-postgresql-and-prisma.md) |
| Snapshot عند النشر | [0005](adr/0005-published-snapshot-versioning.md) |
| Cloudflare R2 | [0007](adr/0007-cloudflare-r2-object-storage.md) |

---

## 9. ما لا نبنيه (وقرارات معمارية سلبية)

قرار عدم البناء لا يقل أهمية عن قرار البناء:

| لن نبني | لماذا |
|---------|-------|
| **Microservices** | فريق صغير، منتج غير مثبت. التعقيد التشغيلي يقتل السرعة بلا مقابل. |
| **GraphQL** | لدينا عميل واحد نتحكم به. REST + RSC أبسط وأسرع وأسهل تخزيناً في الـ cache. |
| **Event Sourcing** | لا يوجد متطلب تدقيق زمني يبرر التعقيد. Audit log عادي يكفي. |
| **Kubernetes** | Managed platform كافٍ حتى 10× النمو المتوقع. |
| **Message broker (Kafka/RabbitMQ)** | BullMQ على Redis يغطي احتياجنا بالكامل. |
| **CQRS كامل** | نأخذ الفكرة المفيدة فقط (فصل قراءة الدعوة عبر snapshot) بلا البنية الثقيلة. |
| **Multi-region active-active** | التعقيد هائل. Region واحد + CDN عالمي يعطي الأداء المطلوب. |
| **State manager عام (Redux/Zustand global)** | Server state عبر TanStack Query، وحالة الـ Builder محلية. |

**التزام:** إن ظهرت حاجة حقيقية مدعومة بقياس لأي مما سبق، نكتب ADR جديداً ونراجع.
لا نضيف تعقيداً على أساس التوقّع.
