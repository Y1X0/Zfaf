# 11 — Payments & Billing Architecture

**الإصدار:** v1.0 · **الحالة:** ✅ معتمدة · **التنفيذ:** Phase 2 (البنية تُبنى في Phase 1)

> ### 🔒 تعديلات معتمدة (2026-08-16)
>
> 1. **السوق الأول: السعودية** — لكن **ممنوع أي ترميز صلب** لها.
>    العملة/اللغة/المنطقة الزمنية/الضريبة/مزوّد الدفع كلها **بيانات قابلة للتكوين**
>    عبر `MarketConfig` → [ADR-0015](adr/0015-market-configuration-model.md).
>    **المعيار:** إضافة الكويت/الإمارات = صف إعدادات + محوّل دفع، بلا إعادة بناء الفوترة.
>
> 2. **لا بوابة دفع في MVP.** يُبنى: المنفذ + الجداول + `EntitlementService` + `NullPaymentProvider`.
>    لا محوّل حقيقي، لا webhooks، لا صفحة دفع، لا فواتير.
>
> 3. ⛔ **لا افتراضات ضريبية أو قانونية.** جدول `tax_rules` مؤجَّل لـ Phase 2 ويُنشأ فارغاً.
>    `TaxConfig` **يرفض التحميل** بلا `verifiedBy` و `verifiedAt` — ضمانة مفروضة بالكود.
>    **الافتراض الوحيد المسموح في MVP: لا حساب ضريبة إطلاقاً.**
>
> 4. **اختيار المزوّد مؤجَّل** حتى إثبات PMF. ترشيح Moyasar (§3) يبقى توصية لا التزاماً.
>
> الأقسام أدناه تصف التصميم المستهدف لـ Phase 2 — اقرأها في ضوء هذه التعديلات.

---

## 1. المبدأ الحاكم

> **لا يُربَط النظام ببوابة دفع واحدة.**

السبب ليس نظرياً: منتج يستهدف المنطقة العربية يحتاج **مزوّداً محلياً** (mada، Apple Pay، STC Pay،
تحويل بنكي) لأن نسبة نجاح الدفع بالبطاقات الدولية عبر Stripe في السعودية والخليج
أقل بكثير من المزوّدين المحليين. وفي الوقت نفسه نحتاج Stripe للعملاء الدوليين والاشتراكات.

لذلك: **Port/Adapter من اليوم الأول.** إضافة مزوّد = ملف واحد + إعدادات.

📄 [ADR-0008](adr/0008-payment-provider-abstraction.md)

---

## 2. المنفذ (Port)

```typescript
// packages/core/src/billing/ports/payment-provider.ts
export interface PaymentProvider {
  readonly key: string;                    // 'stripe' | 'moyasar' | 'tap' | 'paypal'
  readonly capabilities: {
    oneTime: boolean;
    subscriptions: boolean;
    refunds: boolean;
    partialRefunds: boolean;
    currencies: string[];
    methods: PaymentMethod[];              // card | applepay | mada | stcpay | ...
  };

  createCheckout(input: {
    amount: number;                        // بأصغر وحدة (هللة)
    currency: string;
    description: string;
    customerRef: string;                   // معرّفنا لا معرّف المزوّد
    metadata: Record<string, string>;      // invitationId, planId, userId
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ sessionId: string; redirectUrl: string; expiresAt: Date }>;

  verifyWebhook(rawBody: string, signature: string, secret: string)
    : Promise<VerifiedEvent | null>;       // null ⇒ توقيع غير صالح

  getPayment(providerPaymentId: string): Promise<PaymentDetails | null>;

  refund(providerPaymentId: string, amount?: number, reason?: string)
    : Promise<RefundResult>;

  // اختيارية — حسب القدرات
  createSubscription?(input: SubscriptionInput): Promise<SubscriptionResult>;
  cancelSubscription?(providerSubId: string, atPeriodEnd: boolean): Promise<void>;
}

// حدث موحّد — لا يعرف باقي النظام شيئاً عن أشكال المزوّدين
export type VerifiedEvent =
  | { kind: 'payment.succeeded'; providerPaymentId: string; amount: number;
      currency: string; metadata: Record<string,string>; occurredAt: Date }
  | { kind: 'payment.failed';    providerPaymentId: string; code: string; message: string }
  | { kind: 'payment.refunded';  providerPaymentId: string; amount: number }
  | { kind: 'subscription.updated'; providerSubId: string; status: SubStatus;
      currentPeriodEnd: Date }
  | { kind: 'unknown'; rawType: string };   // ⚠️ لا نتجاهله — نسجّله ونتجاهل بوعي
```

