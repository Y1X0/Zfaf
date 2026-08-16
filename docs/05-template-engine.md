# 05 — Template Engine Architecture

**الإصدار:** v0.1 · **الحالة:** Draft

> هذه أهم قطعة تقنية في المنتج. إن أخطأنا هنا، تتحول المنصة إلى ورشة لصناعة صفحات
> يدوية، ويصبح كل قالب جديد مشروعاً بحد ذاته. الهدف: **قالب جديد = ملف JSON + أصول، بلا تعديل كود.**

---

## 1. المشكلة التي يحلها

النهج الساذج: كل قالب مكوّن React مستقل.

```
templates/
  ClassicLuxury.tsx     ← 800 سطر
  RoyalGold.tsx         ← 800 سطر، 70% منها منسوخة
  MinimalWhite.tsx      ← 800 سطر، 70% منها منسوخة
```

النتائج الحتمية لهذا النهج:
- إصلاح خطأ في العد التنازلي ⇒ تعديله في 7 ملفات (وستنسى واحداً).
- إضافة قسم جديد ⇒ تعديل كل قالب.
- المستخدم لا يستطيع خلط: «تخطيط Royal Gold + معرض Minimal».
- لا يمكن لغير المبرمج إضافة قالب.
- استحالة إصدار نسخ من القوالب بأمان.
- Marketplace للمصممين (Phase 3) مستحيل تقنياً.

**الحل:** فصل **البنية** (ما هي الأقسام وترتيبها) عن **العرض** (كيف يبدو القسم)
عن **الأسلوب** (الألوان والخطوط) عن **المحتوى** (بيانات المستخدم).

---

## 2. النموذج المفاهيمي

```
   Template Manifest            ← JSON، يملكه المصمم/الأدمن
   (ما هي الأقسام، أي variant، الثيم الافتراضي)
            │
            ▼
   Invitation Document          ← JSON، يملكه المستخدم
   (الأقسام المفعّلة + ترتيبها + تجاوزات الثيم + المحتوى)
            │
            ▼
   Section Registry             ← كود، يملكه المهندس
   (type + variant → مكوّن React + schema + محرر)
            │
            ▼
   InvitationRenderer           ← دالة خالصة
            │
            ▼
   HTML + CSS Variables
```

**قاعدة الفصل الذهبية:**

| الطبقة | من يملكها | التغيير فيها يعني |
|--------|-----------|--------------------|
| Manifest | مصمم / أدمن | قالب جديد أو نسخة جديدة — **بلا نشر كود** |
| Document | المستخدم النهائي | تخصيص دعوة — **بلا نشر كود** |
| Registry | مهندس | قدرة بصرية جديدة — **يحتاج نشر كود** |
| Renderer | مهندس | نادراً جداً |

نقطة الاختبار الحقيقية: **إضافة القالب الرابع يجب ألا تلمس الـ Registry إطلاقاً.**
لهذا نبني في MVP ثلاثة قوالب **مختلفة جذرياً** — لنكتشف نواقص الـ Registry مبكراً لا متأخراً.

---

## 3. Template Manifest

### 3.1 المخطط

