# 13 — Testing Strategy

**الإصدار:** v0.1 · **الحالة:** Draft

---

## 1. الفلسفة

> «اختبار حقيقي وليس مجرد Unit Tests» — هذا ما طُلب، وهذا ما نبنيه.

الهرم التقليدي (كثير Unit، قليل E2E) يفشل في منتج كهذا، لأن معظم أخطائنا الحقيقية ستكون
في **التكامل** و**سلوك المتصفح الحقيقي** لا في المنطق الخالص:
- هل الدعوة تُعرض صحيحة على iOS Safari داخل WhatsApp؟
- هل الموسيقى تعمل؟
- هل التفويض يمنع المستخدم الآخر فعلاً؟
- هل العد التنازلي صحيح عبر مناطق زمنية؟

**التوزيع المستهدف:**

```
          ╱╲          E2E ~15%          ← تدفقات المستخدم الحقيقية
         ╱  ╲                             (Playwright، متصفحات حقيقية)
        ╱────╲       Integration ~35%   ← API + Postgres حقيقي
       ╱      ╲                           (Testcontainers، بلا mocks)
      ╱────────╲     Unit ~50%          ← منطق النطاق الخالص
     ╱__________╲                         (Vitest، سريع جداً)

   +  اختبارات متعامدة: أمان · بصرية · أداء · وصولية
```

**قاعدة حاكمة:** لا نطارد نسبة تغطية. نطارد **تغطية المخاطر**.
100% تغطية على منطق تافه أسوأ من 60% تغطية تشمل كل مسار تفويض ومعاملة مالية.

---

## 2. اختبارات الوحدة (Vitest)

### ما يُختبَر

- **منطق النطاق الخالص:** `Slug`, `PartySize`, `InvitationStatus` (آلة الحالة), `ThemeResolver`
- **قواعد الأعمال:** فحص الاكتمال، حساب الاستحقاقات، منطق انتهاء الصلاحية
- **حسابات التاريخ/الوقت:** العد التنازلي عبر المناطق الزمنية والتوقيت الصيفي ← **أعلى قيمة اختبارية**
- **Template Engine:** تحقق الـ manifest، حلّ الثيم، دوال الترحيل
- **دوال خالصة:** التطبيع، النقحرة، الـ hashing، التنسيق

```typescript
describe('Slug', () => {
  it('ينقحر الأسماء العربية', () => {
    expect(Slug.fromNames({ groomName:'أحمد', brideName:'سارة' }).value)
      .toBe('ahmad-sarah');
  });
  it('يرفض الكلمات المحجوزة', () => {
    expect(Slug.parse('admin').ok).toBe(false);
  });
  it('يرفض الشرطات المتتالية والطرفية', () => {
    expect(Slug.parse('a--b').ok).toBe(false);
    expect(Slug.parse('-ab').ok).toBe(false);
  });
});

describe('العد التنازلي عبر المناطق الزمنية', () => {
  it('صحيح عبر تغيّر التوقيت الصيفي', () => {
    // حفل في القاهرة بعد بدء التوقيت الصيفي، ضيف في لندن
    const target = resolveEventInstant('2026-05-15', '20:00', 'Africa/Cairo');
    const now    = new Date('2026-04-01T12:00:00Z');
    expect(countdownParts(target, now)).toEqual({ days:44, hours:5, minutes:0, seconds:0 });
  });
});
```

**قواعد:** لا mocks لمنطق النطاق (خالص أصلاً) · ساعة ومولّد معرّفات محقونان → حتمية كاملة
· الاختبار يسمّي السلوك لا الدالة.

---

## 3. اختبارات التكامل (Vitest + Testcontainers)

### لماذا Postgres حقيقي لا mocks

قاعدة بيانات وهمية لا تكشف:
- انتهاكات القيود الفريدة (وهي أساس ضمان الـ slug!)
- سلوك المفاتيح الأجنبية والحذف المتسلسل
- عزل المعاملات وحالات السباق
- الفهارس الجزئية
- سلوك JSONB الفعلي

كلها أماكن أخطاء حقيقية في تصميمنا. mock لن يكشف أياً منها.

```typescript
const pg = await new PostgreSqlContainer('postgres:16-alpine').start();
await runMigrations(pg.getConnectionUri());
```

### ما يُختبَر

