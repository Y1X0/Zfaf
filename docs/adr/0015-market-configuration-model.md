# ADR-0015 — نموذج تكوين السوق (Market Configuration)

**الحالة:** ✅ Accepted · **التاريخ:** 2026-08-16 · **مصدر القرار:** موافقة Phase 0، البند 1

## السياق

المالك ثبّت: **السوق الأول هو السعودية**، مع قيد صريح:

> *«لا تعمل Architecture خاصة بالسعودية بطريقة تمنع التوسع… صمم النظام بحيث نستطيع
> إضافة الكويت والإمارات لاحقاً بدون إعادة بناء الـ Billing architecture.»*

الخطر الحقيقي ليس نظرياً — إنه نمط فشل معروف: يبدأ المشروع بسوق واحد، فتتسرب
افتراضاته إلى كل مكان (`SAR` مكتوبة مباشرة، `+966` مفترضة، `15%` ضريبة مُبرمَجة،
`Asia/Riyadh` افتراضية صلبة). عند التوسع، لا يُكتشف ذلك من مكان واحد بل من مئة موضع متناثر.

## القرار

**كل ما هو خاص بسوق = بيانات قابلة للتكوين، لا كود.**

### `MarketConfig`

```typescript
// packages/core/src/market/market-config.ts
export interface MarketConfig {
  code: string;                       // ISO 3166-1 alpha-2 — 'SA'
  displayName: Record<Locale, string>;
  isActive: boolean;

  currency: {
    code: string;                     // ISO 4217 — 'SAR'
    minorUnits: number;               // 2 (هللة)
    symbol: Record<Locale, string>;
  };

  defaultLocale: Locale;              // 'ar'
  supportedLocales: Locale[];
  defaultTimezone: string;            // IANA — 'Asia/Riyadh'

  phone: {
    countryCallingCode: string;       // '+966'
    nationalNumberLength: number[];
    exampleNumber: string;
  };

  // ⚠️ فارغ في MVP — يُملأ فقط بعد التحقق مع مختص
  tax: TaxConfig | null;

  // ⚠️ NullPaymentProvider في MVP
  paymentProviderKey: string;

  numeralSystem: 'latin' | 'arabic-indic';   // 'latin' (القرار #12)
}
```

### `TaxConfig` — مُعرَّف لكن غير مأهول

```typescript
export interface TaxConfig {
  ratesBasisPoints: number;      // نقاط أساس، لا float — 1500 = 15%
  pricesIncludeTax: boolean;
  registrationId: string | null;
  invoiceRequirements: string[]; // مفاتيح مجرّدة لا منطق
  effectiveFrom: string;
  verifiedBy: string;            // 🔒 اسم المختص الذي راجع
  verifiedAt: string;            // 🔒 تاريخ المراجعة
}
```

> 🔒 **الحقلان `verifiedBy` و `verifiedAt` إلزاميان.**
> النظام **يرفض تحميل `TaxConfig` بدونهما.** هذا يجعل من المستحيل تقنياً
> إدخال قاعدة ضريبية بلا مراجعة موثّقة — الضمانة مفروضة بالكود لا بالنية.

### سوق MVP

```typescript
export const SA: MarketConfig = {
  code: 'SA',
  currency: { code: 'SAR', minorUnits: 2, symbol: { ar: 'ر.س', en: 'SAR' } },
  defaultLocale: 'ar',
  supportedLocales: ['ar', 'en'],
  defaultTimezone: 'Asia/Riyadh',
  phone: { countryCallingCode: '+966', nationalNumberLength: [9], exampleNumber: '512345678' },
  tax: null,                    // ⚠️ لا افتراضات — لا دفع في MVP أصلاً
  paymentProviderKey: 'null',   // NullPaymentProvider
  numeralSystem: 'latin',
  isActive: true,
};
```

## قواعد التنفيذ المُلزِمة

| القاعدة | الفرض |
|---------|-------|
| ❌ لا `'SAR'` أو `'+966'` أو `'Asia/Riyadh'` مكتوبة مباشرة خارج `markets/` | قاعدة ESLint (قائمة رموز محظورة) تفشل CI |
| ❌ لا معدّل ضريبي مُبرمَج في أي مكان | نفس القاعدة |
| ✅ كل مبلغ يُخزَّن مع عملته | `amount INT` + `currency CHAR(3)` — لا عمود مبلغ بلا عملة |
| ✅ كل مبلغ بأصغر وحدة كعدد صحيح | ممنوع `float` للمال |
| ✅ السوق مُحلّ من سياق المستخدم لا من ثابت عام | `resolveMarket(user)` |
| ✅ اختبار «سوق ثانٍ» يعمل في CI | سوق وهمي `XX` بعملة ومنطقة زمنية مختلفتين |

### اختبار السوق الثاني — أهم ضمانة

```typescript
// tests/market-isolation.test.ts
const XX: MarketConfig = { code:'XX', currency:{code:'XXX',minorUnits:3,...},
                           defaultTimezone:'Pacific/Auckland', numeralSystem:'latin', ... };

it('كل التدفقات تعمل بسوق ثانٍ بعملة ومنطقة زمنية مختلفتين', async () => {
  const user = await seedUser({ market: 'XX' });
  const inv  = await createInvitation(user);
  await publishInvitation(inv);
  expect(rendered).not.toContain('SAR');
  expect(rendered).not.toContain('Riyadh');
});
```

> **قيمة هذا الاختبار:** أي تسرّب لافتراض سعودي يُكتشف **آلياً في CI**، لا بعد سنة
> عند محاولة دخول الكويت. `minorUnits: 3` يكشف افتراض «القسمة على 100» تحديداً.

## البدائل المرفوضة

| البديل | لماذا |
|--------|-------|
| ترميز السعودية صلباً والتعميم لاحقاً | نمط الفشل الموصوف أعلاه — التكلفة تُدفع مضاعفة |
| مكتبة i18n تجارية كاملة | تحلّ التوطين لا التكوين التجاري (عملة/ضريبة/دفع) |
| نموذج multi-tenant كامل بسوق لكل مستأجر | تعقيد هائل لا نحتاجه — سوق واحد نشط الآن |

## العواقب

### إيجابية
- إضافة الكويت/الإمارات = **صف إعدادات + محوّل دفع**، بلا مساس بالفوترة.
- الأسعار والضرائب والعملات تُدار كبيانات — قابلة للتغيير بلا نشر.
- **يستحيل تقنياً** إدخال قاعدة ضريبية بلا توثيق مراجعة.
- اختبار السوق الثاني يمنع تسرّب الافتراضات آلياً.

### سلبية
- تجريد إضافي بسيط (~2–3 أيام في Phase 1).
- تمرير `MarketConfig` عبر السياق — مخفَّف بحلّه مرة واحدة في طبقة النقل.

## ما لا يشمله هذا القرار

- **لا** توجيه تلقائي حسب موقع الزائر (خارج النطاق).
- **لا** تعدد عملات لمستخدم واحد.
- **لا** أسواق نشطة متعددة في Phase 1 — واحد فقط، لكن **البنية تحتمل أكثر**.
