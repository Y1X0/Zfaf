# 02 — Technology Choices & Alternatives Comparison

**الإصدار:** v0.1 · **الحالة:** Draft — التوصيات تحتاج موافقة

> طلبت مقارنة البدائل قبل الالتزام. هذه الوثيقة تفعل ذلك. كل قسم يعرض المرشحين،
> معايير الحكم، والتوصية مع سببها **ومع شرط إعادة النظر**.

---

## ملخّص الحزمة الموصى بها

| الطبقة | الاختيار | البديل الأقرب | الثقة |
|--------|----------|----------------|-------|
| Monorepo | pnpm workspaces + Turborepo | Nx | عالية |
| Frontend + Backend | Next.js 15 (App Router) | Next.js + NestJS منفصل | **متوسطة — قرار #1** |
| اللغة | TypeScript (strict) | — | عالية |
| Database | PostgreSQL 16 | MySQL / MongoDB | عالية |
| ORM | Prisma 6 | Drizzle | **متوسطة — قرار #2** |
| Auth | Auth.js v5 + DB sessions | Clerk / Supabase Auth / مخصص | عالية |
| Validation | Zod | Valibot / TypeBox | عالية |
| Styling | Tailwind CSS v4 + CSS variables | Panda CSS / vanilla-extract | عالية |
| UI primitives | Radix UI (headless) | Headless UI / shadcn كنسخ | عالية |
| Object Storage | Cloudflare R2 | AWS S3 / Supabase Storage | عالية |
| CDN + WAF | Cloudflare | Fastly / CloudFront | عالية |
| Cache / Queue | Upstash Redis + BullMQ | Postgres-only queue | متوسطة |
| Email | Resend | Postmark / SES | عالية |
| Payments | Port/Adapter → Stripe + مزوّد محلي | ربط مباشر | عالية |
| Hosting | Vercel (web) + Fly.io (worker) | كامل على Fly/Railway/Hetzner | **متوسطة — قرار #3** |
| Testing | Vitest + Testcontainers + Playwright | Jest + Cypress | عالية |
| Observability | Sentry + Axiom + OpenTelemetry | Datadog / Grafana Cloud | متوسطة |
| i18n | next-intl | next-i18next / Lingui | عالية |

---

## 1. Framework الأساسي — القرار الأهم

### المرشحون

**(أ) Next.js full-stack** — تطبيق واحد: صفحات + Route Handlers + منطق أعمال في `packages/core`.
**(ب) Next.js (frontend) + NestJS (API منفصل)** — خدمتان، عقد HTTP بينهما.
**(ج) Next.js (frontend) + FastAPI (Python)** — كما (ب) لكن بلغتين.

### المقارنة

| المعيار | (أ) Next.js full-stack | (ب) + NestJS | (ج) + FastAPI |
|---------|------------------------|--------------|----------------|
| زمن الوصول لـ MVP | **الأسرع** | +3 إلى 4 أسابيع | +5 إلى 6 أسابيع |
| SSR للصفحة العامة (حرج للـ SEO/الأداء) | **أصلي وممتاز** | ممتاز (لكن الـ API قفزة شبكة إضافية) | ممتاز (نفس الملاحظة) |
| مشاركة الأنواع Frontend↔Backend | **مباشرة، بلا توليد كود** | يحتاج OpenAPI + codegen | يحتاج OpenAPI + codegen |
| مشاركة الـ Renderer بين Preview والصفحة العامة | **تلقائية** (نفس حزمة React) | تلقائية (الـ renderer يبقى في الويب) | تلقائية |
| نضج بنية Backend (DI, guards, modules) | يدوي — نبنيه في `core` | **جاهز ومفروض** | جاهز |
| جاهزية لتطبيق جوال/عملاء آخرين | تحتاج استخراج لاحق | **جاهزة الآن** | جاهزة الآن |
| مهام طويلة/ثقيلة (CPU) | ضعيفة في serverless | جيدة | **الأفضل** (لو AI/ML لاحقاً) |
| تعقيد تشغيلي | **واحد** | اثنان + CORS + مصادقة بين الخدمات | اثنان + لغتان + بيئتان |
| عدد اللغات في الفريق | 1 | 1 | 2 |
| تكلفة الاستضافة الأولية | **الأقل** | متوسطة | متوسطة |

### التوصية: **(أ) Next.js full-stack — مع شرط معماري صارم**

