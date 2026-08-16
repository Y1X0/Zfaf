# ADR-0013 — مساحة الروابط تحت `/i/` مع نظام Slug محمي

**الحالة:** ✅ Accepted · **اقتُرح:** 2026-08-16 · **اعتُمد:** 2026-08-16 · **القرار المرتبط:** #5

## السياق

كل دعوة تحتاج رابطاً جميلاً وقصيراً يُشارَك على WhatsApp.
المتطلب ذكر شكلين: `domain.com/i/ahmad-sarah` أو `domain.com/invitation/ahmad-sarah`.

القيود:
- الرابط سيُرسَل لـ 250+ شخصاً — **تغييره لاحقاً مكلف جداً**.
- الأسماء عربية، والرابط يجب أن يكون آمناً في URL.
- المستخدمون سيحاولون أخذ `admin`, `login`, `pricing`.
- احتمال الإساءة والانتحال قائم.

## القرار

### 1. المساحة: `zfaf.app/i/{slug}`

| الخيار | المخاطرة |
|--------|----------|
| `zfaf.app/i/ahmad-sarah` ⭐ | لا شيء |
| `zfaf.app/ahmad-sarah` | **تعارض دائم مع صفحات المنصة** |
| `ahmad-sarah.zfaf.app` | تعقيد DNS/SSL، وأطول فعلياً |

**السبب الحاسم لرفض الجذر:** إن وضعنا الدعوات في الجذر، فإضافة صفحة `/pricing` أو `/blog`
مستقبلاً قد تصطدم بدعوة موجودة ومنشورة ومُرسَلة لمئات الأشخاص. الحل الوحيد حينها
قائمة كلمات محجوزة **تنمو أبداً** ولا يمكن تطبيقها بأثر رجعي.

`/i/` يفصل المساحتين نهائياً مقابل **حرفين إضافيين فقط**. صفقة ممتازة.

### 2. شكل الـ Slug

```
^[a-z0-9]([a-z0-9-]{1,46})[a-z0-9]$
```
3–48 حرفاً · حروف صغيرة وأرقام وشرطات · بلا شرطات متتالية أو طرفية.

### 3. التوليد من الأسماء العربية

```
"أحمد" + "سارة"  →  نقحرة  →  "ahmad-sarah"
```
عند التعارض: **لاحقة عشوائية قصيرة** `ahmad-sarah-k3f` وليس `ahmad-sarah-2`.

> **لماذا عشوائية لا متسلسلة؟** `-2` يكشف وجود دعوة أخرى بنفس الاسم،
> ويسمح بتعداد الدعوات بالتخمين المتسلسل. العشوائية تمنع الاثنين.

### 4. الكلمات المحجوزة (جدول `reserved_slugs`)

```
api admin dashboard login register logout settings billing pricing
templates about help support blog docs terms privacy static assets
_next i invitation new edit preview health robots sitemap favicon
www mail ftp cdn app staging test demo null undefined true false
+ قائمة ألفاظ نابية بالعربية والإنجليزية
```

### 5. تاريخ الـ Slug — بند حرج

```sql
slug_history (id, invitation_id, old_slug UNIQUE, changed_at)
```
تغيير الـ slug ⇒ الرابط القديم يصدر **301 دائم** إلى الجديد.

> ⚠️ **بلا هذا، تغيير slug واحد يعطّل 250 رابطاً مُرسلاً بالفعل على WhatsApp.**
> لا يمكن استرجاع تلك الرسائل. هذا ليس تحسيناً — إنه منع كارثة.

### 6. صلاحية التغيير

| الباقة | التغيير |
|--------|---------|
| Free | لا تغيير بعد النشر |
| Basic | تغيير واحد |
| Premium | slug مخصص + تغييرات متعددة |

في كل الحالات: القديم يُحجَز في `slug_history` ولا يُعاد استخدامه أبداً لدعوة أخرى.

## التنفيذ

```typescript
class Slug {
  static parse(input: string): Result<Slug> {
    const normalized = input.trim().toLowerCase()
      .normalize('NFC')
      .replace(/[؀-ۿ]+/g, m => transliterateArabic(m))
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!SLUG_RE.test(normalized))       return err('INVALID_SLUG');
    if (RESERVED.has(normalized))        return err('SLUG_RESERVED');
    if (containsProfanity(normalized))   return err('SLUG_PROFANITY');
    return ok(new Slug(normalized));
  }
}
```

**التفرّد يُفرَض في قاعدة البيانات، لا في التطبيق فقط:**
```sql
CREATE UNIQUE INDEX invitations_slug_key ON invitations (slug)
  WHERE deleted_at IS NULL AND slug IS NOT NULL;
```
الفحص المسبق للواجهة فقط. القيد على مستوى DB هو ما يمنع سباق النشر المتزامن.

## العواقب

### إيجابية
- لا تعارض ممكن بين الدعوات وصفحات المنصة — إلى الأبد.
- الروابط القديمة تظل تعمل دائماً.
- لا تعداد ممكن للدعوات.
- النقحرة تنتج روابط مقروءة من أسماء عربية.

### سلبية
- حرفان إضافيان في الرابط (`/i/`) — ثمن زهيد جداً.
- النقحرة العربية ليست مثالية دائماً (خاصة الأسماء غير الشائعة) →
  **مخفَّف بالسماح للمستخدم بتحرير الاقتراح قبل النشر**.
- `slug_history` ينمو — لكنه صغير جداً ولا يشكل مشكلة.