```typescript
// packages/template-engine/src/schema/manifest.ts
const TemplateManifest = z.object({
  schemaVersion: z.literal(1),
  key: z.string().regex(/^[a-z0-9-]+$/),
  version: z.number().int().positive(),

  meta: z.object({
    name:        z.record(z.string()),            // { ar, en }
    description: z.record(z.string()),
    category:    z.enum(['classic','modern','floral','traditional','minimal']),
    author:      z.string(),
    previewImage: z.string(),
    requiredPlanLevel: z.number().int().min(0).default(0),
    supportedLocales: z.array(z.string()).default(['ar','en']),
  }),

  // ── الثيم الافتراضي: قيم تصبح CSS custom properties ──
  theme: z.object({
    colors: z.object({
      primary: HexColor, secondary: HexColor, accent: HexColor,
      background: HexColor, surface: HexColor,
      textPrimary: HexColor, textSecondary: HexColor,
      overlay: z.string(),
    }),
    typography: z.object({
      displayFont: FontKey,      // مرجع لسجل الخطوط المسموح
      bodyFont:    FontKey,
      scale:       z.enum(['compact','normal','generous']).default('normal'),
      displayWeight: z.number().default(400),
    }),
    spacing:  z.enum(['tight','normal','airy']).default('normal'),
    radius:   z.enum(['sharp','soft','round','pill']).default('soft'),
    buttons:  z.enum(['solid','outline','ghost','gradient']).default('solid'),
    dividers: z.enum(['none','line','ornament','floral','geometric']).default('ornament'),
    background: z.object({
      kind: z.enum(['solid','gradient','pattern','image']),
      value: z.string(),
      overlayOpacity: z.number().min(0).max(1).default(0),
    }),
    motion: z.object({
      intensity: z.enum(['none','subtle','moderate','rich']).default('subtle'),
      effects:   z.array(z.enum(['petals','sparkle','float','parallax','waxSeal'])).default([]),
    }),
  }),

  // ── أي التخصيصات يُسمح للمستخدم بتغييرها ──
  customizable: z.object({
    colors:     z.array(z.string()).default(['primary','secondary','background']),
    fonts:      z.boolean().default(true),
    fontOptions: z.array(FontKey).optional(),   // تقييد لخطوط تليق بالقالب
    spacing:    z.boolean().default(false),
    motion:     z.boolean().default(true),
    sectionOrder: z.boolean().default(true),
  }),

  // ── الأقسام: البنية الافتراضية ──
  sections: z.array(z.object({
    type:     SectionType,                    // 'hero' | 'couple' | ...
    variant:  z.string(),                     // 'hero.centeredArch'
    enabled:  z.boolean().default(true),
    required: z.boolean().default(false),     // required ⇒ لا يمكن تعطيله
    order:    z.number().int(),
    props:    z.record(z.unknown()).default({}),  // يُتحقق منه بـ schema الـ variant
  })),

  assets: z.object({
    ornaments:  z.array(z.string()).default([]),
    patterns:   z.array(z.string()).default([]),
    fontSubsets: z.array(z.string()).default([]),
  }).default({}),
});
```

### 3.2 مثال مختصر

```jsonc
{
  "schemaVersion": 1,
  "key": "royal-gold",
  "version": 3,
  "meta": {
    "name": { "ar": "الملكي الذهبي", "en": "Royal Gold" },
    "category": "classic",
    "requiredPlanLevel": 1
  },
  "theme": {
    "colors": {
      "primary": "#C9A227", "secondary": "#1B1B1B", "accent": "#E8D9A0",
      "background": "#0E0E0E", "surface": "#171717",
      "textPrimary": "#F5F0E1", "textSecondary": "#BFB48F",
      "overlay": "rgba(0,0,0,0.55)"
    },
    "typography": { "displayFont": "aref-ruqaa", "bodyFont": "ibm-plex-arabic", "scale": "generous" },
    "radius": "sharp",
    "buttons": "outline",
    "dividers": "ornament",
    "background": { "kind": "pattern", "value": "islamic-geo-01", "overlayOpacity": 0.85 },
    "motion": { "intensity": "moderate", "effects": ["sparkle", "waxSeal"] }
  },
  "customizable": {
    "colors": ["primary", "accent"],
    "fonts": true,
    "fontOptions": ["aref-ruqaa", "amiri", "reem-kufi"],
    "motion": true,
    "sectionOrder": true
  },
  "sections": [
    { "type": "hero",       "variant": "hero.waxSeal",        "order": 1, "required": true,
      "props": { "showDate": true, "sealText": "أ & س", "openAnimation": "seal" } },
    { "type": "couple",     "variant": "couple.portraitPair",  "order": 2 },
    { "type": "countdown",  "variant": "countdown.ornateBoxes", "order": 3 },
    { "type": "events",     "variant": "events.timeline",       "order": 4 },
    { "type": "location",   "variant": "location.mapCard",      "order": 5 },
    { "type": "gallery",    "variant": "gallery.masonry",       "order": 6 },
    { "type": "rsvp",       "variant": "rsvp.elegantForm",      "order": 7 },
    { "type": "footer",     "variant": "footer.ornament",       "order": 8, "required": true }
  ],
  "assets": { "ornaments": ["gold-corner", "gold-divider"], "patterns": ["islamic-geo-01"] }
}
```