الشرط غير قابل للتفاوض: **كل منطق الأعمال في `packages/core` بلا أي تبعية على Next.js أو HTTP أو Prisma.**
الـ Route Handler عمله فقط: تحقق مدخلات → استدعاء use case → تحويل النتيجة إلى HTTP.

```ts
// ✅ الشكل المسموح — Route Handler نحيف
export async function POST(req: Request, { params }) {
  const actor = await requireSession(req);
  const body  = publishSchema.parse(await req.json());
  const result = await publishInvitation({ actor, invitationId: params.id, ...body });
  return toHttp(result);
}

// ❌ ممنوع — منطق أعمال داخل الـ handler
export async function POST(req) {
  const inv = await prisma.invitation.findUnique(...);
  if (inv.userId !== session.userId) return new Response('no', { status: 403 });
  // ... 80 سطراً من المنطق
}
```

**لماذا هذا يكفي:** حين نحتاج API مستقل (تطبيق جوال، شركاء، تقسيم الحمل)، نضع Fastify/NestJS
حول نفس `packages/core` — العمل أيام لا أشهر، ولا يُعاد كتابة أي منطق.

**متى نعيد النظر (محفّزات صريحة):**
- الحاجة لعميل خارجي (تطبيق جوال أو API شركاء) — Phase 3.
- زمن الاستجابة p95 للـ API يتأثر بحمل عرض الصفحات.
- الحاجة لعمليات CPU مطوّلة داخل مسار الطلب.

📄 [ADR-0002](adr/0002-nextjs-fullstack-over-separate-api.md)

---

## 2. قاعدة البيانات

### الخيار: PostgreSQL 16 — **ثقة عالية، بلا نقاش طويل**

| البديل | لماذا لا |
|--------|----------|
| MySQL | دعم JSONB أضعف بكثير، ونحن نعتمد على JSONB بشكل مركزي للـ documents. |
| MongoDB | نحتاج معاملات علائقية حقيقية (Publish, Payments, Seats). الاتساق ليس رفاهية هنا. |
| SQLite/Turso | ممتاز للقراءة الموزّعة، لكن الكتابة المتزامنة والـ migrations في SaaS متعدد المستأجرين خطر. |

**لماذا Postgres تحديداً مناسب لنا:**
- `JSONB` + فهارس GIN → نموذج الـ document لدينا يعمل بكفاءة أصلية.
- قيود فريدة جزئية (`partial unique index`) → ضرورية للـ slug والحالات.
- `RLS` متاح كخط دفاع ثانٍ لعزل المستأجرين.
- امتدادات: `pg_trgm` (بحث الأسماء العربية)، `citext`، `pgcrypto`.
- كل مزوّد سحابي يدعمه (Neon/Supabase/RDS) → لا قفل مزوّد.

### مزوّد الاستضافة

| المزوّد | المزايا | العيوب | ملاحظة |
|---------|---------|--------|--------|
| **Neon** | Branching لكل PR (قيمة كبيرة في CI)، scale-to-zero، تسعير سخي | Cold start على الفروع الخاملة | **موصى به** |
| Supabase | حزمة كاملة (Auth+Storage+Realtime) | نأخذ حزمة لا نحتاج كلها؛ Auth الخاص بها يقيّدنا | بديل قوي |
| AWS RDS | نضج وتحكّم كامل | تكلفة ثابتة أعلى، إدارة أثقل | عند النمو الكبير |

**التوصية:** Neon في Phase 1–2 · إعادة تقييم عند > 50GB أو حاجة لـ region محلي.

---

## 3. ORM — Prisma مقابل Drizzle

هذا القرار الوحيد الذي كنت مذبذباً فيه بصدق. إليك المقارنة بلا تجميل:

| المعيار | Prisma 6 | Drizzle |
|---------|----------|---------|
| Migrations | ممتاز — `migrate dev/deploy`، تاريخ واضح، حل تعارضات ناضج | جيد، أحدث، أدوات أقل نضجاً |
| الـ Schema كوثيقة حيّة | **ممتاز** — ملف `.prisma` يُقرأ كـ ERD | TypeScript، ممتاز للمطور، أقل قابلية للقراءة لغير المطور |
| SQL معقّد (تجميعات Analytics) | يحتاج `$queryRaw` — يفقد type safety | **أفضل** — SQL-first بأنواع محفوظة |
| حجم الحزمة / Cold start | تحسّن كثيراً لكن ما زال أثقل | **أخف بوضوح** |
| نضج النظام البيئي والتوثيق والتوظيف | **أفضل بفارق واضح** | ينمو بسرعة |
| JSONB typing | متوسط | متوسط |
| مرونة عند تعقّد الاستعلامات | يصطدم بالسقف أحياناً | **يندر أن يصطدم** |