| المجال | السيناريوهات |
|--------|--------------|
| المستودعات | CRUD، النطاق، الترقيم، الفهارس الجزئية |
| المعاملات | ذرية النشر، ذرية RSVP + العدّادات |
| **التزامن** | نشران متزامنان بنفس الـ slug → واحد ينجح فقط |
| Autosave | كشف التعارض، تطبيق الـ patch، ترقيم النسخ |
| نقاط الـ API | كل نقطة: نجاح، فشل تحقق، فشل تفويض |
| Webhooks | التوقيع، idempotency، المعالجة |
| المهام | كل عامل، مع إعادة المحاولة |
| Migrations | من صفر، ومن آخر إصدار production |

```typescript
it('نشران متزامنان بنفس الـ slug ⇒ واحد فقط ينجح', async () => {
  const [r1, r2] = await Promise.all([
    publishInvitation({ actor: userA, invitationId: invA, slug: 'ahmad-sarah', ... }, deps),
    publishInvitation({ actor: userB, invitationId: invB, slug: 'ahmad-sarah', ... }, deps),
  ]);
  const oks = [r1, r2].filter(r => r.ok);
  expect(oks).toHaveLength(1);
  const failed = [r1, r2].find(r => !r.ok);
  expect(failed.error.code).toBe('SLUG_TAKEN');
});
```

---

## 4. اختبارات E2E (Playwright)

### مصفوفة المتصفحات

| المتصفح | الجهاز | الأولوية | السبب |
|---------|--------|:--------:|-------|
| **WebKit** | iPhone 14 (390×844) | 🔴 P0 | **معظم الضيوف على iOS Safari** |
| Chromium | Pixel 7 (412×915) | 🔴 P0 | معظم مستخدمي Android |
| Chromium | سطح مكتب 1280×800 | 🟠 P1 | Dashboard/Builder |
| WebKit | iPad (768×1024) | 🟡 P2 | |
| Firefox | سطح مكتب | 🟡 P2 | |

> **WebKit ليس اختيارياً.** هو سبب رفض Cypress. سلوك الصوت، `100vh`، و`position: sticky`
> تختلف فعلياً على Safari، وهذه بالضبط الأشياء التي تكسر دعوتنا.

### متطلبات البنية التحتية — مهم جداً

**E2E يتطلب Redis و PostgreSQL.**

بدون هذين الخدمتين، حوالي **380 من أصل 439 اختبار لا تعمل** — وليس لأنها تفشل، بل لأنها لا تُنفَّذ على الإطلاق. الاختبارات التي تنجح (~55) هي فقط تلك التي لا تحتاج إلى بيانات أو جلسات:
- صفحات المسوّقة (pricing, FAQ, terms)
- اختبارات التوجيه والتدويل المحدودة
- بعض اختبارات الوصولية

**ما الذي لا يُختبَّر بدون البنية التحتية:**

- **كل الاعتماد والتفويض** — idor-matrix.spec.ts (195 اختبار) لا يعمل بدون قاعدة بيانات
- **التدفق الذهبي** — golden-path.spec.ts لا يمكنه إنشاء حسابات أو دعوات
- **كل إجراءات المسؤول والتحليلات والـ RSVP** — تحتاج جميعاً إلى قاعدة بيانات

**قراءة النتائج:**

عند رؤية تقرير "55 اختبار نجح في 4.5 دقيقة"، هذا **لا يعني** اختبار شامل. تحقق من:
```
pnpm --filter @zfaf/web e2e --project=mobile-390
# يجب أن ترى: "X passed, Y did not run" (0 if infrastructure is OK)
# إذا رأيت "226 did not run"، فإن البنية التحتية غير متوفرة
```

الإصلاح: قبل عملية دمج، يجب أن تعمل جميع 439 اختبار بدون "did not run".

---

### التدفق الذهبي — الاختبار الأهم في المشروع