---

## 4. Section Registry

### 4.1 البنية

```typescript
// packages/invitation-renderer/src/registry/index.ts
export interface SectionVariantDefinition<P> {
  id: string;                       // 'hero.waxSeal'
  type: SectionType;                // 'hero'
  propsSchema: z.ZodType<P>;        // تحقق + أنواع + توثيق
  defaultProps: P;
  Component: React.ComponentType<SectionRenderProps<P>>;

  editor: EditorFieldDefinition[];  // ما يظهر في الـ Builder — يُولَّد آلياً

  capabilities: {
    needsMedia?:  ('cover'|'couple'|'gallery')[];
    needsEvents?: boolean;
    needsLocation?: boolean;
    heavyAnimation?: boolean;       // يُعطَّل على الأجهزة الضعيفة
    aboveTheFold?: boolean;         // يؤثر على أولوية تحميل الصور
  };

  a11y: { landmark?: string; headingLevel?: 1|2|3 };
}
```

### 4.2 أنواع الأقسام (ثابتة) والمتغيرات (تنمو)

| Type | الغرض | Variants في MVP |
|------|-------|------------------|
| `hero` | الافتتاحية | `centeredArch`, `fullBleedPhoto`, `waxSeal` |
| `couple` | العروسان | `portraitPair`, `namesOnly`, `sideBySide` |
| `countdown` | العد التنازلي | `ornateBoxes`, `minimalDigits`, `circularRings` |
| `events` | جدول الحفل | `timeline`, `cards`, `simpleList` |
| `location` | المكان | `mapCard`, `textWithButton` |
| `gallery` | المعرض | `masonry`, `carousel`, `grid` |
| `story` | قصتنا | `timeline`, `quote` |
| `rsvp` | تأكيد الحضور | `elegantForm`, `compactForm` |
| `message` | رسالة خاصة | `centeredQuote`, `letterCard` |
| `music` | مشغل الموسيقى | `floatingButton`, `inlineBar` |
| `footer` | الخاتمة | `ornament`, `minimal` |

**قاعدة توسّع مهمة:**
- **إضافة variant** = عمل مهندس، يفتح احتمالات لكل القوالب فوراً.
- **إضافة type جديد** = قرار أثقل (يحتاج مساحة في المحرر والبيانات) ويحتاج مراجعة.

بـ 11 نوعاً × 2–3 variants + تخصيص الثيم، فضاء التصاميم الممكنة **بالآلاف** —
بينما عدد المكوّنات المصانة يبقى ~28.

### 4.3 عقد المكوّن

كل مكوّن قسم يستقبل نفس الشكل — وهذا ما يجعل الـ Renderer عاماً:

```typescript
interface SectionRenderProps<P> {
  props:   P;                 // خصائص القسم (مُتحقَّق منها)
  content: InvitationContent; // بيانات المستخدم (أسماء، تواريخ، وسائط...)
  theme:   ResolvedTheme;     // للحالات النادرة — الأصل استخدام CSS variables
  locale:  'ar' | 'en';
  dir:     'rtl' | 'ltr';
  mode:    'preview' | 'published';   // preview قد يُظهر placeholders
  index:   number;
}
```

**قيود صارمة على مكوّنات الأقسام:**
- ❌ لا `fetch` ولا وصول لقاعدة بيانات ولا `Date.now()` عند العرض الأولي (يكسر الحتمية).
- ❌ لا استيراد مباشر من `packages/db` أو `core`.
- ✅ ألوان وخطوط عبر CSS variables فقط — لا قيم مكتوبة مباشرة.
- ✅ CSS Logical Properties فقط (`inline-start` لا `left`).
- ✅ Server Component افتراضياً؛ `'use client'` فقط للأقسام التفاعلية (countdown, rsvp, gallery, music).

---

## 5. Invitation Document