### التوصية: **Prisma** — مع استخدام SQL خام صريح للتحليلات

**السبب:** أهم عامل خطر في هذا المشروع ليس أداء الـ ORM — بل **سلامة الـ Migrations وسرعة الفريق**.
Prisma يتفوق فيهما بوضوح. استعلاماتنا في المسار الحرج بسيطة جداً (`findUnique` على snapshot)،
والاستعلامات المعقّدة كلها في Analytics حيث سنكتب SQL خاماً مقصوداً في `packages/db/analytics/`.

**عوامل التخفيف من عيوب Prisma:**
- Connection pooling عبر Neon serverless driver / PgBouncer (يحل مشكلة serverless).
- استعلامات التحليلات في مجلد واحد بـ SQL خام + اختبارات تكامل عليها.

**متى نبدّل إلى Drizzle:** إن تجاوزت Cold start حدود ميزانية الأداء، أو تجاوزت نسبة `$queryRaw`
30% من الاستعلامات. القرار قابل للانعكاس بتكلفة معقولة لأن الوصول للبيانات معزول في `packages/db`.

📄 [ADR-0003](adr/0003-postgresql-and-prisma.md)

---

## 4. المصادقة

| الخيار | المزايا | العيوب | الحكم |
|--------|---------|--------|-------|
| **Auth.js v5 + Prisma adapter** | مجاني، البيانات عندنا، جلسات DB قابلة للإبطال، OAuth جاهز | إعداد أكثر، توثيق v5 متقلّب | ✅ **موصى به** |
| Clerk | أسرع إعداد، UI جاهز، 2FA/organizations | ~$25+/شهر ويتصاعد، قفل مزوّد، بيانات المستخدمين خارجاً، تعريب محدود | ❌ |
| Supabase Auth | متكامل، مجاني بسخاء | يجرّنا لكامل حزمة Supabase | ⚠️ لو اخترنا Supabase للـ DB |
| مخصص بالكامل | تحكم كامل | نعيد اختراع OAuth وتدوير الجلسات وسلاسل الهجوم | ❌ |

**تفاصيل القرار:**
- **جلسات قاعدة بيانات (opaque token في httpOnly cookie)** وليس JWT للجلسات.
  السبب: الإبطال الفوري (تسجيل خروج من كل الأجهزة، إيقاف حساب مسيء) — وهذا متطلب تشغيلي حقيقي.
- كلمات المرور: **argon2id** (لا bcrypt) بمعاملات موصى بها من OWASP.
- Cookie: `HttpOnly; Secure; SameSite=Lax; Path=/; __Host-` prefix.
- JWT يُستخدم فقط لأغراض قصيرة العمر وموقّعة: روابط الوسائط، تفعيل البريد، رموز الضيوف.

📄 [ADR-0006](adr/0006-database-sessions-not-jwt.md) · التفاصيل في [09-auth-and-rbac.md](09-auth-and-rbac.md)

---

## 5. التنسيق والـ UI

### Styling: **Tailwind CSS v4 + CSS Custom Properties**

لماذا هذا المزيج تحديداً — والسبب مرتبط مباشرة بمحرّك القوالب:

```
Theme المستخدم  →  CSS Custom Properties  →  تُحقن inline في <style> على الصفحة العامة
                                            →  صفر JavaScript لتطبيق الثيم
                                            →  لا وميض FOUC
                                            →  Tailwind يستهلك المتغيرات
```

```css
/* الثيم كمتغيرات — قابل للتغيير لحظياً في المعاينة */
:root {
  --zf-color-primary: #b8860b;
  --zf-color-surface: #fffdf8;
  --zf-font-display: "Aref Ruqaa", serif;
  --zf-radius-button: 999px;
}
```

| البديل | لماذا لا |
|--------|----------|
| CSS-in-JS (styled-components / Emotion) | تكلفة runtime على الصفحة الحرجة، ومشاكل مع RSC |
| Panda CSS / vanilla-extract | ممتازان تقنياً، لكن نضج ونظام بيئي أقل ومنحنى تعلّم أعلى |
| CSS Modules فقط | يفتقد نظام تصميم متسق وسرعة التطوير |

