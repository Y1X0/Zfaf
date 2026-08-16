# 07 — Frontend Architecture

**الإصدار:** v0.1 · **الحالة:** Draft

---

## 1. بنية التطبيق

```
apps/web/src/
├── app/
│   ├── [locale]/                        ← ar | en
│   │   ├── (marketing)/                 ← عام، ثابت، مخزَّن بقوة
│   │   │   ├── page.tsx                 الصفحة الرئيسية
│   │   │   ├── templates/               معرض القوالب
│   │   │   ├── pricing/  faq/  about/
│   │   │   └── legal/{terms,privacy}/
│   │   │
│   │   ├── (auth)/                      ← تخطيط بلا chrome
│   │   │   ├── login/  register/
│   │   │   ├── verify-email/  forgot-password/  reset-password/
│   │   │
│   │   ├── (app)/                       ← يتطلب جلسة
│   │   │   ├── dashboard/
│   │   │   │   ├── page.tsx             قائمة الدعوات
│   │   │   │   ├── invitations/[id]/
│   │   │   │   │   ├── rsvp/            لوحة الردود
│   │   │   │   │   └── analytics/
│   │   │   │   └── settings/
│   │   │   └── builder/[id]/            ← تخطيط ملء الشاشة
│   │   │
│   │   └── (admin)/admin/               ← يتطلب دور + 2FA
│   │
│   ├── i/[slug]/                        ★★★ الصفحة العامة — خارج [locale] عمداً
│   │   ├── page.tsx                     لأن لغتها تتبع الدعوة لا الزائر
│   │   ├── opengraph-image.tsx
│   │   └── not-found.tsx
│   │
│   ├── preview/[id]/                    إطار المعاينة (noindex)
│   └── api/                             Route handlers
│
├── components/    {ui, marketing, dashboard, builder, forms}
├── lib/           {api-client, session, i18n, analytics, utils}
├── styles/        globals.css, tokens.css, fonts.css
└── messages/      ar.json, en.json
```

**قرار بنيوي:** `/i/[slug]` **خارج** مقطع `[locale]`.
لغة الدعوة خاصية للدعوة نفسها لا للزائر — دعوة عربية تُعرض عربية لضيف في لندن.
وضعها تحت `[locale]` كان سيولّد روابط مزدوجة (`/ar/i/x` و `/en/i/x`) لنفس المحتوى، وهذا خطأ SEO ومشاركة.

---

## 2. استراتيجية العرض

| المسار | الوضع | التخزين المؤقت | JS للعميل |
|--------|-------|-----------------|-----------|
| `/` والتسويق | Static (SSG) | `s-maxage=3600, SWR` | أدنى |
| `/templates` | ISR | `s-maxage=600` | متوسط (معاينات) |
| **`/i/[slug]`** ★ | **Dynamic + CDN cache** | `s-maxage=300, SWR=86400` | **أدنى ما يمكن** |
| `/dashboard/*` | Dynamic، بلا cache | `private, no-store` | متوسط |
| `/builder/[id]` | SPA فعلياً بعد التحميل | `no-store` | الأعلى (مقبول) |
| `/admin/*` | Dynamic | `no-store` | متوسط |

### لماذا `/i/[slug]` ديناميكية لا مولّدة مسبقاً؟

- عشرات الآلاف من الدعوات → التوليد المسبق لكلها غير عملي.
- التخزين على مستوى CDN بـ `Cache-Tag` يعطي **نفس الأداء** مع إبطال دقيق ومستهدف.
- المرة الأولى بعد النشر تُنشئ الـ cache؛ كل ما بعدها من الحافة.

---

## 3. تقسيم Server / Client Components

**القاعدة: Server Component افتراضياً. `'use client'` استثناء مبرَّر.**

### الصفحة العامة — تفصيل حاسم

```
Server Components (صفر JS للعميل):
  ├── Hero               (نص + صورة)
  ├── Couple             (نص + صور)
  ├── Events             (نص)
  ├── Location           (نص + رابط خريطة — بلا خريطة مضمّنة!)
  ├── Message
  ├── Story
  └── Footer

Client Components (بمبرر صريح):
  ├── Countdown          يحتاج مؤقتاً حياً                    ~2KB
  ├── RsvpForm           تفاعل نموذج + حالة                  ~6KB
  ├── GalleryLightbox    تفاعل — يُحمَّل كسولاً عند أول نقر    ~5KB (مؤجل)
  ├── MusicPlayer        تحكم بالصوت                          ~3KB
  ├── ShareButtons       Web Share API                        ~1KB
  └── ScrollReveal       IntersectionObserver                 ~1KB

المجموع الأولي: ~13KB — والمعرض مؤجّل حتى التفاعل.
```

