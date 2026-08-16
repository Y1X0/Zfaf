# Zfaf — منصة دعوات الزفاف الرقمية التفاعلية

> **حالة المشروع: Phase 0 ✅ معتمدة · Phase 1 ▶️ قيد التنفيذ.**
> القرارات المعمارية مثبَّتة في [سجل الموافقة](docs/19-decisions-pending-approval.md).
> التنفيذ يسير حسب [Phase 1 Milestones](docs/20-phase1-milestones.md) — Phase 1 **فقط**.

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
| 19 | [**Decisions — Record of Approval**](docs/19-decisions-pending-approval.md) | ✅ القرارات المثبَّتة والمعتمدة (مع التعديلات) |
| 20 | [**Phase 1 Milestones**](docs/20-phase1-milestones.md) | ▶️ **خطة التنفيذ الحالية** — 11 milestone بمعايير خروج |

### Architecture Decision Records

| ADR | القرار | الحالة |
|-----|--------|--------|
| [0001](docs/adr/0001-monorepo-and-modular-monolith.md) | Monorepo + Modular Monolith بدل Microservices | ✅ Accepted |
| [0002](docs/adr/0002-nextjs-fullstack-over-separate-api.md) | Next.js full-stack بدل NestJS/FastAPI منفصل | ✅ Accepted |
| [0003](docs/adr/0003-postgresql-and-prisma.md) | PostgreSQL + Prisma ORM | ✅ Accepted |
| [0004](docs/adr/0004-json-template-manifest.md) | Template = JSON manifest مُتحقَّق بـ Zod (لا React لكل قالب) | ✅ Accepted |
| [0005](docs/adr/0005-published-snapshot-versioning.md) | نشر عبر Immutable Snapshot بدل القراءة الحية | ✅ Accepted |
| [0006](docs/adr/0006-database-sessions-not-jwt.md) | Database sessions في httpOnly cookies بدل JWT | ✅ Accepted |
| [0007](docs/adr/0007-cloudflare-r2-object-storage.md) | Cloudflare R2 كـ Object Storage | ✅ Accepted |
| [0008](docs/adr/0008-payment-provider-abstraction.md) | Payment Provider Port/Adapter + Webhook-driven | ✅ Accepted |
| [0009](docs/adr/0009-cookieless-analytics.md) | Analytics بدون Cookies وبدون تخزين IP | ✅ Accepted |
| [0010](docs/adr/0010-css-first-animations.md) | Animations بالـ CSS أولاً على الصفحة العامة | ✅ Accepted |
| [0011](docs/adr/0011-i18n-and-rtl-strategy.md) | next-intl + CSS Logical Properties للـ RTL | ✅ Accepted |
| [0012](docs/adr/0012-licensed-music-library.md) | مكتبة موسيقى مرخّصة مركزياً + رفع مقيّد | ✅ Accepted |
| [0013](docs/adr/0013-slug-and-reserved-words.md) | Slug namespace تحت `/i/` مع Reserved words | ✅ Accepted |
| [0014](docs/adr/0014-entitlements-over-plan-checks.md) | Entitlements Service بدل `if (plan === 'premium')` | ✅ Accepted |
| [0015](docs/adr/0015-market-configuration-model.md) | نموذج تكوين السوق — لا ترميز صلب للسعودية | ✅ Accepted |
| [0016](docs/adr/0016-static-qr-in-mvp.md) | QR ثابت داخل MVP | ✅ Accepted |
| [0017](docs/adr/0017-invitation-visibility-model.md) | Unlisted ≠ Private — نموذج ظهور الدعوة | ✅ Accepted |

---

## 🚦 الحالة الحالية

Phase 0 معتمدة. التنفيذ جارٍ على **Phase 1 فقط**، milestone تلو الآخر،
ببوابة خروج إلزامية لكل واحد → **[docs/20-phase1-milestones.md](docs/20-phase1-milestones.md)**.