```typescript
interface InvitationDocument {
  schemaVersion: 1;
  templateKey: string;
  templateVersion: number;

  themeOverrides: DeepPartial<Theme>;   // فقط ما غيّره المستخدم — لا نسخة كاملة

  sections: Array<{
    id: string;          // مستقر عبر إعادة الترتيب
    type: SectionType;
    variant: string;
    enabled: boolean;
    order: number;
    props: Record<string, unknown>;
  }>;

  content: {
    couple: { groomName, brideName, shortName?, message?, coupleMediaId? };
    wedding: { date, time?, endTime?, timezone };
    location: { venueName?, address?, lat?, lng?, mapsUrl? };
    events: EventRef[];
    media: { coverId?, galleryIds: string[] };
    music: { trackId?: string; customMediaId?: string; autoplayPrompt: boolean };
    rsvp: { enabled, deadline?, maxPartySize, customQuestion? };
    custom: Record<string, string>;   // نصوص يحتاجها variant معيّن
  };
}
```

> **`themeOverrides` جزئي عمداً.** لو خزّنّا الثيم كاملاً، لن يستفيد المستخدم أبداً من تحسين
> ألوان القالب في نسخة لاحقة. الجزئي يعني: «غيّرتُ اللون الأساسي فقط» → باقي التحسينات تصله تلقائياً.

---

## 6. حل الثيم (Theme Resolution)

```
theme الافتراضي في Manifest
        ⊕ themeOverrides من المستخدم    (دمج عميق، الأولوية للمستخدم)
        ⊕ قيود الوصولية (accessibility guards)
        ▼
   ResolvedTheme
        ▼
   CSS Custom Properties
```

### حارس التباين (Contrast Guard) — إلزامي

المستخدم قد يختار خلفية بيضاء ونصاً ذهبياً فاتحاً. النتيجة: دعوة غير مقروءة لنصف الضيوف.

```typescript
function applyA11yGuards(theme: Theme): ResolvedTheme {
  const ratio = contrastRatio(theme.colors.textPrimary, theme.colors.background);
  if (ratio < 4.5) {
    // لا نرفض اختيار المستخدم — نصحّح بأقل تدخل ممكن
    theme.colors.textPrimary = adjustLightnessUntilContrast(
      theme.colors.textPrimary, theme.colors.background, 4.5
    );
    warnings.push('TEXT_CONTRAST_ADJUSTED');
  }
  // نفس الشيء لنص الأزرار وحدود الحقول
  return theme;
}
```
الـ Builder يُظهر التحذير للمستخدم مع الخيار: «استخدم اللون المصحَّح» / «أعرف ما أفعل».

### الإخراج

```html
<style id="zf-theme">
:root{
  --zf-color-primary:#c9a227;
  --zf-color-bg:#0e0e0e;
  --zf-color-text:#f5f0e1;
  --zf-font-display:"Aref Ruqaa",serif;
  --zf-font-body:"IBM Plex Sans Arabic",sans-serif;
  --zf-radius:0px;
  --zf-space-section:clamp(3rem,8vw,6rem);
  --zf-motion-duration:600ms;
}
@media (prefers-reduced-motion: reduce){
  :root{ --zf-motion-duration:0ms }
}
</style>
```

**لماذا inline في `<head>` بدل ملف CSS؟**
لا طلب شبكة إضافي، لا وميض ألوان (FOUC)، وتغيير الثيم في المعاينة = تحديث CSS variable
واحد → **إعادة رسم فورية بلا re-render لشجرة React.** هذا ما يجعل المعاينة الحيّة تبدو فورية.

---

## 7. InvitationRenderer

```typescript
// packages/invitation-renderer/src/render.tsx
export function InvitationRenderer({ document, resolvedContent, locale, mode }: Props) {
  const theme = resolveTheme(document.templateKey, document.templateVersion, document.themeOverrides);
  const sections = document.sections
    .filter(s => s.enabled)
    .sort((a, b) => a.order - b.order);

  return (
    <>
      <ThemeStyle theme={theme} />
      <FontLoader fonts={[theme.typography.displayFont, theme.typography.bodyFont]} locale={locale} />
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'} className="zf-invitation">
        {sections.map((s, i) => {
          const def = registry.get(s.type, s.variant);
          if (!def) return <MissingSectionFallback key={s.id} type={s.type} />;  // لا نكسر الصفحة أبداً

          const parsed = def.propsSchema.safeParse({ ...def.defaultProps, ...s.props });
          const props  = parsed.success ? parsed.data : def.defaultProps;         // تدهور رشيق

          return (
            <SectionBoundary key={s.id} sectionId={s.id}>
              <def.Component props={props} content={resolvedContent}
                             theme={theme} locale={locale}
                             dir={locale==='ar'?'rtl':'ltr'} mode={mode} index={i} />
            </SectionBoundary>
          );
        })}
      </main>
    </>
  );
}
```

