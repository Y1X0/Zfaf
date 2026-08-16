# ADR-0014 — Entitlement Service بدل فحص الباقة المباشر

**الحالة:** Proposed · **التاريخ:** 2026-08-16

## السياق

النظام يحتاج التحكم في الميزات حسب الباقة: عدد الدعوات، عدد الصور، القوالب المتاحة،
الرابط المخصص، إدارة الضيوف، مستوى التحليلات، رفع الموسيقى...

الطريقة البديهية:
```typescript
if (user.plan === 'premium' || user.plan === 'planner') {
  allowCustomSlug();
}
```

**ما يحدث بعد ستة أشهر حتماً:**
- هذا السطر مكرر في 40 موضعاً في الكود.
- إضافة باقة جديدة = تعديل 40 موضعاً.
- **ستنسى واحداً** — وسيحصل عميل على ميزة مجاناً، أو (أسوأ) يُحرَم منها بعد أن دفع.
- تجربة سعرية (A/B) على الباقات = مستحيلة عملياً.
- منح استثناء لعميل واحد = اختراق قبيح في الكود.
- الحدود مبعثرة كأرقام سحرية في كل مكان.

## القرار

**خدمة واحدة تجيب على سؤال واحد، والحدود بيانات لا كود.**

```typescript
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

الاستخدام في كل مكان:
```typescript
const ent = await entitlements.for(actor.userId);
if (!ent.can('invitation.custom_slug'))            return err('PLAN_LIMIT_EXCEEDED');
if (await ent.remaining('invitation.active') <= 0)  return err('PLAN_LIMIT_EXCEEDED');
```

### الحدود كبيانات

```json
// plans.limits (JSONB)
{
  "maxActiveInvitations": 3,
  "maxGalleryImages": 25,
  "maxMediaStorageMb": 500,
  "customMusicUpload": false,
  "removeBranding": true,
  "customSlug": false,
  "guestManagement": false,
  "analyticsLevel": "basic",
  "activeDaysAfterEvent": 90
}
```

### التجاوزات

```sql
entitlement_overrides (user_id, key, value, reason, expires_at, granted_by)
```

لدعم: عملاء تجريبيين، تعويض عن مشكلة، شراكات، عروض خاصة —
**بلا تعديل باقة ولا نشر كود ولا حيلة في قاعدة البيانات.**

### ترتيب الحلّ

```
1. التجاوزات النشطة للمستخدم   (الأولوية العليا)
2. حدود الباقة من الاشتراك النشط
3. حدود الباقة المجانية          (احتياطي دائم)
```

## البدائل المرفوضة

| البديل | لماذا |
|--------|-------|
| `if (plan === 'x')` مباشرة | التفكك الحتمي الموصوف أعلاه |
| أعلام ميزات فقط | أعلام الميزات للإطلاق التدريجي لا للتسعير — خلطهما يربك الاثنين |
| RBAC للميزات | الأدوار للصلاحيات (من يفعل ماذا)، الاستحقاقات للتسعير (ما الذي اشتراه). خلطهما خطأ شائع ومكلف |
| مزوّد خارجي (Stigg/Schematic) | تبعية وتكلفة لمشكلة نحلّها في ~أسبوع |

## العواقب

### إيجابية

| الفائدة | التفصيل |
|---------|---------|
| باقة جديدة | **صف في جدول** — صفر تغييرات كود |
| تعديل حد | تحديث JSON — **بلا نشر** |
| استثناء لعميل | صف في `entitlement_overrides` |
| تجربة أسعار (A/B) | ممكنة فعلياً |
| نقطة تنفيذ واحدة | تُراجَع وتُختبَر كاملة |
| اختبار | حقن استحقاقات وهمية — بلا إعداد اشتراكات |

### 🔑 الفائدة الحاسمة لجدولنا الزمني

**تُبنى في Phase 1 رغم أن الدفع في Phase 2.**

في Phase 1: كل المستخدمين على باقة `free_beta` بحدود سخية.
الميزات **مقفلة بشكل صحيح بالفعل** عبر الاستحقاقات.

في Phase 2 عند تفعيل الدفع: التغيير الوحيد هو **من أين تأتي الباقة**
(من الاشتراك بدل الافتراضي). **صفر إعادة كتابة.**

هذا هو ما يجعل تأجيل الدفع قراراً بلا دَين تقني — وهو أساس التوصية في القرار #4.

### سلبية
- تجريد إضافي (~أسبوع عمل).
- بحث إضافي لحساب الاستحقاقات → **مخفَّف بتخزين مؤقت 60 ثانية في Redis، يُبطَل عند تغيير الاشتراك**.
- يجب توثيق قائمة الميزات والحدود بدقة (وهي وثيقة مفيدة أصلاً للتسويق).

## قاعدة صارمة

> ❌ **ممنوع في كل قاعدة الكود:** `plan === 'premium'` أو ما يماثله.
> كل الفحوص تمرّ عبر `EntitlementService`.
>
> **مفروضة بقاعدة ESLint مخصصة تفشل CI.**

## الأمان

- الاستحقاقات تُقيَّم **server-side دائماً**.
- `/api/v1/me/entitlements` موجود **لتلوين الواجهة فقط** (إظهار/إخفاء أزرار).
- **كل عملية تُنفَّذ يُعاد التحقق منها على الخادم** — عميل مُعدَّل لا يكسب صلاحية.