```typescript
test('التدفق الكامل: تسجيل → إنشاء → نشر → عرض → RSVP → لوحة', async ({ page, context }) => {
  // ① التسجيل
  await page.goto('/ar/register');
  await page.fill('[name=email]', uniqueEmail());
  await page.fill('[name=password]', 'a-strong-passphrase');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/dashboard/);

  // ② إنشاء دعوة
  await page.click('text=إنشاء دعوة');
  await page.click('[data-template="classic-luxury"]');

  // ③ ملء البيانات
  await page.fill('[name=groomName]', 'أحمد');
  await page.fill('[name=brideName]', 'سارة');
  await page.fill('[name=eventDate]', '2026-09-20');
  await page.fill('[name=eventTime]', '20:00');

  // ④ التحقق من الحفظ التلقائي
  await expect(page.getByTestId('save-status')).toHaveText(/تم الحفظ/, { timeout: 5000 });

  // ⑤ رفع صورة
  await page.setInputFiles('[data-testid=cover-upload]', 'fixtures/photo-with-gps.jpg');
  await expect(page.getByTestId('media-status')).toHaveText(/جاهز/, { timeout: 30000 });

  // ⑥ المعاينة تعرض البيانات
  const preview = page.frameLocator('[data-testid=preview-frame]');
  await expect(preview.getByText('أحمد')).toBeVisible();

  // ⑦ النشر
  await page.click('text=نشر');
  await page.fill('[name=slug]', `test-${Date.now()}`);
  await page.click('text=تأكيد النشر');
  const url = await page.getByTestId('public-url').innerText();

  // ⑧ فتح الدعوة العامة في سياق متصفح جديد (كضيف)
  const guest = await context.browser().newContext({ ...devices['iPhone 14'] });
  const gp = await guest.newPage();
  await gp.goto(url);
  await expect(gp.getByText('أحمد')).toBeVisible();
  await expect(gp.getByTestId('countdown')).toBeVisible();

  // ⑨ إرسال RSVP
  await gp.click('text=سأحضر');
  await gp.fill('[name=name]', 'خالد');
  await gp.fill('[name=partySize]', '3');
  await gp.click('button[type=submit]');
  await expect(gp.getByText(/شكراً/)).toBeVisible();

  // ⑩ الرد يظهر في لوحة صاحب الدعوة
  await page.goto('/ar/dashboard');
  await page.click('text=الردود');
  await expect(page.getByText('خالد')).toBeVisible();
  await expect(page.getByTestId('total-guests')).toHaveText('3');
});
```

### تدفقات E2E إضافية

| # | التدفق |
|---|--------|
| 2 | التعديل بعد النشر → العام لا يتغير حتى إعادة النشر |
| 3 | إعادة الترتيب والتعطيل → ينعكس على الصفحة العامة |
| 4 | تخصيص الثيم → الألوان تنطبق |
| 5 | التبديل عربي/إنجليزي في كل الشاشات |
| 6 | تشغيل الموسيقى بعد تفاعل المستخدم |
| 7 | معرض الصور: تحميل كسول + عرض مكبّر |
| 8 | مشاركة WhatsApp: الرابط والنص صحيحان |
| 9 | تصدير CSV: التحميل والمحتوى العربي |
| 10 | استعادة كلمة المرور من طرف لطرف |
| 11 | إيقاف دعوة من الإدارة → 451 للزوار |
| 12 | استعادة المسودة بعد إغلاق التبويب |
| 13 | حدود الباقة تُفرَض عند النشر |
| 14 | حذف الحساب → الدعوات تتوقف |

---

## 5. اختبارات الأمان

### مصفوفة IDOR — مولّدة آلياً

```typescript
const RESOURCE_ENDPOINTS = discoverEndpointsWithResourceId();  // من مخططات المسارات

describe.each(RESOURCE_ENDPOINTS)('عزل المستأجرين: %s', (ep) => {
  it('يرجع 404 لمورد مستخدم آخر', async () => {
    const owner    = await seedUserWithInvitation();
    const attacker = await seedUser();
    const res = await request(app)[ep.method](ep.path.replace(':id', owner.invitationId))
      .set('Cookie', attacker.sessionCookie).send(ep.sampleBody);
    expect(res.status).toBe(404);        // ⚠️ 404 لا 403 — 403 يكشف الوجود
  });

  it('يرجع 401 بلا جلسة', async () => { ... });
});
```

**القيمة:** أي نقطة نهاية جديدة تدخل المصفوفة تلقائياً. **لا يمكن نسيان اختبارها.**

### مصفوفة التفويض

```typescript
const CASES = [
  { role:'viewer',  action:'invitation:update',  expect:'deny' },
  { role:'editor',  action:'invitation:update',  expect:'allow' },
  { role:'editor',  action:'invitation:delete',  expect:'deny' },
  { role:'owner',   action:'invitation:delete',  expect:'allow' },
  { role:'support', action:'rsvp:read',          expect:'deny' },   // ← خصوصية الضيوف
  { role:'admin',   action:'invitation:suspend', expect:'allow' },
  { role:'admin',   action:'plan:update',        expect:'deny' },
  // ... المصفوفة الكاملة من 09-auth-and-rbac.md
];
```