**قرار مهم:** قسم الموقع **لا يضمّن خريطة تفاعلية**. خرائط Google المضمّنة تضيف
300KB+ من JS وطلبات طرف ثالث وتتبعاً. البديل: **صورة خريطة ثابتة + زر يفتح تطبيق الخرائط**.
هذا أسرع وأخصّ للجوال (المستخدم يريد الملاحة، لا التصفح داخل صفحتنا).

---

## 4. i18n و RTL

### التوجيه

```
/ar/...  ← الافتراضي (بلا redirect من /)
/en/...
/i/{slug}  ← اللغة من بيانات الدعوة
```

### المكتبة: `next-intl`

```tsx
// خادم
const t = await getTranslations('dashboard');
// عميل
const t = useTranslations('builder');
```

### RTL — قواعد غير قابلة للتفاوض

1. **CSS Logical Properties حصراً**
   ```css
   /* ❌ ممنوع */  margin-left: 1rem;  padding-right: 2rem;  text-align: left;
   /* ✅ مطلوب */  margin-inline-start: 1rem;  padding-inline-end: 2rem;  text-align: start;
   ```
   Tailwind v4: `ms-4`, `me-4`, `ps-2`, `pe-2`, `text-start`, `border-s`, `rounded-s-lg`.
   **قاعدة ESLint مخصصة تمنع الخصائص الفيزيائية في `packages/ui` و `invitation-renderer` — تفشل CI.**

2. **الأيقونات الاتجاهية تنعكس**
   ```css
   [dir="rtl"] .icon-arrow-forward { transform: scaleX(-1); }
   ```
   لكن: أيقونات **غير** اتجاهية (تشغيل الصوت، ساعة، قلب) لا تنعكس. قائمة صريحة في `packages/ui`.

3. **الأرقام والتواريخ** عبر `Intl` دائماً، لا تنسيق يدوي.

4. **المحتوى المختلط** (اسم إنجليزي داخل نص عربي) يحتاج `<bdi>` لعزل الاتجاه.

5. **الاختبار:** كل لقطة بصرية تُلتقط بلغتين. الاختلاف البصري غير المتوقع = فشل.

📄 [ADR-0011](adr/0011-i18n-and-rtl-strategy.md)

---

## 5. الطباعة (Typography)

### الخطوط ومبرراتها

| الدور | العربية | اللاتينية | الحجم بعد التقسيم |
|-------|---------|-----------|--------------------|
| Display | Aref Ruqaa / Amiri / Reem Kufi | Cormorant Garamond / Playfair | ~40–90KB |
| Body | IBM Plex Sans Arabic / Tajawal | Inter | ~35–60KB |

كلها **OFL** — مرخّصة للاستخدام التجاري وإعادة التوزيع.

### التحميل

```css
@font-face {
  font-family: 'IBM Plex Sans Arabic';
  src: url('/fonts/plex-arabic-subset.woff2') format('woff2');
  font-display: swap;            /* النص يظهر فوراً بخط بديل */
  unicode-range: U+0600-06FF, U+0750-077F, U+FB50-FDFF, U+FE70-FEFF, U+0020-007F;
}
```

- **Subsetting إلزامي.** Amiri كاملاً > 400KB؛ بعد التقسيم للنطاق العربي الأساسي ~90KB.
- `preload` لخط **العرض فقط** (يظهر في الـ hero = LCP). خط النص عبر `swap`.
- خط بديل متوافق المقاييس (`size-adjust`) لتقليل انزياح التخطيط عند التبديل.

### قواعد النص العربي

```css
.zf-arabic {
  line-height: 1.9;          /* أعلى من اللاتينية — النقاط والتشكيل تحتاج مساحة */
  letter-spacing: 0;         /* ⚠️ أي قيمة أخرى تكسر اتصال الحروف — ممنوع */
  word-spacing: 0.05em;
  text-wrap: pretty;
  font-feature-settings: "liga" 1, "calt" 1;   /* الإدغام والأشكال السياقية */
}
```

**الحد الأدنى للقراءة على الجوال: 16px للنص العربي** (أصغر = صعوبة كبيرة، خصوصاً للفئة الأكبر سناً).

---

## 6. نظام التصميم (`packages/ui`)

