# ADR-0008 — Payment Provider Port/Adapter + معالجة مدفوعة بالـ Webhooks

**الحالة:** Proposed · **التاريخ:** 2026-08-16 · **التنفيذ:** Phase 2

## السياق

المتطلب صريح: *«لا تربط النظام مباشرة ببوابة دفع واحدة»*.

والسبب عملي لا نظري: منتج يستهدف السعودية والخليج يحتاج **مزوّداً محلياً** لأن:
- **mada** هي بطاقة الخصم التي يملكها كل سعودي تقريباً، و**Stripe لا يدعمها**.
- KNET في الكويت، Benefit في البحرين — كلها محلية.
- نسبة نجاح الدفع عبر المزوّدين المحليين أعلى بوضوح للبطاقات المحلية.

وفي الوقت نفسه نحتاج Stripe للعملاء الدوليين وللاشتراكات المتكررة.

## القرار

**منفذ `PaymentProvider` في `packages/core`، ومحوّلات في `infra/payments/`.**

```typescript
interface PaymentProvider {
  readonly key: string;
  readonly capabilities: ProviderCapabilities;
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  verifyWebhook(raw: string, sig: string, secret: string): Promise<VerifiedEvent | null>;
  getPayment(id: string): Promise<PaymentDetails | null>;
  refund(id: string, amount?: number): Promise<RefundResult>;
  createSubscription?(input): Promise<SubscriptionResult>;
}
```

**عنصر التصميم الحاسم: نوع حدث موحّد.**

```typescript
type VerifiedEvent =
  | { kind:'payment.succeeded'; providerPaymentId; amount; currency; metadata; occurredAt }
  | { kind:'payment.failed';    providerPaymentId; code; message }
  | { kind:'payment.refunded';  providerPaymentId; amount }
  | { kind:'subscription.updated'; providerSubId; status; currentPeriodEnd }
  | { kind:'unknown'; rawType };
```

كل محوّل يترجم شكل مزوّده إلى هذا النوع. النتيجة: **لا يوجد في منطق الأعمال أي
`if (provider === 'stripe')`.**

## قواعد غير قابلة للكسر

1. ❌ **لا حالة تتغير بناءً على إعادة توجيه المتصفح.** الرابط قابل للتزوير بالكتابة.
   **الـ webhook المُتحقَّق من توقيعه هو مصدر الحقيقة الوحيد.**
2. ✅ **الأسعار من قاعدة البيانات.** العميل يرسل `planId` فقط، لا `amount`.
3. ✅ **`Idempotency-Key` على كل عملية دفع** — يمنع الخصم المزدوج.
4. ✅ **كل webhook يُسجَّل قبل معالجته** (`webhook_events` بـ `provider_event_id` فريد)
   ⇒ إعادة التشغيل بعد عطل آمنة تماماً.
5. ✅ **لا نلمس بيانات البطاقة إطلاقاً** — صفحة مستضافة عند المزوّد ⇒ نطاق PCI = SAQ-A.

## البدائل المرفوضة

| البديل | لماذا |
|--------|-------|
| ربط Stripe مباشرة | لا mada ⇒ خسارة شريحة كبيرة من السوق المستهدف عند صفحة الدفع بالذات |
| ربط مزوّد محلي مباشرة | يحبسنا محلياً ويصعّب التوسع الدولي والاشتراكات |
| Paddle / LemonSqueezy (Merchant of Record) | يحلّ الضريبة عالمياً، لكن دعم طرق الدفع المحلية ضعيف ورسوم أعلى |
| بوابة دفع مبنية داخلياً | ❌ غير وارد — امتثال PCI ومخاطر هائلة |

## العواقب

### إيجابية
- إضافة مزوّد = محوّل واحد + إعدادات.
- اختيار المزوّد وقت التشغيل حسب العملة/البلد/الطريقة.
- إمكانية اختبار A/B على **معدلات نجاح الدفع** بين المزوّدين.
- اختبار سهل بمحوّل مزيّف.
- منطق الأعمال محمي من تغييرات API المزوّدين.

### سلبية
- تجريد إضافي (~أسبوع عمل).
- **قاسم مشترك**: ميزات خاصة بمزوّد معيّن تحتاج امتداداً عبر `capabilities`.
- كل محوّل يحتاج اختباراً حقيقياً مع بيئة المزوّد الاختبارية.

## المصالحة الدورية — ليست اختيارية

مهمة يومية تقارن مدفوعات المزوّد بسجلاتنا وتكشف الانحراف.

**بدونها**، أي webhook مفقود = عميل دفع ولم يحصل على شيء = **أسوأ فشل تجاري ممكن**،
وسيكتشفه العميل قبلنا.

## سيناريوهات الاختبار الإلزامية

```
✓ webhook يصل قبل عودة المستخدم من صفحة الدفع
✓ webhook مكرر ×5
✓ webhook لا يصل أبداً → المصالحة تلتقطه
✓ نجاح الدفع + فشل تحديث DB → المصالحة تصلح
✓ توقيع فاسد → 401 بلا أي تغيير حالة
✓ أحداث خارج الترتيب
✓ استرداد جزئي متبوع باسترداد آخر
```
