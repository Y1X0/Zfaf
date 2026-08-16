# 19 — Architecture Decisions Record of Approval

**الإصدار:** v1.0 · **الحالة:** ✅ **APPROVED** · **تاريخ الموافقة:** 2026-08-16

> **Phase 0 معتمدة.** هذه الوثيقة هي **سجل القرارات المثبَّتة** — لم تعد قائمة أسئلة.
> كل قرار هنا نافذ ومُلزم للتنفيذ. أي انحراف عنه يحتاج ADR جديداً وموافقة صريحة.
>
> الاسم الأصلي للملف محفوظ للحفاظ على الروابط الخارجية.

---

## ملخص التنفيذ

| البند | الحالة |
|-------|--------|
| Phase 0 — Architecture | ✅ معتمدة |
| القرارات الحاجبة (6) | ✅ مثبَّتة |
| القرارات المهمة (8) | ✅ مثبَّتة، **مع تعديلين** |
| الـ ADRs | ✅ 14 → `Accepted` · + 3 ADRs جديدة (0015–0017) |
| Phase 1 | ✅ **مأذون بالبدء** — بعد تثبيت هذه الوثائق |
| Phase 2 / Phase 3 | ⛔ **خارج النطاق تماماً** حتى إغلاق Phase 1 |

---

## 1. القرارات المعتمدة كما هي

| # | القرار | ما اعتُمد | ADR |
|---|--------|-----------|-----|
| 1 | بنية التطبيق | Next.js full-stack + `packages/core` معزول | [0002](adr/0002-nextjs-fullstack-over-separate-api.md) |
| 2 | ORM | PostgreSQL 16 + Prisma 6 | [0003](adr/0003-postgresql-and-prisma.md) |
| 3 | الاستضافة | Vercel (web) + Fly.io (worker)، مع خطة هجرة موثّقة | [16 §4](16-cost-estimate.md) |
| 4 | نطاق MVP | **بلا بوابة دفع** — التجريد فقط | [0008](adr/0008-payment-provider-abstraction.md) |
| 5 | مساحة الروابط | `zfaf.app/i/{slug}` | [0013](adr/0013-slug-and-reserved-words.md) |
| 6 | التسعير | مؤجَّل حتى إثبات PMF | [0014](adr/0014-entitlements-over-plan-checks.md) |
| 8 | عدد القوالب | 3 قوالب، الثالث مختلف جذرياً | [0004](adr/0004-json-template-manifest.md) |
| 9 | Redis | Upstash Redis من Phase 1 | [02 §8](02-technology-choices.md) |
| 10 | البريد | Resend + SPF/DKIM/DMARC | [02 §9](02-technology-choices.md) |
| 12 | شكل الأرقام | غربية افتراضياً، خيار في الثيم | [0011](adr/0011-i18n-and-rtl-strategy.md) |
| 13 | الفهرسة | `noindex` افتراضياً | [0017](adr/0017-invitation-visibility-model.md) |
| 15–20 | قرارات للعلم | كما وردت | ADRs 0010–0014 |

---

## 2. القرارات المعدَّلة بأمر المالك

### 🔄 القرار 7 — QR Code: **داخل MVP** (كان Phase 2)

**القرار المثبَّت:** QR Code جزء من Phase 1، **بأبسط شكل ممكن**.

**النطاق المسموح في MVP — لا أكثر:**
```
✅ توليد QR من الرابط العام مباشرة (static)
✅ تحميل PNG و SVG
✅ توليد محلي بلا أي خدمة خارجية
⛔ لا Dynamic QR
⛔ لا تتبع مسح (scan analytics)
⛔ لا QR مخصص التصميم (شعار، ألوان، إطارات)
⛔ لا رموز لكل ضيف
```

**المبرر المعتمد:** تكلفة منخفضة، قيمة عملية عالية، **قناة توزيع مستقلة عن WhatsApp**
(تخفيف مباشر لخطر B5)، قابل للطباعة على البطاقات ولوحات القاعة.

**التوثيق:** [ADR-0016](adr/0016-static-qr-in-mvp.md) · تحديث `FR-D9` في [PRD](00-product-requirements.md) من `2` إلى `M`.

---

### 🔄 القرار 11 + 14 — السوق والمدفوعات والضريبة

**القرار المثبَّت:**

**(أ) السوق الأول: السعودية.** المنتج الأول موجّه للسوق السعودي.

**(ب) لكن ممنوع أي ترميز صلب (hard-coding) للسعودية.** التالي **يجب** أن يكون قابلاً للتكوين
كبيانات لا كود:

| العنصر | آلية التكوين |
|--------|---------------|
| العملة | إعداد سوق + مخزَّن مع كل مبلغ |
| اللغة والتوطين | `locale` قائم أصلاً (ar/en) |
| المنطقة الزمنية الافتراضية | إعداد سوق |
| **الضريبة** | **محرّك قواعد بيانات-driven — بلا أي افتراض مُبرمَج** |
| مزوّد الدفع | Port/Adapter + اختيار وقت التشغيل |
| صيغة أرقام الهواتف | إعداد سوق |

**المعيار القاطع:** *إضافة الكويت أو الإمارات لاحقاً = صف إعدادات + محوّل دفع.
**لا إعادة بناء لطبقة الفوترة.***

**(ج) لا افتراضات قانونية أو ضريبية.**

> ⚠️ **مثبَّت صراحةً:** لن يُكتَب أي منطق ضريبي أو فوترة إلكترونية مبني على افتراضاتي.
> جدول `tax_rules` سيوجد **فارغاً وقابلاً للتكوين**، والحقول ستُترك للتعبئة بعد التحقق مع مختص.
> **الافتراض الوحيد المسموح في MVP: لا حساب ضريبة إطلاقاً — لأنه لا يوجد دفع.**

**التوثيق:** [ADR-0015](adr/0015-market-configuration-model.md) · تحديث [ADR-0008](adr/0008-payment-provider-abstraction.md) و [11-payments-architecture.md](11-payments-architecture.md).

---

## 3. التوجيهات الإلزامية المضافة

هذه ليست قرارات جديدة بل **قيود تنفيذ مُلزِمة** أضافها المالك:

### 3.1 محرك القوالب — المبدأ الحاكم

> **«Adding a new template should normally require data/assets/configuration, not new application logic.»**

شروط الـ Manifest المُلزِمة: مُتحقَّق بالمخطط · مُصدَّر (versioned) · مُنقّى (sanitized)
· **لا تنفيذ كود عشوائي** · **لا HTML/JS عشوائي** · قابل للترحيل مستقبلاً.

**قاعدة التوقف (Stop-the-line):**
> إذا اضطررنا لإضافة **Renderer-specific hack** للقالب الثالث —
> **نتوقف ونراجع المعمارية، ولا نبني workaround.**

هذا مثبَّت كـ **بوابة خروج رسمية** لـ Milestone M3 في [20-phase1-milestones.md](20-phase1-milestones.md).

### 3.2 عزل `packages/core`

- قابل للاختبار **مستقلاً بالكامل** — بلا Next.js، بلا HTTP، بلا Prisma، بلا شبكة.
- الـ Renderer **deterministic** قدر الإمكان.
- **الهدف المعلن: What You See Is What Gets Published.**
  المعاينة والصفحة المنشورة تستخدمان **نفس منطق العرض** — لا نسختين.

### 3.3 `StorageProvider` abstraction

R2 معتمد، لكن خلف واجهة تدعم إلزامياً:
`Upload` · `Delete` · `Signed access` · `Metadata` · `Content-Type validation` · `File size limits`
\+ تحسين الصور + **تجريد EXIF**.

### 3.4 EntitlementService — إلزامي من Phase 1

ممنوع `if (paid === true)` أو ما يماثله. النماذج المستقبلية التي **يجب** أن تستوعبها البنية:
`Free` · `Premium` · `Lifetime` · `Subscription` · `Wedding Planner` · `Promotional access` · `Admin grants`.

### 3.5 نموذج الخصوصية — توضيح مُلزَم

> **`noindex` لا يعني «سرّي».** الرابط الذي يملكه شخص يمكن مشاركته.

**مطلوب توثيق الفرق بوضوح** بين:
- **Public / Unlisted** (MVP) — من يملك الرابط يرى الدعوة.
- **Private / Protected** (Phase لاحق) — يتطلب كلمة مرور أو رمز ضيف.

يجب أن يكون هذا واضحاً **في الواجهة للمستخدم** لا في الوثائق فقط.
📄 [ADR-0017](adr/0017-invitation-visibility-model.md)

### 3.6 التحليلات — نطاق مقلَّص في MVP

```
✅ Views
✅ Unique visitors (privacy-conscious)
✅ RSVP counts
✅ Basic device information
⛔ لا منصة تتبع
⛔ لا PII غير ضروري
```
حُذف من MVP: تصنيف مصدر الزيارة، تفصيل الدول، السلاسل الزمنية المتقدمة → Phase 2.