```
packages/ui/src/
├── tokens/       colors.css  typography.css  spacing.css  motion.css
├── primitives/   Button Input Select Textarea Checkbox Radio Switch
│                 Dialog Popover Tooltip Tabs Accordion Toast
│                 Card Badge Avatar Skeleton Spinner
├── patterns/     FormField  EmptyState  ConfirmDialog  FileDropzone
│                 ColorPicker  StepIndicator  DataTable
└── hooks/        useMediaQuery  useDebounce  useLocalStorage
                  useIntersection  useReducedMotion
```

مبنية فوق **Radix UI** — نحصل على الوصولية والسلوك الصحيح، ونتحكم بالكامل في المظهر.
كل مكوّن يدعم RTL بلا إعداد إضافي.

---

## 7. الحركات

### الصفحة العامة: CSS فقط

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

مراقب واحد (~1KB) يضبط `data-visible`. **لا مكتبة animation على الصفحة العامة.**

### المؤثرات الخاصة (بتلات، لمعان)

- Canvas خفيف مخصص، **يُحمَّل كسولاً بعد `load`**، وخارج المسار الحرج تماماً.
- حد أقصى 40 جسيماً، مقيّد بـ `requestAnimationFrame`، يتوقف عند `visibilitychange`.
- **يُعطَّل تلقائياً** عند: `prefers-reduced-motion` · `hardwareConcurrency ≤ 4` · `deviceMemory ≤ 4`
  · `navigator.connection.saveData` · بطارية منخفضة (حيثما يتوفر API).

### قواعد
- تحريك `transform` و `opacity` فقط.
- `will-change` عند الحاجة فقط ويُزال بعدها (وإلا يستهلك ذاكرة GPU).
- زر ظاهر «إيقاف الحركات» يحفظ التفضيل في `localStorage`.

📄 [ADR-0010](adr/0010-css-first-animations.md)

---

## 8. الصوت — التعامل مع قيود المتصفحات

**الواقع:** لا متصفح حديث يسمح بتشغيل صوت تلقائي بلا تفاعل. iOS Safari الأصرم.
محاولة الالتفاف تنتج تجربة مكسورة. **الحل: اجعل التفاعل جزءاً من التصميم.**

```
فتح الدعوة
   │
   ▼
┌───────────────────────────────┐
│                               │
│      أحمد & سارة              │
│                               │
│    ╭─────────────────╮        │
│    │  افتح الدعوة 🎵 │        │  ← الضغط = التفاعل المطلوب
│    ╰─────────────────╯        │     (يبدو كجزء من التجربة لا كعائق)
│                               │
└───────────────────────────────┘
   │
   ├─ تشغيل الصوت (مسموح الآن)
   ├─ بدء حركة الافتتاح
   └─ زر تحكم عائم يبقى ظاهراً: ▶ ⏸ 🔇 🔊
```

**تفاصيل تقنية:**
- الصوت `preload="none"` — لا يُحمَّل إلا عند الطلب. لا نهدر باقة الضيف.
- `play()` داخل معالج الحدث مباشرة (لا داخل `await` أو `setTimeout` — يُعتبر فقدان «إيماءة المستخدم»).
- الفشل يُعالَج بصمت: تظهر أيقونة «تشغيل» بدل رسالة خطأ.
- `pause` عند `visibilitychange` (تبديل التبويب) — احترام للمستخدم.
- **متصفح WhatsApp الداخلي يتصرف بشكل مختلف** — يُختبَر يدوياً على iOS وAndroid قبل كل إطلاق.
- تفضيل صامت/غير صامت يُحفظ في `sessionStorage`.

---

## 9. الصور

```tsx
<img
  src={media.variants.medium.avif}
  srcSet={`${v.small.avif} 400w, ${v.medium.avif} 1080w, ${v.full.avif} 1920w`}
  sizes="(max-width: 768px) 100vw, 800px"
  width={media.width} height={media.height}     /* ⚠️ إلزامي — يمنع CLS */
  loading={isAboveFold ? 'eager' : 'lazy'}
  fetchPriority={isHero ? 'high' : 'auto'}
  decoding="async"
  style={{ backgroundImage: `url(${blurhashDataUri})`, backgroundSize: 'cover' }}
  alt={alt}
/>
```

- **AVIF أولاً**، WebP ثانياً، JPEG احتياطياً عبر `<picture>`.
- `width`/`height` دائماً → CLS = 0.
- Blurhash كخلفية → لا فراغ أبيض أثناء التحميل (تجربة مهمة على الشبكات البطيئة).
- صورة الـ hero: `preload` في `<head>` لتحسين LCP.

---

## 10. ميزانيات الأداء (تُفرَض في CI)