> ⛔ ممنوع أي عمل من Phase 2 أو Phase 3.
> ⛔ ممنوع الانتقال بين الـ Milestones قبل استيفاء Exit Criteria.
> 🚦 **بوابة توقف عند M3:** إن احتاج القالب الثالث تعديلاً في الـ Renderer — نتوقف ونراجع المعمارية.

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

## 🛠 التطوير المحلي

### المتطلبات
Node **22+** · pnpm **10+** · Docker (لـ Postgres و Redis و MinIO و Mailpit)

### البدء

```bash
pnpm install
cp .env.example .env      # القيم الافتراضية تعمل مع docker compose كما هي
pnpm db:up                # postgres · redis · minio · mailpit
pnpm dev                  # web على :3000 · worker
```

| الخدمة | العنوان |
|--------|---------|
| التطبيق | http://localhost:3000 |
| فحص الصحة | http://localhost:3000/api/health |
| MinIO console | http://localhost:9001 |
| Mailpit (البريد الملتقط) | http://localhost:8025 |

### الأوامر

| الأمر | الغرض |
|-------|-------|
| `pnpm verify` | **كل الفحوص** — التنسيق، lint، الأنواع، الحدود، الاختبارات، الحواجز |
| `pnpm test` | اختبارات الوحدة |
| `pnpm lint` · `pnpm typecheck` | فحوص فردية |
| `pnpm boundaries` | حدود الوحدات (dependency-cruiser) |
| `pnpm guardrails` | **يثبت أن الحواجز المعمارية ترفض المخالفات فعلاً** |
| `pnpm build` | بناء الإنتاج |
| `pnpm db:up` / `db:down` / `db:reset` | خدمات التطوير |

> شغّل `pnpm verify` قبل أي push — هي نفس ما يشغّله CI.

### الحواجز المعمارية

هذه ليست تفضيلات أسلوب. كل قاعدة تمنع فئة أخطاء موثّقة في ADR، و`pnpm guardrails`
يكتب ملفات مخالفة عمداً ويتأكد أن الأدوات ترفضها — **قاعدة مُعدّة لكن غير مُختبَرة
هي قاعدة لا أحد يعرف أنها تعطّلت.**

| الحاجز | يمنع | المرجع |
|--------|------|--------|
| `zfaf/no-physical-css-properties` | `margin-left`, `ml-4`, `text-align: left` | [ADR-0011](docs/adr/0011-i18n-and-rtl-strategy.md) |
| `zfaf/no-dangerous-html` | `dangerouslySetInnerHTML` | [ADR-0004](docs/adr/0004-json-template-manifest.md) |
| `zfaf/no-prisma-outside-db` | استيراد Prisma خارج `packages/db` | [ADR-0003](docs/adr/0003-postgresql-and-prisma.md) |
| `zfaf/no-market-literals` | `"SAR"`, `"+966"`, `"Asia/Riyadh"`, `VAT_RATE` | [ADR-0015](docs/adr/0015-market-configuration-model.md) |
| `no-restricted-imports` في `core` | استيراد Next/React/db في النطاق | [ADR-0002](docs/adr/0002-nextjs-fullstack-over-separate-api.md) |
| `no-restricted-properties` في `core` | `Date.now()` و `Math.random()` | [ADR-0004](docs/adr/0004-json-template-manifest.md) |
| `no-restricted-syntax` | `user.plan === 'premium'` | [ADR-0014](docs/adr/0014-entitlements-over-plan-checks.md) |

---

## قواعد المساهمة الأساسية

- ❌ لا secrets في Git — إطلاقاً. (`gitleaks` في CI كـ required check)
- ❌ لا authorization في الـ Frontend — كل تحقق server-side.
- ❌ لا ملفات كبيرة في PostgreSQL.
- ✅ كل مدخلات المستخدم تمرّ عبر Zod schema.
- ✅ كل قرار تقني مهم يحتاج ADR.
- ✅ CI أخضر شرط للـ merge.