### 3.7 الموسيقى

- MVP: موسيقى **مرخّصة/أصلية فقط**، مع **توثيق مصدر كل أصل صوتي**.
- **قرار تكليف 8–12 مقطعاً أصلياً: مؤجَّل** حتى إثبات MVP.
- لا رفع من المستخدمين بلا سياسة واضحة → **لا رفع في MVP**.

### 3.8 Milestones — لا عبارات عامة

كل Milestone يجب أن يحمل: `Scope` · `Deliverables` · `Dependencies` · `Tests`
· `Acceptance Criteria` · `Estimated Effort` · `Exit Criteria`.

**ممنوع «Feature completed».** + تحليل صريح لـ: ما يتوازى، ما يحجب، ما يعتمد على قرار خارجي، ما يمكن تأجيله.

📄 **[20-phase1-milestones.md](20-phase1-milestones.md)** — منشأة استجابةً لهذا التوجيه.

### 3.9 تقدير 13–17 أسبوع-مهندس

> **مثبَّت: هذا الرقم ليس التزاماً زمنياً.**

فُكّك إلى تقدير لكل Milestone مع تحليل التوازي والحجب في [20-phase1-milestones.md §12](20-phase1-milestones.md).

---

## 4. حدود النطاق — مُلزِمة

```
✅ مسموح:  Phase 1 فقط، حسب 20-phase1-milestones.md
⛔ ممنوع:  أي عمل من Phase 2 أو Phase 3
⛔ ممنوع:  توسيع النطاق بلا موافقة صريحة
⛔ ممنوع:  بوابة دفع
⛔ ممنوع:  رفع موسيقى من المستخدمين
⛔ ممنوع:  إدارة ضيوف / روابط فردية
⛔ ممنوع:  نطاقات مخصصة
⛔ ممنوع:  لوحة إدارة كاملة (kill switch + قراءة فقط)
⛔ ممنوع:  Dynamic QR / تتبع مسح
```

**الهدف المعلن:** *«إنتاج MVP حقيقي قابل للاختبار، وليس بناء كل الـ roadmap دفعة واحدة.»*

---

## 5. حالة الـ ADRs بعد الموافقة

| ADR | العنوان | الحالة |
|-----|---------|--------|
| 0001 | Monorepo + Modular Monolith | ✅ Accepted |
| 0002 | Next.js full-stack | ✅ Accepted |
| 0003 | PostgreSQL + Prisma | ✅ Accepted |
| 0004 | JSON Template Manifest | ✅ Accepted |
| 0005 | Published Snapshot Versioning | ✅ Accepted |
| 0006 | Database Sessions | ✅ Accepted |
| 0007 | Cloudflare R2 | ✅ Accepted — **معدَّل:** StorageProvider إلزامي |
| 0008 | Payment Provider Abstraction | ✅ Accepted — **معدَّل:** لا افتراضات ضريبية |
| 0009 | Cookieless Analytics | ✅ Accepted — **معدَّل:** نطاق MVP مقلَّص |
| 0010 | CSS-first Animations | ✅ Accepted |
| 0011 | i18n & RTL | ✅ Accepted |
| 0012 | Licensed Music Library | ✅ Accepted — **معدَّل:** التكليف مؤجَّل |
| 0013 | Slug & Reserved Words | ✅ Accepted |
| 0014 | Entitlements | ✅ Accepted — **مؤكَّد إلزامياً** |
| **0015** | **Market Configuration Model** | 🆕 Accepted |
| **0016** | **Static QR in MVP** | 🆕 Accepted |
| **0017** | **Invitation Visibility Model** | 🆕 Accepted |

---

## 6. ما يحدث الآن

```
① ✅ تثبيت القرارات في الوثائق و ADRs        ← هذه الخطوة
② ✅ إنشاء 20-phase1-milestones.md بالتفصيل المطلوب
③ ▶️ بدء Phase 1 — Milestone M0 (Foundation)
④    التنفيذ Milestone تلو Milestone، ببوابة خروج لكل واحد
⑤    توقف عند بوابة M3 لمراجعة صحة محرك القوالب
```

**الالتزامات المُلزِمة أثناء التنفيذ:**
- لا انتقال لـ Milestone تالٍ قبل استيفاء Exit Criteria للحالي.
- لا عمل خارج نطاق Phase 1.
- التوقف والمراجعة إن احتاج القالب الثالث تعديلاً في الـ Renderer.
- الإبلاغ الفوري عن أي قرار معماري يتبيّن خطؤه.