| المسار | JS (gzip) | CSS | LCP | INP | CLS | المرجع |
|--------|-----------|-----|-----|-----|-----|--------|
| `/i/[slug]` | ≤ 90KB | ≤ 25KB | ≤ 2.0s | ≤ 150ms | ≤ 0.05 | [ADR-0020](adr/0020-zero-hydration-public-page.md) |
| `/` و `/en` (تسويق) | ≤ 144KB | ≤ 30KB | ≤ 2.0s | ≤ 200ms | ≤ 0.05 | [ADR-0021](adr/0021-marketing-surface-js-budget.md) |
| `/dashboard` | ≤ 200KB | ≤ 40KB | ≤ 2.5s | ≤ 200ms | ≤ 0.10 | PRD §4.3 |
| `/builder/[id]` | ≤ 250KB | ≤ 50KB | ≤ 2.5s | ≤ 200ms | ≤ 0.10 | PRD §4.3 |

**هذان الرقمان العامّان منفصلان عمداً ولا يُدمجان.** `/i/[slug]` سطح HTML مبثوث
بلا hydration لضيوف على 4G بطيئة، والمقاس **2.5 KB**. سطح التسويق صفحات App Router
مولَّدة ساكناً لمشترٍ يتصفّح، والمقاس **138.4 KB** — **138.4 منها أرضية الإطار
و0 بايت كودنا**. التفصيل الكامل والمنهجية وشروط المراجعة في
[ADR-0021](adr/0021-marketing-surface-js-budget.md).

**الفرض في CI:** `scripts/measure-bundles.mjs` يقيس السطحين **من الوثيقة
المُقدَّمة** من خادم الإنتاج القائم بذاته — لا من ملصق Next ولا من بيان البناء —
ويقيس التسويق على **اللغتين** ويحتسب الأعلى. تجاوز الميزانية = بناء فاشل.
هذا ما يمنع التسلل التدريجي للثقل — وهو أكثر ما يقتل أداء منتجات كهذه.

---

## 11. الاستعلامات وحالة الخادم

```typescript
// TanStack Query للبيانات من الخادم
const { data } = useQuery({
  queryKey: ['invitation', id, 'rsvps', filters],
  queryFn: () => api.rsvps.list(id, filters),
  staleTime: 30_000,
});

// تحديث متفائل حيث يكون آمناً
const mutation = useMutation({
  mutationFn: api.invitations.updateDocument,
  onMutate: async (patch) => { /* تطبيق فوري + حفظ للتراجع */ },
  onError:   (e, v, ctx) => { /* استرجاع + إشعار */ },
});
```

**قاعدة:** التحديث المتفائل للأشياء التي لا يضرّ فشلها (تعديل نص).
**ليس** لما يجب أن يُثبَّت قبل الاطمئنان (نشر، دفع، حذف).

---

## 12. حدود الأخطاء

```
RootErrorBoundary          → صفحة خطأ عامة + تقرير Sentry
  └─ RouteErrorBoundary    → خطأ داخل التخطيط، الشريط الجانبي يعمل
      └─ SectionBoundary   → قسم واحد يفشل، الدعوة تكمل
          └─ ImageFallback → صورة تفشل، البديل يظهر
```

على الصفحة العامة تحديداً: **لا شيء يجب أن ينتج شاشة بيضاء.** أسوأ حالة مقبولة:
دعوة بنص كامل وصور ناقصة.

---

## 13. الوصولية

- WCAG 2.1 **AA** كحد أدنى في كل الأسطح.
- كل الوظائف متاحة بلوحة المفاتيح.
- حلقة تركيز مرئية (لا `outline: none` بلا بديل).
- `axe-core` في اختبارات E2E — الانتهاكات الحرجة تفشل الـ build.
- الحركات تحترم `prefers-reduced-motion`.
- تسمية عربية صحيحة لقارئات الشاشة (`lang="ar"` على العناصر العربية).

---

## 14. SEO

| الصفحة | الفهرسة |
|--------|---------|
| التسويق | ✅ فهرسة كاملة + sitemap + بيانات منظمة |
| `/i/[slug]` | ❌ **`noindex` افتراضياً** — الدعوات خاصة |
| `/dashboard`, `/builder`, `/admin` | ❌ noindex |

> **قرار خصوصية مقصود:** الدعوة تحمل أسماء وصوراً وموقعاً وتوقيتاً لعائلة حقيقية.
> فهرستها في Google افتراضياً تسريب خصوصية. المستخدم يستطيع تفعيل الفهرسة صراحةً إن أراد.
> الـ OG meta تعمل بغض النظر عن الفهرسة — فالمشاركة على WhatsApp لا تتأثر.

**بيانات منظمة للتسويق:** `Organization`, `Product`, `FAQPage`, `BreadcrumbList`.