**نقطة تصميم مهمة:** `VerifiedEvent` نوع **موحّد**. كل محوّل يترجم أشكال مزوّده إليه.
لذلك منطق الأعمال لا يحتوي أبداً على `if (provider === 'stripe')`.

---

## 3. المزوّدون

| المزوّد | السوق | الطرق | الرسوم التقريبية | المرحلة |
|---------|-------|-------|-------------------|---------|
| **Moyasar** | 🇸🇦 السعودية | mada, Visa/MC, Apple Pay, STC Pay | 2.75% + 1 ريال | Phase 2 — **الأول** |
| **Tap Payments** | 🇰🇼🇸🇦🇦🇪🇧🇭 الخليج | KNET, mada, بطاقات, Apple Pay | ~2.5–3% | Phase 2 |
| **Stripe** | 🌍 دولي | بطاقات, Apple/Google Pay, اشتراكات | 2.9% + $0.30 | Phase 2 |
| **PayPal** | 🌍 | محفظة | ~3.5% | Phase 3 |
| **HyperPay / PayTabs** | 🇸🇦🇦🇪 | بطاقات محلية | متغيّر | بديل |

**قرار: نبدأ بـ Moyasar.**
السبب: **mada هي بطاقة الخصم المحلية التي يملكها كل سعودي تقريباً**، وStripe لا يدعمها.
منتج يستهدف السعودية بلا mada يخسر شريحة ضخمة من عملائه المحتملين عند صفحة الدفع بالذات.

### اختيار المزوّد وقت التشغيل

```typescript
function selectProvider(ctx: { currency: string; country?: string;
                              preferredMethod?: PaymentMethod }): PaymentProvider {
  if (ctx.currency === 'SAR' && registry.has('moyasar')) return registry.get('moyasar');
  if (GULF.includes(ctx.country ?? '') && registry.has('tap')) return registry.get('tap');
  return registry.get('stripe');
}
```
قابل للتجاوز بأعلام ميزات — للتجربة (A/B) على معدلات نجاح الدفع.

---

## 4. تدفق الدفع

```
المستخدم يضغط «اشترِ الباقة»
   │
   ├─ ① POST /api/v1/checkout/session
   │      { planId, invitationId?, idempotencyKey }
   │
   │      الخادم:
   │        ✓ يتحقق من هوية المستخدم
   │        ✓ يقرأ السعر من DB    ⚠️ لا يقبل السعر من العميل أبداً
   │        ✓ يطبّق كوبون خصم (تحقق server-side)
   │        ✓ ينشئ payments (status=pending) + idempotency_key
   │        ✓ يستدعي provider.createCheckout()
   │      → { redirectUrl }
   │
   ├─ ② إعادة توجيه إلى صفحة المزوّد (بيئة مستضافة — لا نلمس بيانات البطاقة إطلاقاً)
   │
   ├─ ③ المستخدم يدفع
   │
   ├─ ④ (أ) المزوّد يعيد التوجيه إلى successUrl
   │        ⚠️ هذا تلميح واجهة فقط، لا يغيّر أي حالة
   │        الصفحة تعرض: «جارٍ تأكيد الدفع…» وتستطلع الحالة
   │
   │   (ب) المزوّد يرسل Webhook   ← ✅ مصدر الحقيقة الوحيد
   │        POST /api/webhooks/moyasar
   │           1. قراءة الجسم الخام
   │           2. تحقق التوقيع
   │           3. تحقق الطابع الزمني (±5 دقائق)
   │           4. INSERT webhook_events (idempotent)
   │           5. رد 200 فوراً
   │           6. معالجة في الطابور:
   │                • payments.status = succeeded
   │                • إنشاء/تحديث subscription
   │                • منح Entitlements
   │                • بريد الإيصال
   │                • تفعيل الميزات على الدعوة
   │
   └─ ⑤ الواجهة ترى التحديث → «تم الدفع ✓ دعوتك مفعّلة»
```