### خصائص إلزامية للـ Renderer

| الخاصية | لماذا | كيف نفرضها |
|---------|-------|-------------|
| **حتمي (Deterministic)** | نفس المدخل ⇒ نفس المخرج، دائماً | اختبار: عرض نفس المستند 100 مرة ومقارنة HTML |
| **خالص (Pure)** | لا I/O، لا عشوائية، لا وقت حالي | قاعدة ESLint تمنع `Math.random`/`Date.now` في مسار العرض |
| **آمن ضد الفشل** | قسم مكسور ≠ دعوة مكسورة | `SectionBoundary` = Error Boundary لكل قسم |
| **متسامح مع النسخ** | مستند قديم يظل يعمل | fallback على variant افتراضي عند عدم وجود المطلوب |
| **مشترك** | نفس الكود للمعاينة والنشر | حزمة واحدة تُستورد من الاثنين |

---

## 8. إصدارات القوالب والترحيل

```
template_versions:  royal-gold v1 ─── v2 ─── v3 (current)
                        │              │        │
                     دعوة A         دعوة B    دعوة جديدة
                     (مثبّتة)       (مثبّتة)   (تبدأ من v3)
```

**القواعد:**
1. النسخة المنشورة **immutable**.
2. الدعوة المنشورة مثبّتة على `templateVersion` وقت النشر.
3. المستخدم يُعرض عليه اختيارياً: «يوجد تحديث لهذا القالب — عاينه؟» (لا ترقية إجبارية).
4. الترقية = صريحة، مع معاينة قبل/بعد، وقابلة للتراجع.

### دوال الترحيل

```typescript
export const migrations: Record<string, DocumentMigration> = {
  'royal-gold:1->2': (doc) => {
    // v2 قسّمت hero إلى hero + couple
    const hero = doc.sections.find(s => s.type === 'hero');
    if (hero && !doc.sections.some(s => s.type === 'couple')) {
      doc.sections.push({
        id: newId(), type: 'couple', variant: 'couple.namesOnly',
        enabled: true, order: hero.order + 0.5, props: {},
      });
    }
    return normalizeOrder(doc);
  },
};
```
كل دالة ترحيل تحتاج **اختبار وحدة بمستند حقيقي** — ودائماً معاينة قبل التطبيق.

---

## 9. إضافة قالب جديد — الإجراء الفعلي

الهدف المعلن: **بلا تعديل كود.** هذا هو التدفق:

```
1. المصمم ينشئ manifest.json  (أو عبر واجهة الأدمن)
2. يرفع الأصول (زخارف، أنماط، صورة معاينة) → R2
3. التحقق:
      pnpm template:validate ./templates/floral-dream/manifest.json
      ✓ صحة المخطط
      ✓ كل الـ variants موجودة في الـ registry
      ✓ كل نوع مطلوب موجود (hero, footer)
      ✓ نسب التباين تحقق WCAG AA
      ✓ الخطوط ضمن السجل المسموح
      ✓ الأصول موجودة فعلاً
4. لقطات بصرية آلية على 3 أحجام × لغتين → مراجعة بشرية
5. رفع كـ template_version (status=draft) في قاعدة البيانات
6. مراجعة على staging ببيانات حقيقية
7. نشر
```

**زمن الإضافة المستهدف: < ساعتين.**

⚠️ **متى نحتاج كوداً فعلاً؟** إن أراد المصمم تخطيطاً بصرياً لا يوجد له variant.
حينها: نضيف variant واحداً للـ registry (~150 سطراً) ويصبح متاحاً **لكل القوالب**.
هذا هو التوازن المقصود — لا نعِد باستحالة، بل بأن يكون الكود إضافةً لقدرة عامة لا نسخةً لقالب.

