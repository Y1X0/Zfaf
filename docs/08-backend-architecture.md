# 08 — Backend Architecture

**الإصدار:** v0.1 · **الحالة:** Draft

---

## 1. الطبقات

```
┌──────────────────────────────────────────────────────────────┐
│  الطبقة 1 — النقل (Transport)                                │
│  Route Handlers · Server Actions · Webhook receivers         │
│  المسؤولية: HTTP فقط.                                        │
│  • تحليل وتحقق (Zod)   • استخراج الجلسة   • تحديد المعدل      │
│  • تحويل النتيجة إلى HTTP   • ترويسات   • Request ID         │
│  ⚠️ صفر منطق أعمال. أطول handler مسموح: ~25 سطراً.           │
├──────────────────────────────────────────────────────────────┤
│  الطبقة 2 — التطبيق (Use Cases) — packages/core/*/usecases  │
│  publishInvitation · submitRsvp · createUploadUrl ...        │
│  المسؤولية: تنسيق العملية.                                   │
│  • تفويض   • قواعد الأعمال   • حدود المعاملات   • أحداث النطاق│
│  ⚠️ لا يعرف HTTP. لا يستورد Next.js. لا يستورد Prisma.        │
├──────────────────────────────────────────────────────────────┤
│  الطبقة 3 — النطاق (Domain) — packages/core/*/domain         │
│  كيانات · كائنات قيمة · قواعد خالصة · آلات حالة              │
│  Slug · InvitationStatus · PartySize · ThemeTokens ...       │
│  ⚠️ خالص تماماً. لا I/O إطلاقاً. اختباره بلا mocks.           │
├──────────────────────────────────────────────────────────────┤
│  الطبقة 4 — المنافذ (Ports) — packages/core/*/ports          │
│  InvitationRepository · StorageService · PaymentProvider     │
│  MailService · CacheService · Clock · IdGenerator            │
│  واجهات فقط. النطاق يعرّف ما يحتاجه، لا ما هو متاح.          │
├──────────────────────────────────────────────────────────────┤
│  الطبقة 5 — المحوّلات (Adapters) — packages/db, infra/*       │
│  PrismaInvitationRepository · R2Storage · ResendMail         │
│  StripeProvider · UpstashCache · SystemClock                 │
└──────────────────────────────────────────────────────────────┘
```

**اتجاه التبعية دائماً للداخل.** الطبقة 3 لا تعرف شيئاً عن 5.
هذا ليس تجميلاً معمارياً: هو ما يجعل اختبار منطق الأعمال ممكناً بلا قاعدة بيانات،
ويجعل تبديل المزوّدين (S3→R2، Stripe→محلي) تغييراً في ملف واحد.

---

## 2. تشريح Use Case

