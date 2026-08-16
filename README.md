# Zfaf — منصة دعوات الزفاف الرقمية التفاعلية

> **حالة المشروع الحالية: Phase 0 — Architecture.**
> لا يوجد أي production code في هذا المستودع حتى الآن، وهذا مقصود.
> المخرج الحالي هو وثيقة معمارية كاملة تحتاج مراجعة وموافقة قبل بدء التنفيذ.

---

## ما هذا المشروع؟

منصة SaaS لإنشاء **دعوات زفاف رقمية تفاعلية**. المستخدم ينشئ حساباً، يختار قالباً،
يدخل بيانات الحفل، يخصّص التصميم، ينشر — ويحصل على رابط عام مثل:

```
https://zfaf.app/i/ahmad-sarah
```

يُفتح الرابط من WhatsApp على الهاتف فيعرض تجربة زفاف فاخرة: عد تنازلي، معرض صور،
موسيقى، خريطة، RSVP، مشاركة، QR Code.

**القيمة الحقيقية ليست في صفحة الدعوة** — بل في: Template Engine + Builder +
Publishing + RSVP + Guest Management + Analytics + Payments + Admin.

---

## 📚 وثائق Architecture v0.1

اقرأها بالترتيب التالي إن كانت هذه أول مرة:

| # | الوثيقة | المحتوى |
|---|---------|---------|
| 00 | [Product Requirements](docs/00-product-requirements.md) | تحليل المتطلبات، الشخصيات، User Journeys، تحديد MVP الحقيقي، Definition of Done |
| 01 | [System Architecture](docs/01-system-architecture.md) | المعمارية العامة، C4 diagrams، حدود المكوّنات، Request flows |
| 02 | [Technology Choices](docs/02-technology-choices.md) | مقارنة البدائل لكل قرار تقني مع توصية مبرّرة |
| 03 | [Database & ERD](docs/03-database-erd.md) | ERD كامل، وصف كل جدول، الفهارس، قرارات النمذجة |
| 04 | [API Specification](docs/04-api-specification.md) | تصميم الـ API، كل الـ endpoints، أشكال الأخطاء، Idempotency |
| 05 | [Template Engine](docs/05-template-engine.md) | أهم قطعة تقنية: Schema، Registry، Renderer، Versioning |
| 06 | [Invitation Builder & Preview](docs/06-invitation-builder.md) | الـ Wizard، Autosave، Live Preview، Draft/Publish |
| 07 | [Frontend Architecture](docs/07-frontend-architecture.md) | بنية الواجهة، i18n/RTL، Typography، Animation، Performance budgets |
| 08 | [Backend Architecture](docs/08-backend-architecture.md) | الطبقات، Domain modules، Jobs، Modular monolith وشروط التقسيم |
| 09 | [Auth & RBAC](docs/09-auth-and-rbac.md) | نموذج المصادقة، الجلسات، الأدوار، Tenant Isolation، Guest tokens |
| 10 | [Storage & Media](docs/10-storage-and-media.md) | Object Storage، رفع آمن، تحويل الصور، CDN، Music licensing |
| 11 | [Payments & Billing](docs/11-payments-architecture.md) | Provider abstraction، Webhooks، Entitlements، الاسترداد |
| 12 | [Security Threat Model](docs/12-security-threat-model.md) | STRIDE، الضوابط، Abuse prevention، Privacy |
| 13 | [Testing Strategy](docs/13-testing-strategy.md) | Unit / Integration / E2E / Security / Performance |
| 14 | [CI/CD & Deployment](docs/14-cicd-and-deployment.md) | Pipelines، البيئات، Migrations، Rollback |
| 15 | [Observability & DR](docs/15-observability-and-dr.md) | Logging، Metrics، Backups، RPO/RTO |
| 16 | [Cost Estimate](docs/16-cost-estimate.md) | تكلفة التشغيل على 3 مستويات نمو + Unit economics |
| 17 | [Roadmap — Phases](docs/17-roadmap-phases.md) | Phase 1/2/3 مع Epics وترتيب التنفيذ |
| 18 | [Risks Register](docs/18-risks.md) | المخاطر التقنية والتجارية والقانونية + التخفيف |
| 19 | [**Decisions Pending Approval**](docs/19-decisions-pending-approval.md) | ⚠️ **ابدأ من هنا إن كان وقتك ضيقاً** — 18 قراراً تحتاج موافقتك |