---

## 10. الأمان في محرك القوالب

سطح هجوم حقيقي: بيانات JSON تتحول إلى HTML.

| الخطر | الضابط |
|-------|--------|
| XSS عبر محتوى المستخدم | لا `dangerouslySetInnerHTML` **إطلاقاً** في مكوّنات الأقسام (قاعدة ESLint تمنعه). React يهرّب افتراضياً. |
| XSS عبر قيم الثيم | كل لون يُتحقق بـ regex hex/rgb صارم قبل الحقن في CSS. لا قيم حرة في `<style>`. |
| حقن CSS (`}` للهروب من القاعدة) | القيم تمرّ عبر allowlist من الأنماط، لا سلاسل حرة. |
| Manifest خبيث (Phase 3 marketplace) | تحقق Zod صارم + مراجعة بشرية + لا كود قابل للتنفيذ داخل الـ manifest إطلاقاً |
| مراجع أصول خارجية | `assets` تشير إلى مفاتيح R2 داخلية فقط، لا روابط خارجية |
| DoS عبر مستند ضخم | حدود: ≤ 30 قسماً، حجم المستند ≤ 256KB، ≤ 40 صورة معرض |
| `mapsUrl` خبيث | allowlist للنطاقات: `google.com/maps`, `maps.app.goo.gl`, `goo.gl/maps`, `maps.apple.com` |

**قاعدة قاطعة:** الـ Manifest **بيانات، لا كود**. لا `eval`، لا تعبيرات، لا JS مضمّن. أبداً.

---

## 11. اعتبارات الأداء

| القرار | الأثر |
|--------|-------|
| الأقسام Server Components افتراضياً | لا JS للـ hero والمعرض والتذييل |
| Client فقط: countdown, rsvp, gallery-lightbox, music | JS يُقاس بالكيلوبايتات لا المئات |
| الثيم عبر CSS variables | صفر JS للأسلوب |
| Code splitting حسب الـ variant | تُحمَّل الأقسام المستخدمة فقط |
| تحميل الخطوط حسب الحاجة | خط العرض للأسماء فقط؛ subset عربي أساسي (~90KB) |
| الصور: AVIF/WebP + srcset + blurhash | لا CLS، وزن أقل |
| `loading="eager"` للـ hero فقط، `lazy` للباقي | LCP أسرع |
| الحركات: CSS + IntersectionObserver | لا مكتبة animation على الصفحة العامة |

**ميزانية:** أي variant يضيف > 15KB JS (gzip) يحتاج مبرراً موثّقاً في مراجعة الكود.

---

## 12. الاختبار

| النوع | ما يُختبَر |
|-------|-----------|
| Schema | كل manifest في المستودع يمرّ التحقق |
| Registry | كل variant مُشار إليه في أي manifest موجود فعلاً |
| Determinism | نفس المستند ⇒ نفس HTML (100 تكرار) |
| Visual regression | لقطة لكل (قالب × variant × حجم × لغة) — Playwright |
| Migration | كل دالة ترحيل على مستندات حقيقية محفوظة |
| A11y | axe-core على كل قالب: تباين، ترتيب العناوين، معالم الصفحة |
| Performance | Lighthouse لكل قالب — كلها ضمن الميزانية |
| RTL/LTR | كل قالب يُعرض بلغتين ويُقارن بصرياً |

---

## 13. مسار Phase 3 — Marketplace

البنية أعلاه تجعل السوق ممكناً بلا إعادة تصميم:

```
مصمم خارجي → يرفع manifest + أصول
            → تحقق آلي (schema + a11y + أداء + أمان)
            → مراجعة بشرية + لقطات
            → نشر بحصة إيراد
```

الشرط الذي حماه التصميم: **الـ manifest بيانات لا كود** — لذلك لا يمكن لمصمم خارجي
تنفيذ شيء على خوادمنا أو في متصفحات ضيوفنا. لو سمحنا بـ React مخصص، لكان السوق مستحيلاً أمنياً.

📄 [ADR-0004](adr/0004-json-template-manifest.md)