```typescript
// packages/core/src/invitation/usecases/publish-invitation.ts

export interface PublishInvitationDeps {
  invitations: InvitationRepository;
  templates:   TemplateRepository;
  media:       MediaRepository;
  entitlements: EntitlementService;
  cache:       CacheService;
  events:      EventBus;
  clock:       Clock;
  ids:         IdGenerator;
}

export interface PublishInvitationInput {
  actor: Actor;
  invitationId: string;
  slug?: string;
  idempotencyKey: string;
}

export type PublishInvitationResult =
  | { ok: true;  url: string; version: number }
  | { ok: false; error: DomainError };

export async function publishInvitation(
  input: PublishInvitationInput,
  deps: PublishInvitationDeps,
): Promise<PublishInvitationResult> {

  const invitation = await deps.invitations.findById(input.invitationId);
  if (!invitation) return err('INVITATION_NOT_FOUND');

  // 1) التفويض — نقطة واحدة، دائماً
  const decision = can(input.actor, 'invitation:publish', invitation);
  if (!decision.allowed) return err(decision.reason);

  // 2) قواعد الأعمال (منطق نطاق خالص)
  const completeness = checkCompleteness(invitation.draftDocument);
  if (!completeness.valid) return err('INVITATION_INCOMPLETE', completeness.missing);

  // 3) الاستحقاقات
  const ent = await deps.entitlements.for(input.actor.userId);
  if (!ent.canPublishAnother(invitation)) return err('PLAN_LIMIT_EXCEEDED');

  // 4) الـ slug
  const slug = input.slug
    ? Slug.parse(input.slug)                    // كائن قيمة: يتحقق ويطبّع
    : Slug.fromNames(invitation.draftDocument.content.couple);
  if (!slug.ok) return err('INVALID_SLUG', slug.issues);

  // 5) بناء الـ snapshot (خالص)
  const template = await deps.templates.findVersion(invitation.templateVersionId);
  const mediaMap = await deps.media.resolveMany(collectMediaIds(invitation.draftDocument));
  const snapshot = resolveDocument(invitation.draftDocument, template.manifest, mediaMap);

  // 6) الثبات (معاملة واحدة)
  const result = await deps.invitations.publishAtomic({
    invitationId: invitation.id,
    slug: slug.value,
    snapshot,
    templateVersionId: template.id,
    publishedBy: input.actor.userId,
    publishedAt: deps.clock.now(),
    idempotencyKey: input.idempotencyKey,
  });
  if (!result.ok) return err(result.error);        // مثلاً SLUG_TAKEN من قيد فريد

  // 7) آثار جانبية (لا تكسر العملية إن فشلت)
  await deps.cache.purgeTag(`inv:${invitation.id}`);
  await deps.events.emit({ type: 'invitation.published', invitationId: invitation.id, ... });

  return { ok: true, url: buildPublicUrl(slug.value), version: result.version };
}
```

**ما الذي يجعل هذا قابلاً للاختبار؟** كل التبعيات محقونة. الاختبار يمرّر مستودعات في الذاكرة
وساعة ثابتة، ويؤكد على النتيجة — بلا قاعدة بيانات، بلا شبكة، في ميلي ثانية.

---

## 3. المنافذ (Ports) الأساسية

```typescript
interface InvitationRepository {
  findById(id: string): Promise<Invitation | null>;
  findBySlug(slug: string): Promise<PublishedInvitation | null>;
  listByOwner(ownerId: string, f: ListFilters): Promise<Page<InvitationSummary>>;
  create(data: NewInvitation): Promise<Invitation>;
  updateDocument(id: string, patch: JsonPatch[], baseVersion: number)
    : Promise<{ ok: true; version: number } | { ok: false; conflict: ConflictInfo }>;
  publishAtomic(cmd: PublishCommand): Promise<PublishOutcome>;
  softDelete(id: string, at: Date): Promise<void>;
}

interface StorageService {
  createUploadUrl(k: StorageKey, o: UploadOptions): Promise<SignedUpload>;
  createDownloadUrl(k: StorageKey, ttl: number): Promise<string>;
  head(k: StorageKey): Promise<ObjectMeta | null>;
  delete(k: StorageKey): Promise<void>;
}

interface PaymentProvider {
  readonly key: string;
  createCheckout(i: CheckoutInput): Promise<CheckoutSession>;
  verifyWebhook(raw: string, sig: string): Promise<VerifiedEvent | null>;
  refund(paymentId: string, amount?: number): Promise<RefundResult>;
  getPayment(id: string): Promise<PaymentDetails | null>;
}

interface Clock { now(): Date }                    // ← يجعل اختبار الوقت ممكناً
interface IdGenerator { uuid(): string; token(bytes: number): string }
interface CacheService {
  get<T>(k: string): Promise<T | null>;
  set<T>(k: string, v: T, ttl: number): Promise<void>;
  purgeTag(tag: string): Promise<void>;
  incr(k: string, ttl: number): Promise<number>;
}
```

> `Clock` و `IdGenerator` كمنفذين ليسا مبالغة: بدونهما، اختبار «هل انتهت صلاحية الدعوة؟»
> يتطلب حيلاً مع مؤقتات وهمية، واختبار الحتمية يصبح مستحيلاً.

---

## 4. أخطاء النطاق