### نواقل XSS

```typescript
const XSS_PAYLOADS = [
  `<script>alert(1)</script>`,
  `"><img src=x onerror=alert(1)>`,
  `javascript:alert(1)`,
  `<svg/onload=alert(1)>`,
  `{{constructor.constructor('alert(1)')()}}`,
  `<iframe src="javascript:alert(1)">`,
  `<script>alert(1)</script>`,
];

test.each(XSS_PAYLOADS)('حمولة XSS لا تُنفَّذ: %s', async (payload) => {
  const inv = await createPublishedInvitation({ groomName: payload });
  let executed = false;
  page.on('dialog', () => { executed = true; });
  await page.goto(`/i/${inv.slug}`);
  await page.waitForTimeout(1500);
  expect(executed).toBe(false);
  await expect(page.getByText(payload)).toBeVisible();   // يظهر كنص لا ككود
});
```

### اختبارات أمان أخرى

| الاختبار | التأكيد |
|----------|---------|
| رفع SVG | مرفوض |
| رفع PHP باسم `.jpg` | مرفوض (magic bytes) |
| **تجريد EXIF** | صورة بإحداثيات GPS → لا GPS في المخرج |
| تلاعب بمسار JSON Patch | `/status`, `/ownerId` مرفوضة |
| حد المعدل | الطلب رقم N+1 → 429 |
| تلوث النموذج الأولي | `__proto__` في الجسم مرفوض |
| CSV injection | `=cmd|...` يُسبَق بـ `'` |
| توقيع webhook | توقيع فاسد → 401، لا تغيير حالة |
| تلاعب بالسعر | إرسال `amount` مخصص → متجاهَل |
| اجتياز المسار في الرفع | `../../etc/passwd` → مرفوض |
| تعداد الحسابات | زمن الرد لبريد موجود ≈ غير موجود (±50ms) |

---

## 6. الاختبار البصري

القوالب **منتج بصري** — الانحدار البصري عيب حقيقي لا تجميلي.

```typescript
const MATRIX = cartesian(
  ['classic-luxury','royal-gold','minimal-white'],
  ['iphone-14','ipad','desktop'],
  ['ar','en'],
);
test.each(MATRIX)('لقطة: %s / %s / %s', async (tpl, device, locale) => {
  await page.goto(`/preview/fixture-${tpl}?locale=${locale}`);
  await page.waitForLoadState('networkidle');
  await page.addStyleTag({ content: `*,*::before,*::after{
    animation:none!important;transition:none!important}` });   // إزالة اللاحتمية
  await expect(page).toHaveScreenshot(`${tpl}-${device}-${locale}.png`, {
    maxDiffPixelRatio: 0.01, fullPage: true,
  });
});
```

**18 لقطة** (3 قوالب × 3 أجهزة × لغتان) تُقارن في كل PR.
الاختلاف يتطلب مراجعة بشرية وتحديثاً صريحاً للقطة المرجعية.

---

## 7. اختبارات الأداء

```yaml
# lighthouserc.yml
assert:
  assertions:
    'categories:performance':    ['error', { minScore: 0.92 }]
    'categories:accessibility':  ['error', { minScore: 0.95 }]
    'largest-contentful-paint':  ['error', { maxNumericValue: 2500 }]
    'cumulative-layout-shift':   ['error', { maxNumericValue: 0.05 }]
    'total-byte-weight':         ['error', { maxNumericValue: 500000 }]
    'unused-javascript':         ['warn',  { maxNumericValue: 40000 }]
```

- يعمل على: `/`, `/i/{fixture}`, `/dashboard`, `/builder/{fixture}` — بمحاكاة جوال + 4G بطيء.
- ميزانيات الحزم مفروضة بـ `size-limit`.
- k6 لاختبار الحمل قبل الإطلاق: 1000 مستخدم متزامن على الصفحة العامة، و100 إرسال RSVP/ثانية.

---

## 8. اختبارات الوصولية

```typescript
test('لا انتهاكات a11y حرجة', async ({ page }) => {
  await page.goto('/i/fixture-classic');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa']).analyze();
  expect(results.violations.filter(v => ['critical','serious'].includes(v.impact))).toEqual([]);
});
```
يعمل على كل قالب وكل شاشة رئيسية، بلغتين.