**قرار RTL:** نستخدم **CSS Logical Properties حصراً** (`margin-inline-start` بدل `margin-left`).
Tailwind v4 يدعمها أصلاً (`ms-4`, `me-4`, `ps-2`). ممنوع استخدام `left/right` في أي مكون مشترك —
قاعدة ESLint مخصصة تمنع ذلك في CI.

### المكوّنات: **Radix UI Primitives** (headless) + مكوّناتنا فوقها

نبني `packages/ui` بأنفسنا فوق Radix. لا نستورد مكتبة UI جاهزة كاملة لأن الهوية البصرية
(الفخامة، الطابع العربي) هي جوهر المنتج ولا يمكن أن تكون Bootstrap-ish.
Radix يعطينا إمكانية الوصول (a11y) والسلوك الصحيح للقوائم والحوارات مجاناً.

---

## 6. Object Storage

| الخيار | التكلفة/GB/شهر | Egress | S3 API | الحكم |
|--------|-----------------|--------|--------|-------|
| **Cloudflare R2** | $0.015 | **مجاني** | ✅ | ✅ **موصى به** |
| AWS S3 | $0.023 | $0.09/GB — **قاتل** | ✅ | ❌ للـ egress |
| Supabase Storage | $0.021 | محدود ثم مدفوع | ✅ | ⚠️ |
| Backblaze B2 | $0.006 | مجاني عبر Cloudflare | ✅ | بديل جيد |

**الحاسم:** منتجنا **يبثّ صوراً بكثافة**. دعوة واحدة × 300 ضيف × 8 صور × 200KB ≈ **480MB egress للدعوة الواحدة**.
عند 1000 دعوة/شهر = 480GB egress. على S3 = **$43/شهر egress وحده**. على R2 = **$0**.
هذا فرق يتضاعف مع النمو ويحوّل بند تكلفة صغير إلى بند رئيسي.

📄 [ADR-0007](adr/0007-cloudflare-r2-object-storage.md)

---

## 7. تحويل الصور

| الخيار | كيف | التكلفة | الحكم |
|--------|-----|---------|-------|
| **Cloudflare Images (Transformations)** | تحويل عند الطلب من R2 عبر URL | $0.50 / 1000 صورة فريدة | ✅ **موصى به** |
| Sharp في worker | معالجة عند الرفع، تخزين مقاسات متعددة | مجاني (CPU) + تخزين ×4 | ✅ بديل جيد |
| next/image الافتراضي | تحويل على الخادم | مكلف على Vercel، ضغط على الأصل | ❌ للصفحة العامة |
| imgproxy مستضاف ذاتياً | تحكم كامل | إدارة إضافية | Phase 3 |

**التوصية (مزيج):**
- عند الرفع: worker يستخدم **Sharp** لإنتاج 3 مقاسات (thumb 400w, medium 1080w, full 1920w) بصيغة **AVIF + WebP + JPEG fallback**، ويجرّد كل الـ EXIF (مهم للخصوصية — الصور تحمل GPS!).
- عند العرض: روابط مباشرة من R2 عبر CDN، بلا تحويل وقت الطلب → أسرع وأرخص وأثبت.

---

## 8. Cache و Queue

### Redis: **Upstash** (Serverless, HTTP-based)

- Rate limiting (الاستخدام الأساسي).
- طابور المهام عبر BullMQ في `apps/worker`.
- تخزين مؤقت لبيانات مشتقة (عدّادات RSVP، تجميعات analytics).

| البديل | الحكم |
|--------|-------|
| Postgres كطابور (`SELECT FOR UPDATE SKIP LOCKED`) | ✅ **مقبول جداً كبداية** — أقل مكوّن للصيانة. لكن Rate limiting عليه يضغط على OLTP. |
| Redis مُدار (Railway/Fly) | جيد، تكلفة ثابتة |
| SQS/Cloud Tasks | قفل مزوّد بلا داعٍ في هذا الحجم |

**التوصية:** Upstash Redis. **لكن** إن أردنا تقليل عدد المكوّنات في MVP، طابور Postgres
+ rate limiting داخل الذاكرة (لكل instance) خيار مقبول لأول 3 أشهر. **قرار #9.**