```typescript
type DomainErrorCode =
  | 'INVITATION_NOT_FOUND' | 'INVITATION_INCOMPLETE' | 'INVITATION_ALREADY_PUBLISHED'
  | 'INVALID_SLUG' | 'SLUG_TAKEN' | 'SLUG_RESERVED'
  | 'FORBIDDEN' | 'EMAIL_NOT_VERIFIED' | 'PLAN_LIMIT_EXCEEDED'
  | 'RSVP_CLOSED' | 'RSVP_PARTY_TOO_LARGE' | 'RSVP_DUPLICATE'
  | 'MEDIA_TOO_LARGE' | 'MEDIA_TYPE_NOT_ALLOWED' | 'MEDIA_NOT_READY'
  | 'RATE_LIMITED' | 'CONFLICT' | 'PAYMENT_FAILED';
```

خريطة واحدة `DomainErrorCode → HTTP status + رسالة i18n` في طبقة النقل.
**لا يعرف النطاق شيئاً عن رموز HTTP** — وهذا يعني أن نفس المنطق يعمل عبر gRPC أو CLI أو طابور.

---

## 5. المعاملات

```typescript
// حدود المعاملة تُعلَن في الـ use case، وتُنفَّذ في المحوّل
await deps.uow.transaction(async (tx) => {
  await tx.invitationVersions.insert(snapshot);
  await tx.invitations.markPublished(id, versionId, slug);
});
```

**قواعد صارمة:**
- المعاملة **قصيرة**. لا استدعاءات شبكة خارجية داخلها أبداً (بريد، تخزين، دفع).
- الآثار الجانبية بعد الالتزام، عبر الأحداث/الطابور.
- **العمليات التي يجب أن تكون ذرية:**
  - النشر (نسخة + تحديث الحالة)
  - إدراج RSVP + تحديث العدّادات
  - معالجة webhook دفع + تحديث الاشتراك
  - تغيير الـ slug + كتابة سجل الـ slug القديم

---

## 6. الأحداث والمهام الخلفية

### ناقل أحداث بسيط

```typescript
type DomainEvent =
  | { type: 'invitation.published';  invitationId: string; ownerId: string }
  | { type: 'invitation.suspended';  invitationId: string; reason: string }
  | { type: 'rsvp.submitted';        invitationId: string; rsvpId: string }
  | { type: 'media.uploaded';        mediaId: string }
  | { type: 'payment.succeeded';     paymentId: string; userId: string }
  | { type: 'user.deletion_requested'; userId: string };
```

**الأحداث تُنشر بعد الالتزام**، والمعالجات تعمل في `apps/worker`.
الفائدة: مسار الطلب يبقى قصيراً، والفشل في البريد لا يُفشل النشر.

### المهام

| المهمة | المشغّل | إعادة المحاولة | ملاحظة |
|--------|---------|-----------------|--------|
| `media:process` | media.uploaded | 3× أسّي | Sharp: تحويل، تجريد EXIF، blurhash |
| `og:generate` | invitation.published | 3× | Satori → PNG → R2 |
| `mail:send` | أحداث متعددة | 5× أسّي | تفعيل، إشعارات، إيصالات |
| `analytics:rollup` | كرون كل ساعة | 2× | events → analytics_daily |
| `invitation:expire` | كرون يومي | 1× | تعليم المنتهية |
| `media:gc` | كرون يومي | 1× | حذف الوسائط اليتيمة (بعد 7 أيام سماح) |
| `data:purge` | كرون يومي | 1× | حذف الحسابات/الدعوات بعد فترة السماح |
| `webhook:process` | استقبال webhook | 5× أسّي | معالجة idempotent |
| `rsvp:digest` | كرون يومي | 2× | ملخص يومي لأصحاب الدعوات |

**البنية:** BullMQ على Redis. `apps/worker` عملية مستقلة قابلة للتوسع أفقياً بمعزل عن الويب.
كل مهمة **idempotent** — إعادة التنفيذ آمنة دائماً.

---

## 7. التحقق من المدخلات

```typescript
// packages/shared/schemas/rsvp.ts — مصدر حقيقة واحد
export const SubmitRsvpSchema = z.object({
  name: z.string().trim().min(2).max(80)
        .refine(s => !containsControlChars(s), 'INVALID_CHARS'),
  attending: z.boolean(),
  partySize: z.number().int().min(0).max(50),
  phone: z.string().trim().regex(E164_REGEX).optional(),
  note: z.string().trim().max(500).optional(),
  guestToken: z.string().length(16).optional(),
  website: z.literal('').optional(),        // honeypot
});
export type SubmitRsvpInput = z.infer<typeof SubmitRsvpSchema>;
```