### قواعد غير قابلة للكسر

1. ❌ **لا حالة تتغير بناءً على إعادة التوجيه من المتصفح.** أبداً. يمكن تزويرها بكتابة الرابط.
2. ✅ **الأسعار من قاعدة البيانات دائماً.** العميل يرسل `planId` لا `amount`.
3. ✅ **مفتاح Idempotency على كل عملية دفع.** يمنع الخصم المزدوج عند النقر المزدوج أو إعادة المحاولة.
4. ✅ **كل webhook يُسجَّل قبل معالجته** — قابل لإعادة التشغيل بعد عطل.
5. ✅ **لا نلمس بيانات البطاقة إطلاقاً.** صفحة مستضافة عند المزوّد ⇒ نطاق PCI-DSS عندنا = SAQ-A (الأدنى).

---

## 5. نموذج الباقات

### نموذج التسعير المقترح

**واقع تجاري مهم:** العميل يشتري **مرة واحدة في العمر**. الاشتراك الشهري لا يناسب العروسين.
لذلك النموذج الأساسي **شراء لمرة واحدة لكل دعوة**، والاشتراك لمنظّمي الأعراس فقط.

| الباقة | السعر | النموذج | المحتوى |
|--------|-------|---------|---------|
| **Free** | 0 | — | قالب واحد، وسم Zfaf، 10 صور، صالحة 14 يوماً بعد الحفل، RSVP أساسي |
| **Basic** | ~79 ريال | مرة واحدة/دعوة | 4 قوالب، بلا وسم، 25 صورة، موسيقى، RSVP كامل، QR، صالحة 90 يوماً |
| **Premium** | ~179 ريال | مرة واحدة/دعوة | كل القوالب، رابط مخصص، 60 صورة، إدارة ضيوف، تحليلات متقدمة، حركات مميزة، رفع موسيقى، صالحة سنة |
| **Planner** | ~299 ريال/شهر | اشتراك | دعوات غير محدودة، فريق، علامة بيضاء، أولوية دعم، فوترة موحدة |

> ⚠️ **الأرقام مبدئية ومؤجَّلة رسمياً.** لا تُثبَّت قبل بيانات حقيقية. لهذا نطلق Phase 1 مجاناً —
> لنقيس القيمة المدركة قبل التسعير. **قرار #6.**

### أهمية الباقة المجانية

الباقة المجانية ليست خسارة — **هي محرك النمو**:
```
دعوة مجانية → 300 ضيف يرونها → الوسم «أُنشئت عبر Zfaf» → 2–5 منهم عرسان مستقبليون
```
هذه هي حلقة النمو كلها. وسم الباقة المجانية = تكلفة تسويق فعالة جداً.

---

## 6. الاستحقاقات (Entitlements) — القرار المعماري الأهم في الفوترة

### المشكلة

```typescript
// ❌ الطريقة التي تدمّر الكود تدريجياً
if (user.plan === 'premium' || user.plan === 'planner') { allowCustomSlug(); }
```
بعد ستة أشهر: هذا السطر مكرر في 40 موضعاً، وإضافة باقة جديدة تعني تعديلها كلها،
وستنسى واحداً، وسيحصل عميل على ميزة مجاناً (أو يُحرَم منها بعد الدفع).

### الحل