### Architecture Decision Records

| ADR | القرار | الحالة |
|-----|--------|--------|
| [0001](docs/adr/0001-monorepo-and-modular-monolith.md) | Monorepo + Modular Monolith بدل Microservices | Proposed |
| [0002](docs/adr/0002-nextjs-fullstack-over-separate-api.md) | Next.js full-stack بدل NestJS/FastAPI منفصل | Proposed |
| [0003](docs/adr/0003-postgresql-and-prisma.md) | PostgreSQL + Prisma ORM | Proposed |
| [0004](docs/adr/0004-json-template-manifest.md) | Template = JSON manifest مُتحقَّق بـ Zod (لا React لكل قالب) | Proposed |
| [0005](docs/adr/0005-published-snapshot-versioning.md) | نشر عبر Immutable Snapshot بدل القراءة الحية | Proposed |
| [0006](docs/adr/0006-database-sessions-not-jwt.md) | Database sessions في httpOnly cookies بدل JWT | Proposed |
| [0007](docs/adr/0007-cloudflare-r2-object-storage.md) | Cloudflare R2 كـ Object Storage | Proposed |
| [0008](docs/adr/0008-payment-provider-abstraction.md) | Payment Provider Port/Adapter + Webhook-driven | Proposed |
| [0009](docs/adr/0009-cookieless-analytics.md) | Analytics بدون Cookies وبدون تخزين IP | Proposed |
| [0010](docs/adr/0010-css-first-animations.md) | Animations بالـ CSS أولاً على الصفحة العامة | Proposed |
| [0011](docs/adr/0011-i18n-and-rtl-strategy.md) | next-intl + CSS Logical Properties للـ RTL | Proposed |
| [0012](docs/adr/0012-licensed-music-library.md) | مكتبة موسيقى مرخّصة مركزياً + رفع مقيّد | Proposed |
| [0013](docs/adr/0013-slug-and-reserved-words.md) | Slug namespace تحت `/i/` مع Reserved words | Proposed |
| [0014](docs/adr/0014-entitlements-over-plan-checks.md) | Entitlements Service بدل `if (plan === 'premium')` | Proposed |

---

## 🚦 الخطوة التالية

1. راجع **[docs/19-decisions-pending-approval.md](docs/19-decisions-pending-approval.md)**.
2. وافق / عدّل القرارات المفتوحة.
3. عند الموافقة → نبدأ **Phase 1 (MVP)** فقط، حسب [Roadmap](docs/17-roadmap-phases.md).

> ممنوع الانتقال إلى Phase 2 قبل إغلاق Phase 1 واجتياز Definition of Done بالكامل.

---

## بنية المستودع المخطَّطة (لم تُنشأ بعد)

```
apps/
  web/                  Next.js — Landing + Auth + Dashboard + Builder + Public invitation
  admin/                لوحة الإدارة (Phase 2 — قد تبدأ كـ route group داخل web)
  worker/               Background jobs (images, emails, webhooks, cleanup)
packages/
  core/                 Domain logic خالص — لا يعرف Next.js ولا HTTP
  db/                   Prisma schema + migrations + repositories
  template-engine/      Manifest schema + registry + validation
  invitation-renderer/  React renderer للدعوة (يُستخدم في Preview والصفحة العامة)
  ui/                   Design system مشترك
  shared/               Zod schemas, types, errors, utils, i18n messages
  config/               eslint / tsconfig / tailwind presets
infra/                  Terraform / Docker / بيئات
docs/                   هذه الوثائق
tests/                  E2E + security suites
```

---

## قواعد المساهمة الأساسية

- ❌ لا secrets في Git — إطلاقاً. (`gitleaks` في CI كـ required check)
- ❌ لا authorization في الـ Frontend — كل تحقق server-side.
- ❌ لا ملفات كبيرة في PostgreSQL.
- ✅ كل مدخلات المستخدم تمرّ عبر Zod schema.
- ✅ كل قرار تقني مهم يحتاج ADR.
- ✅ CI أخضر شرط للـ merge.