**قواعد:**
- نفس الـ schema يُستخدم في الواجهة والخادم → لا انحراف.
- **التحقق في الواجهة للتجربة فقط.** الخادم يتحقق دائماً من جديد.
- تطبيع قبل التحقق: تشذيب، توحيد Unicode (NFC)، تحويل الأرقام العربية-الهندية إلى غربية.
- المدخلات العربية تُطبَّع بـ NFC — وإلا يُخزَّن نفس الاسم بترميزين مختلفين ويفشل كشف التكرار.

---

## 8. طبقة التفويض

```typescript
// packages/core/src/authz/can.ts — النقطة الوحيدة في النظام
export function can(actor: Actor, action: Action, resource?: Resource): Decision {
  if (actor.status === 'suspended') return deny('ACCOUNT_SUSPENDED');

  switch (action) {
    case 'invitation:read':
    case 'invitation:update':
      return isMember(actor, resource, ['owner','editor'])
          || isPlatformStaff(actor) ? allow() : deny('FORBIDDEN');

    case 'invitation:publish':
      if (!isMember(actor, resource, ['owner','editor'])) return deny('FORBIDDEN');
      if (!actor.emailVerified) return deny('EMAIL_NOT_VERIFIED');
      return allow();

    case 'invitation:delete':
      return isMember(actor, resource, ['owner']) ? allow() : deny('FORBIDDEN');

    case 'admin:suspend_invitation':
      return actor.role in ['support','admin','superadmin'] ? allow() : deny('FORBIDDEN');
    ...
  }
}
```

**لماذا نقطة واحدة؟** لأن التفويض المتناثر هو المصدر الأول لثغرات IDOR.
جدول القرارات كله في ملف واحد ⇒ يُراجَع كاملاً، ويُختبَر بمصفوفة شاملة
(كل دور × كل إجراء × كل علاقة ملكية). التفاصيل في [09-auth-and-rbac.md](09-auth-and-rbac.md).

---

## 9. طبقة الوصول للبيانات

```typescript
// packages/db/src/repositories/invitation.repository.ts
export class PrismaInvitationRepository implements InvitationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findBySlug(slug: string): Promise<PublishedInvitation | null> {
    const row = await this.prisma.invitation.findFirst({
      where: { slug, deletedAt: null, status: 'PUBLISHED' },
      select: { id: true, status: true, expiresAt: true, locale: true,
                publishedVersion: { select: { publishedDocument: true, versionNumber: true } } },
    });
    return row ? toPublishedInvitation(row) : null;
  }
}
```

**قواعد صارمة:**
- ❌ **ممنوع استيراد `PrismaClient` خارج `packages/db`.** قاعدة ESLint تفشل CI.
- ✅ كل مستودع يفرض نطاق الملكية داخلياً — لا يعتمد على أن المستدعي «سيتذكر».
- ✅ التحويل بين صفوف DB وكيانات النطاق في دوال `toDomain` صريحة (لا تسريب أنواع Prisma للنطاق).
- ✅ `select` صريح دائماً — لا `SELECT *`. يقلل الحمولة ويمنع تسريب أعمدة حساسة بالخطأ.

### دفاع في العمق: RLS (Phase 2)

```sql
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_owner ON invitations
  USING (owner_id = current_setting('app.user_id')::uuid);
```
طبقة التطبيق تفرض العزل أصلاً؛ RLS شبكة أمان لو أخطأ استعلام يدوي.

---

## 10. Middleware ومسار الطلب

