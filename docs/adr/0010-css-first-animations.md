# ADR-0010 — الحركات بالـ CSS أولاً على الصفحة العامة

**الحالة:** ✅ Accepted · **اقتُرح:** 2026-08-16 · **اعتُمد:** 2026-08-16

## السياق

المتطلب: حركات «راقية وليست مبالغاً فيها»، **Performance friendly**، قابلة للإيقاف،
لا تسبب مشاكل على الهواتف الضعيفة، وتحترم `prefers-reduced-motion`.

السياق الحقيقي للاستخدام:
- الضيف على هاتف Android متوسط أو أقل، على شبكة 4G متفاوتة.
- يفتح الرابط من WhatsApp، ويمنح الصفحة **3 ثوانٍ**.
- ميزانيتنا: **≤ 90KB JS (gzip)** للصفحة العامة كاملة.

مكتبات الحركة الشائعة (`framer-motion`/`motion` ≈ 40–60KB gzip) ستستهلك **نصف الميزانية**
لتحقيق ما يفعله CSS مجاناً.

## القرار

**الصفحة العامة تستخدم CSS animations + IntersectionObserver فقط. لا مكتبة حركة.**

```css
@keyframes zf-fade-up {
  from { opacity: 0; transform: translate3d(0, 24px, 0); }
  to   { opacity: 1; transform: none; }
}
.zf-reveal {
  opacity: 0;
  animation: zf-fade-up var(--zf-motion-duration) var(--zf-motion-ease) forwards;
  animation-play-state: paused;
}
.zf-reveal[data-visible="true"] { animation-play-state: running; }

@media (prefers-reduced-motion: reduce) {
  .zf-reveal { opacity: 1; animation: none; }
}
```

مراقب واحد (~1KB) يضبط `data-visible`. **هذا كل شيء.**

### التقسيم حسب السطح

| السطح | التقنية | المبرر |
|-------|---------|--------|
| **الصفحة العامة** | CSS + IntersectionObserver | الأداء غير قابل للتفاوض هنا |
| Builder / Dashboard | Motion (framer-motion) | تفاعلات معقدة، وزن الحزمة أقل حساسية |
| مؤثرات خاصة (بتلات، لمعان) | Canvas خفيف مخصص، محمّل كسولاً | مكتبات الجسيمات ثقيلة جداً |

## البدائل المرفوضة

| البديل | لماذا |
|--------|-------|
| framer-motion على الصفحة العامة | 40–60KB gzip = نصف الميزانية، لفائدة صفرية على حركات كشف بسيطة |
| GSAP | قوي جداً لكنه ثقيل، ويحتاج ترخيصاً تجارياً لبعض الإضافات |
| Lottie | ملفات JSON ضخمة + مشغّل ثقيل |
| Web Animations API عبر JS | قوي، لكن CSS يكفي لحالاتنا والتصريحية أبسط للصيانة |
| لا حركات إطلاقاً | يفقد المنتج إحساس «الفخامة» — وهو جوهر عرض القيمة |

## قواعد إلزامية

1. **تُحرَّك `transform` و `opacity` فقط.**
   (`top`/`left`/`width`/`height` تسبب layout reflow ⇒ تلعثم على الأجهزة الضعيفة.)
2. `will-change` عند الحاجة فقط، ويُزال بعد انتهاء الحركة (يستهلك ذاكرة GPU).
3. `prefers-reduced-motion: reduce` **تعطّل كل شيء** — ليس تقليلاً بل تعطيلاً.
4. **زر ظاهر «إيقاف الحركات»** في الدعوة، يحفظ التفضيل في `localStorage`.
5. تعطيل تلقائي للتأثيرات الثقيلة عند:
   - `navigator.hardwareConcurrency ≤ 4`
   - `navigator.deviceMemory ≤ 4`
   - `navigator.connection.saveData === true`
   - بطارية منخفضة (حيثما يتوفر API)
6. حد أقصى **40 جسيماً** في تأثيرات Canvas، مقيّدة بـ `requestAnimationFrame`،
   وتتوقف عند `visibilitychange`.
7. Canvas يُحمَّل **بعد حدث `load`** — خارج المسار الحرج تماماً.

## العواقب

### إيجابية
- ~50KB JS موفّرة على الصفحة الأهم.
- الحركات تعمل على thread المُركِّب (compositor) ⇒ سلاسة حتى تحت ضغط JS.
- تعمل حتى لو فشل تحميل JS.
- الاستهلاك الحراري وعمر البطارية أفضل — مهم لحدث يستمر ساعات.

### سلبية
- تنسيق تسلسلات معقدة أصعب من واجهة تصريحية بـ JS.
- لا حركات مدفوعة بالفيزياء (spring) — **لا نحتاجها لتصميم أنيق**.
- انتقالات التخطيط (layout animations) غير متاحة — لا نستخدمها على الصفحة العامة.

## الاختبار

- Lighthouse CI يفشل عند تجاوز ميزانية JS.
- اختبار E2E: `prefers-reduced-motion` مفعّل ⇒ المحتوى مرئي فوراً بلا حركة.
- اختبار يدوي على هاتف Android متوسط حقيقي — ملاحظة التلعثم والحرارة.
- اللقطات البصرية تُلتقط مع تعطيل الحركات (لضمان الحتمية).