---

## 9. البريد

**Resend** — DX ممتاز، قوالب React Email، تسعير معقول، سمعة تسليم جيدة.
البدائل: Postmark (أفضل تسليم للمعاملات، أغلى) · AWS SES (أرخص، إعداد وسمعة أصعب).

⚠️ **تنبيه تشغيلي:** قابلية تسليم البريد في المنطقة العربية متفاوتة، خصوصاً للعربية وللمجالات الجديدة.
يجب: SPF + DKIM + DMARC من اليوم الأول، وتسخين المجال تدريجياً، ومراقبة معدل الارتداد.
البريد في مسار تفعيل الحساب = مسار حرج، تعطّله يعطّل النشر.

---

## 10. الاستضافة

| الخيار | web | worker | التكلفة الأولية | ملاحظات |
|--------|-----|--------|------------------|---------|
| **Vercel + Fly.io** | Vercel | Fly | ~$20 + ~$5 | أفضل DX وأداء ISR؛ خطر تصاعد تكلفة الـ bandwidth |
| Fly.io بالكامل | Fly | Fly | ~$15 | تكلفة متوقعة، تحكم أعلى، عمل إعداد أكثر |
| Railway بالكامل | Railway | Railway | ~$20 | بساطة جيدة، ISR أقل تحسيناً |
| Hetzner + Coolify | VPS | VPS | ~$12 | الأرخص بفارق، لكن أنت مسؤول عن كل شيء |
| Cloudflare Workers | — | — | رخيص جداً | قيود على Node APIs تعقّد Prisma و Sharp |

**التوصية لـ Phase 1:** **Vercel للويب + Fly.io للـ worker.**
السبب: ISR والـ Edge caching للصفحة العامة يعملان بأقل جهد على Vercel، وسرعة الإطلاق أهم شيء الآن.
**مع ضبط حارس تكلفة:** تنبيه عند تجاوز الفاتورة $100/شهر، وخطة هجرة موثّقة إلى Fly/Hetzner جاهزة مسبقاً.

⚠️ **خطر معروف:** Vercel bandwidth مكلف عند النمو. عوامل التخفيف:
كل الوسائط من R2 عبر Cloudflare (لا تمرّ بـ Vercel أبداً)، وHTML مخزَّن على Cloudflare أمام Vercel.
هذا يبقي حركة Vercel صغيرة جداً. **قرار #3.**

---

## 11. الاختبارات

| النوع | الأداة | لماذا |
|-------|--------|-------|
| Unit | **Vitest** | سريع، متوافق مع Vite/ESM، API شبيه بـ Jest |
| Integration | **Vitest + Testcontainers** | Postgres حقيقي في Docker — لا mocks تكذب |
| E2E | **Playwright** | متعدد المتصفحات، **WebKit ضروري لمحاكاة iOS Safari**، محاكاة أجهزة، تتبع ممتاز |
| Visual regression | **Playwright screenshots** | القوالب منتج بصري — الانحدار البصري = عيب حقيقي |
| Performance | **Lighthouse CI** | ميزانيات أداء كـ required check |
| Security | **Playwright + مصفوفة تفويض مخصصة** | IDOR / tenant isolation |
| Load | k6 | قبل الإطلاق فقط |

**رفض Cypress:** دعم WebKit غير موجود عملياً، وهو غير قابل للتفاوض لأن معظم زوارنا على iOS Safari.

---

## 12. i18n

**next-intl** — تكامل أصلي مع App Router و RSC، توجيه حسب اللغة، تنسيق تواريخ/أرقام بـ ICU.

البدائل: `next-i18next` (مبني لـ Pages Router) · `Lingui` (ممتاز، أثقل إعداداً) · `react-intl` (بلا تكامل routing).

**قرارات مرتبطة:**
- التوجيه: `/ar/...` و `/en/...` مع `ar` كافتراضي.
- **الصفحة العامة تستخدم لغة الدعوة لا لغة الزائر** — دعوة عربية تظهر عربية للجميع. (تجاوز يدوي متاح)
- الأرقام: أرقام عربية-هندية (٠١٢٣) أم غربية (0123)؟ → **غربية افتراضياً** لأنها أوضح في التواريخ والعد التنازلي في الخليج، مع خيار في القالب. **قرار #12.**

📄 [ADR-0011](adr/0011-i18n-and-rtl-strategy.md)