```
الطلب
  │
  ├─ 1. Request ID (توليد أو تمرير من الترويسة)
  ├─ 2. ترويسات الأمان (CSP, HSTS, X-Frame-Options, ...)
  ├─ 3. تحديد المعدل (Redis)
  ├─ 4. تحليل الجلسة (بحث بالكوكي)
  ├─ 5. حارس اللغة/التوجيه
  ├─ 6. حارس المصادقة (للمسارات المحمية)
  ├─ 7. تحقق Origin (للطلبات المُغيِّرة)
  │
  ├─▶ المعالج → Use case → النطاق → المحوّلات
  │
  ├─ 8. تحويل الخطأ إلى استجابة
  └─ 9. سجل منظم { requestId, userId?, route, status, durationMs }
```

**ترويسات الأمان الافتراضية:**
```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY                    (استثناء: /preview/* يسمح بنفس الأصل)
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
Content-Security-Policy: (انظر 12-security-threat-model.md)
```

---

## 11. الإعدادات والأسرار

```typescript
// packages/config/src/env.ts — يفشل عند الإقلاع لا عند أول استخدام
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development','test','production']),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  R2_ACCOUNT_ID: z.string(),
  R2_ACCESS_KEY_ID: z.string(),
  R2_SECRET_ACCESS_KEY: z.string(),
  REDIS_URL: z.string().url(),
  RESEND_API_KEY: z.string(),
  PUBLIC_BASE_URL: z.string().url(),
  TURNSTILE_SECRET: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});
export const env = EnvSchema.parse(process.env);
```

**قواعد الأسرار:**
- ❌ لا أسرار في Git إطلاقاً — `gitleaks` كـ required check على كل PR وعلى التاريخ.
- ✅ `.env.example` بقيم وهمية فقط.
- ✅ الأسرار في مدير أسرار المنصة، مختلفة تماماً لكل بيئة.
- ✅ تدوير سنوي مجدول، وفوري عند أي اشتباه.
- ✅ أي سر يُطبع في سجل = حادث أمني يستدعي تدويراً فورياً.

---

## 12. لماذا Modular Monolith وليس Microservices

| المعيار | Monolith وحداتي | Microservices |
|---------|------------------|----------------|
| حجم الفريق المناسب | 1–8 | 15+ |
| النشر | واحد، ذري | منسّق، معقّد |
| المعاملات | ACID مباشرة | معاملات موزّعة (Saga) — تعقيد هائل |
| التشخيص | تتبع محلي بسيط | تتبع موزّع إجباري |
| التكلفة | خدمة واحدة | ×N |
| سرعة التطوير | **الأعلى** | منخفضة في البداية |
| التوسع المستقل | محدود (لكن CDN يحلّه لنا) | ممتاز |

**الحقيقة العملية:** أضخم حمل عندنا هو قراءة الدعوة العامة، وهي **مخدومة من CDN**.
لا يوجد جزء آخر يحتاج توسعاً مستقلاً في الأفق المنظور.

**الاستعداد للانفصال (مبني من الآن):**
- حدود وحدات صارمة مفروضة بأدوات (`dependency-cruiser` في CI).
- لا استيراد متقاطع بين المستودعات — التواصل عبر واجهات الخدمات.
- منطق أعمال بلا تبعية إطار → يُستخرَج بلا إعادة كتابة.
- الأحداث كنقاط فصل جاهزة.

📄 [ADR-0001](adr/0001-monorepo-and-modular-monolith.md)

---

## 13. المهام المجدولة

| المهمة | التكرار | الوصف |
|--------|---------|-------|
| `analytics:rollup` | كل ساعة | تجميع الأحداث الخام |
| `invitation:expire` | يومياً 03:00 | تعليم الدعوات المنتهية |
| `media:gc` | يومياً 04:00 | حذف الوسائط اليتيمة |
| `data:purge` | يومياً 05:00 | تنفيذ سياسات الاحتفاظ والحذف |
| `analytics:partition` | شهرياً | إنشاء الأقسام وإسقاط القديمة |
| `session:cleanup` | يومياً | حذف الجلسات المنتهية |
| `backup:verify` | أسبوعياً | **استرجاع فعلي للتحقق** — نسخة غير مُختبَرة ليست نسخة |
| `rsvp:digest` | يومياً 08:00 | ملخص للمستخدمين |

كلها **idempotent** وتُسجَّل نتائجها، مع تنبيه عند الفشل أو تجاوز المدة المتوقعة.