```typescript
// ✅ خدمة واحدة تجيب على سؤال واحد
interface EntitlementService {
  for(userId: string): Promise<Entitlements>;
}

interface Entitlements {
  can(feature: Feature): boolean;
  limit(key: LimitKey): number;              // Infinity للامحدود
  usage(key: LimitKey): Promise<number>;
  remaining(key: LimitKey): Promise<number>;
}

type Feature =
  | 'invitation.custom_slug' | 'invitation.remove_branding' | 'invitation.password'
  | 'template.premium' | 'media.custom_music' | 'guest.management'
  | 'analytics.advanced' | 'domain.custom' | 'team.members' | 'export.csv';
```

الاستخدام:
```typescript
const ent = await entitlements.for(actor.userId);
if (!ent.can('invitation.custom_slug')) return err('PLAN_LIMIT_EXCEEDED');
if (await ent.remaining('invitation.active') <= 0) return err('PLAN_LIMIT_EXCEEDED');
```

**النتائج:**
- إضافة باقة = **صف في جدول `plans`** — صفر تغييرات في الكود.
- تعديل حد = تحديث JSON — بلا نشر.
- منح استثناء لعميل واحد = صف في `entitlement_overrides`.
- **مبنية في Phase 1** رغم أن كل المستخدمين على `free_beta` → صفر إعادة عمل عند تفعيل الدفع.

📄 [ADR-0014](adr/0014-entitlements-over-plan-checks.md)

### التجاوزات

```
entitlement_overrides (user_id, feature/limit, value, reason, expires_at, granted_by)
```
لدعم: عملاء تجريبيين، تعويض عن مشكلة، شراكات، عروض خاصة — **بلا تعديل باقة أو كود**.

---

## 7. حالات الاشتراك

```
   trialing ──────┐
      │           │
      ▼           ▼
   active ────▶ past_due ────▶ canceled
      │            │              │
      │            └──(دفع)──▶ active
      ▼
   canceled (نهاية الفترة) ────▶ expired
```

| الحالة | الوصول للميزات |
|--------|----------------|
| `trialing`, `active` | كامل |
| `past_due` | **كامل لمدة 7 أيام** ثم تخفيض تدريجي |
| `canceled` | كامل حتى `current_period_end` |
| `expired` | باقة مجانية |

### التخفيض التدريجي — قرار منتج مهم

```
انتهاء الباقة على دعوة منشورة:
   ❌ لا نُنزل الدعوة        ← تدمير علاقة العميل وإحراجه أمام ضيوفه
   ✅ تظل تعمل
   ✅ تعود ميزات الباقة المجانية (وسم، تحليلات أساسية)
   ✅ RSVP يظل يعمل           ← ⚠️ حرج: تعطيله يضرّ الضيوف لا العميل
   ✅ إشعارات مسبقة (14 و 7 و 1 يوم)
   ✅ البيانات محفوظة 90 يوماً بعد الانتهاء
```

**المبدأ:** لا نعاقب الضيوف على تخلّف صاحب الدعوة عن الدفع. وضرر السمعة من إسقاط دعوة
ليلة عرس يفوق بكثير أي إيراد من الضغط.

---

## 8. الاسترداد

| السيناريو | السياسة |
|-----------|---------|
| خلال 14 يوماً وقبل النشر | استرداد كامل تلقائي |
| بعد النشر | حسب الحالة — قرار إداري |
| خطأ تقني من طرفنا | استرداد كامل + اعتذار |
| إساءة استخدام | لا استرداد + إيقاف |
| نزاع (Chargeback) | تسجيل، تعليق الحساب حتى الحل |

كل استرداد: يمرّ عبر `PaymentProvider.refund()` · يُسجَّل في `payments` · يُدوَّن في `audit_logs`
· يعدّل الاستحقاقات · يُرسل بريد للعميل. **لا استرداد يدوي خارج النظام.**

---

## 9. الضرائب والفوترة

| البند | التعامل |
|-------|---------|
| ضريبة القيمة المضافة السعودية (15%) | تُحسب وتُعرض بوضوح · فاتورة ضريبية للعملاء التجاريين |
| رقم ضريبي | حقل اختياري في الحساب (للمنظّمين والشركات) |
| الفوترة الإلكترونية (ZATCA) | ⚠️ **يحتاج استشارة محاسب قانوني قبل الإطلاق التجاري** |
| العملاء الدوليين | تسعير بالدولار عبر Stripe |
| أرقام الفواتير | متسلسلة، غير قابلة للتعديل، تُخزَّن دائماً |