---

## 13. الخطوط

هذا ليس تفصيلاً تجميلياً — **الخط هو 70% من الإحساس بالفخامة**، وسوء التعامل مع العربية يقتل المنتج.

| الاستخدام | العربية | اللاتينية | الترخيص |
|-----------|---------|-----------|---------|
| Display (الأسماء، العناوين الكبيرة) | **Aref Ruqaa** / **Amiri** | **Cormorant Garamond** | OFL ✅ |
| Display بديل (حديث) | **Reem Kufi** | **Playfair Display** | OFL ✅ |
| Body | **IBM Plex Sans Arabic** / **Tajawal** | **Inter** | OFL ✅ |
| UI (لوحة التحكم) | **IBM Plex Sans Arabic** | **Inter** | OFL ✅ |

**قواعد إلزامية:**
- كل الخطوط **OFL / مفتوحة الترخيص**. ممنوع خط تجاري بلا رخصة موثّقة.
- استضافة ذاتية (self-hosted) بصيغة `woff2` + `font-display: swap` + `preload` للخط الحرج فقط.
- **Subsetting إلزامي** — خطوط العربية ضخمة (Amiri > 400KB كاملاً). التقسيم إلى نطاق عربي أساسي يخفضه إلى ~90KB.
- `line-height` للعربية أكبر (1.8–2.0 للنص) — التشكيل والنقاط تحتاج مساحة.
- ممنوع `letter-spacing` على النص العربي — يكسر الاتصال بين الحروف.

---

## 14. الحركات (Animations)

| الطبقة | التقنية | لماذا |
|--------|---------|-------|
| الصفحة العامة | **CSS + IntersectionObserver** فقط | صفر تكلفة JS. انظر [ADR-0010](adr/0010-css-first-animations.md) |
| Builder / Dashboard | Motion (framer-motion) | تفاعلات معقدة، ووزن الحزمة أقل حساسية هنا |
| تأثيرات خاصة (بتلات، لمعان) | Canvas خفيف مخصص، يُحمَّل كسولاً، ويُعطَّل تلقائياً على الأجهزة الضعيفة | مكتبات الجسيمات ثقيلة جداً |

**قواعد إلزامية:**
- `@media (prefers-reduced-motion: reduce)` تُعطّل كل الحركات.
- زر ظاهر «إيقاف الحركات» في الدعوة.
- تُحرَّك خصائص `transform` و `opacity` فقط (لا `top/left/width` — تسبب reflow).
- كشف الأجهزة الضعيفة (`navigator.hardwareConcurrency ≤ 4` أو `deviceMemory ≤ 4`) → تعطيل التأثيرات الثقيلة.

---

## 15. ما استُبعد صراحة

| التقنية | السبب |
|---------|-------|
| tRPC | ممتاز، لكنه يشدّنا لعميل TypeScript واحد ويصعّب فتح API لاحقاً. REST + Zod يعطي 90% من الفائدة بلا القيد. |
| Redux / MobX | حالة الخادم عبر TanStack Query، وحالة الـ Builder محلية بـ reducer. لا حاجة لمخزن عام. |
| Storybook | مفيد لكن تكلفة صيانته في هذه المرحلة أعلى من عائده. نعيد النظر عند تعدد المصممين. |
| Docker في الإنتاج للويب | المنصات المُدارة تتولى ذلك. Docker للتطوير المحلي والـ worker فقط. |
| Terraform في Phase 1 | البنية بسيطة والإعداد اليدوي موثّق يكفي. نضيفه في Phase 2 عند تعدد البيئات. |
| Kubernetes | overkill بمرتبتين. |

---

## 16. جدول القرارات المفتوحة من هذه الوثيقة

| # | القرار | التوصية | مرجع |
|---|--------|---------|------|
| 1 | Framework: full-stack أم API منفصل | Next.js full-stack + core معزول | §1 |
| 2 | ORM: Prisma أم Drizzle | Prisma | §3 |
| 3 | الاستضافة: Vercel أم بديل موحّد | Vercel + Fly، مع خطة هجرة | §10 |
| 9 | Redis من البداية أم Postgres-only | Upstash Redis | §8 |
| 12 | شكل الأرقام في العربية | غربية افتراضياً | §12 |

القائمة الكاملة في [19-decisions-pending-approval.md](19-decisions-pending-approval.md).