---

## 9. البيانات التجريبية (Fixtures)

```
tests/fixtures/
  users/          {customer, planner, admin, suspended}.ts
  invitations/    {minimal, complete, arabic, english, published, expired}.ts
  media/          photo-with-gps.jpg     ← لاختبار تجريد EXIF
                  malicious.svg          ← يجب أن يُرفض
                  fake-jpeg.php          ← يجب أن يُرفض
                  huge-dimensions.png    ← قنبلة ضغط
                  valid-heic.heic        ← افتراضي iPhone
  templates/      كل الـ manifests
  webhooks/       حمولات موقّعة حقيقية من بيئة الاختبار
```

**قواعد:** بيانات تجريبية حتمية (ساعة ثابتة، معرّفات ثابتة) · **ممنوع استخدام بيانات إنتاج حقيقية**
· قاعدة نظيفة لكل ملف اختبار.

---

## 10. الاختبار اليدوي — ما لا يمكن أتمتته

قائمة تحقق قبل كل إطلاق، على **أجهزة حقيقية لا محاكيات**:

```
□ فتح دعوة من رابط WhatsApp على iPhone حقيقي
□ فتح دعوة من رابط WhatsApp على Android حقيقي
□ تشغيل الموسيقى داخل متصفح WhatsApp الداخلي (iOS)
□ تشغيل الموسيقى داخل متصفح WhatsApp الداخلي (Android)
□ معاينة الرابط (OG) تظهر في WhatsApp
□ معاينة الرابط تظهر في Telegram و iMessage
□ زر «افتح الموقع» يفتح تطبيق الخرائط الأصلي
□ مشاركة WhatsApp تنتج الرسالة الصحيحة
□ الدعوة على شبكة 3G بطيئة فعلاً
□ الدعوة على iPhone SE (شاشة صغيرة)
□ الدعوة في الوضع الليلي
□ الدعوة عند تكبير خط النظام إلى 200%
□ التمرير سلس على جهاز Android متوسط الأداء
□ البطارية/الحرارة: الحركات لا تسخّن الجهاز
```

> ⚠️ **متصفح WhatsApp الداخلي هو أكثر بيئة تكسر التوقعات**، ولا يمكن محاكاته بدقة.
> اختباره يدوياً غير قابل للتفاوض.

---

## 11. بوابات CI

| الفحص | متى | إلزامي |
|-------|-----|:------:|
| Lint + Format | كل PR | ✅ |
| Typecheck | كل PR | ✅ |
| حدود الوحدات (dependency-cruiser) | كل PR | ✅ |
| اختبارات الوحدة | كل PR | ✅ |
| اختبارات التكامل | كل PR | ✅ |
| مصفوفة الأمان | كل PR | ✅ |
| E2E (Chromium + WebKit) | كل PR | ✅ |
| E2E (المصفوفة الكاملة) | يومياً + قبل الإصدار | ⚠️ |
| اللقطات البصرية | كل PR | ✅ |
| Lighthouse CI | كل PR | ✅ |
| Axe a11y | كل PR | ✅ |
| gitleaks | كل PR | ✅ |
| npm audit / Trivy | كل PR + يومياً | ✅ Critical/High |
| CodeQL | كل PR | ⚠️ |
| اختبار الـ migrations | كل PR | ✅ |
| اختبار الحمل | قبل الإصدار | ⚠️ |

**الوقت المستهدف للفحوص الإلزامية: < 12 دقيقة** (بالتوازي).
أطول من ذلك ⇒ يتجنّبه الفريق ⇒ يفقد قيمته.

---

## 12. مؤشرات الجودة

| المؤشر | الهدف |
|--------|-------|
| تغطية منطق النطاق | ≥ 85% |
| تغطية مسارات التفويض | **100%** — بلا استثناء |
| تغطية نقاط الـ API | ≥ 90% |
| نسبة الاختبارات المتقلبة (flaky) | < 1% |
| زمن CI (p95) | < 12 دقيقة |
| أخطاء إنتاج تكشفها الاختبارات لاحقاً | يُتتبَّع — كل خطأ إنتاج يضيف اختباراً |

**قاعدة:** **كل خطأ إنتاج يُصلَح باختبار يفشل أولاً.** بلا استثناء.
هذا ما يمنع تكرار نفس الخطأ ويحوّل الأخطاء إلى تحسين دائم في شبكة الأمان.