⚠️ **قرار #14:** الامتثال الضريبي والفوترة الإلكترونية في السعودية له متطلبات تقنية محددة
(تكامل مع منصة فاتورة، توقيع رقمي، QR على الفاتورة). **يجب استشارة محاسب/مستشار قانوني
قبل قبول أول ريال.** ليس شيئاً نصممه من افتراضاتنا.

---

## 10. الأمان

| الخطر | الضابط |
|-------|--------|
| تلاعب بالسعر | السعر من DB حصراً — العميل يرسل `planId` فقط |
| webhook مزوّر | تحقق توقيع HMAC + نافذة زمنية + تسجيل |
| إعادة إرسال webhook | `provider_event_id` فريد |
| خصم مزدوج | `Idempotency-Key` فريد + قيد DB |
| احتيال بالبطاقات | نعتمد على أدوات المزوّد + مراقبة معدل الفشل |
| تسريب أسرار | مفاتيح في مدير أسرار، منفصلة لكل بيئة، تدوير دوري |
| تسجيل بيانات حساسة | **ممنوع تسجيل**: أرقام بطاقات، CVV، رموز المزوّد. `raw_event` منقّى قبل التخزين |
| اختبار في الإنتاج | مفاتيح الاختبار **لا تعمل** في الإنتاج (فحص عند الإقلاع) |

**نطاق PCI-DSS:** SAQ-A — لأننا لا نلمس بيانات البطاقة إطلاقاً (صفحة مستضافة عند المزوّد).
هذا قرار متعمّد يخفّض عبء الامتثال بدرجات.

---

## 11. الاختبار

| النوع | الأسلوب |
|-------|---------|
| Unit | منطق الاستحقاقات، حساب الأسعار، آلة حالة الاشتراك |
| Integration | محوّل مزيّف يحاكي كل أحداث المزوّد بما فيها الغريبة |
| Webhook | حمولات حقيقية مسجّلة من بيئة الاختبار + توقيعات صالحة وفاسدة |
| E2E | تدفق الشراء كاملاً ببطاقات الاختبار |
| **Chaos** | webhook متأخر · مكرر · خارج الترتيب · مفقود تماماً |

**سيناريوهات إلزامية:**
```
✓ webhook يصل قبل أن يعود المستخدم من صفحة الدفع
✓ webhook مكرر ×5
✓ webhook لا يصل أبداً → المصالحة الدورية تلتقط الدفعة
✓ نجاح الدفع + فشل تحديث DB → المصالحة تصلح
✓ المستخدم يغلق المتصفح فور الدفع
✓ استرداد جزئي ثم استرداد آخر
```

### المصالحة الدورية

مهمة يومية تقارن مدفوعات المزوّد بسجلاتنا وتكشف الانحراف.
**بدونها**، أي webhook مفقود يعني عميلاً دفع ولم يحصل على شيء — وهو أسوأ فشل ممكن تجارياً.

---

## 12. خطة التنفيذ

| المرحلة | العمل |
|---------|-------|
| **Phase 1** | `EntitlementService` + جداول `plans`/`subscriptions`/`payments` + الجميع على `free_beta`. **بلا مزوّد دفع.** |
| **Phase 2a** | منفذ `PaymentProvider` + محوّل Moyasar + webhooks + شراء لمرة واحدة |
| **Phase 2b** | محوّل Stripe للعملاء الدوليين + الاستردادات + الفواتير |
| **Phase 3** | اشتراكات المنظّمين + كوبونات + برنامج إحالة + عملات متعددة |

**الفائدة من بناء الاستحقاقات مبكراً:** عند تفعيل الدفع في Phase 2، الميزات **مقفلة بالفعل**
بشكل صحيح. التغيير الوحيد: من أين تأتي الباقة. صفر إعادة كتابة.
