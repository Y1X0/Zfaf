# 03 — Database Design & ERD

**الإصدار:** v0.1 · **الحالة:** Draft · **المحرك:** PostgreSQL 16

---

## 1. مبادئ النمذجة

قبل الجداول، القواعد التي اشتُقّت منها:

1. **المعرّفات:** `UUIDv7` كمفتاح رئيسي (`id`).
   لماذا v7 لا v4؟ v7 مرتّب زمنياً → إدخال متتالٍ في فهرس B-tree بلا تشتيت الصفحات،
   وأداء أفضل بكثير من v4 على الجداول الكبيرة. ويحتفظ بميزة عدم قابلية التخمين (بخلاف `serial` الذي يفضح العدّاد).

2. **`created_at` / `updated_at`** من نوع `timestamptz` على كل جدول. **كل الأوقات UTC في التخزين.**
   استثناء واحد ومهم: توقيت الحفل يُخزَّن **كـ wall-clock + IANA timezone** لا كـ UTC وحده (تفصيل في §4.3).

3. **الحذف الناعم (`deleted_at`)** على الكيانات التي يملكها المستخدم فقط
   (Invitations, Media, Guests) لدعم الاسترجاع خلال 30 يوماً. الباقي حذف صلب.

4. **JSONB للمرن، أعمدة للمُستعلَم عنه.**
   لا نضع في JSONB ما نحتاج تصفيته أو ترتيبه أو فرض قيود عليه.

5. **المال:** `integer` بأصغر وحدة (هللة/سنت) + `currency CHAR(3)`. **ممنوع `float` للمال إطلاقاً.**

6. **العزل:** كل جدول يملكه مستخدم يحمل `owner_id` مفهرساً. كل استعلام يمرّ عبر repository
   يفرض النطاق. RLS كخط دفاع ثانٍ (Phase 2).

7. **التسمية:** `snake_case` للجداول والأعمدة، جمع للجداول، `{table}_{cols}_idx` للفهارس.

---

## 2. ERD — نظرة عامة

```
┌──────────────┐
│    users     │───────┐
└──────┬───────┘       │
       │1              │1
       │               │
       │N              │N
┌──────▼────────┐  ┌───▼──────────┐   ┌────────────────┐
│  sessions     │  │subscriptions │──▶│     plans      │
└───────────────┘  └───┬──────────┘   └────────────────┘
                       │1
       ┌───────────────┘
       │N
┌──────▼──────────┐
│    payments     │
└─────────────────┘

┌──────────────┐        ┌─────────────────────┐        ┌──────────────────┐
│    users     │───1:N──▶│    invitations     │◀──N:1──│    templates     │
└──────────────┘        │                     │        └────────┬─────────┘
                        │ • slug (unique)     │                 │1
                        │ • status            │                 │N
                        │ • draft_document JB │        ┌────────▼──────────┐
                        │ • published_ver_id ─┼───┐    │ template_versions │
                        └──┬───┬───┬───┬──────┘   │    │ • manifest JSONB  │
                           │   │   │   │          │    └───────────────────┘
        ┌──────────────────┘   │   │   └──────────┼────────────┐
        │N                     │N  │N             │1           │N
┌───────▼────────┐  ┌──────────▼┐ ┌▼───────────┐ ┌▼───────────────────────┐
│invitation_     │  │  events   │ │   rsvps    │ │  invitation_versions   │
│  members       │  │           │ │            │ │ • version_number       │
│ (owner/editor) │  └───────────┘ └────────────┘ │ • published_document JB│
└────────────────┘                               │ • IMMUTABLE            │
                                                 └────────────────────────┘
        │N                    │N            │N               │N
┌───────▼────────┐  ┌─────────▼─────┐ ┌─────▼────────┐ ┌─────▼──────────┐
│ media_assets   │  │    guests     │ │analytics_    │ │ slug_history   │
│                │  │ (Phase 3)     │ │  events      │ │ (301 redirects)│
└────────────────┘  └───────────────┘ └──────────────┘ └────────────────┘

┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐
│ music_tracks │  │   reports    │  │  audit_logs  │  │ custom_domains │
│  (مرخّصة)    │  │  (بلاغات)   │  │              │  │   (Phase 3)    │
└──────────────┘  └──────────────┘  └──────────────┘  └────────────────┘
```

---

## 3. الجداول بالتفصيل

### 3.1 وحدة الهوية (`identity`)

#### `users`

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `uuid` PK | UUIDv7 |
| `email` | `citext` UNIQUE NOT NULL | `citext` → مقارنة غير حساسة لحالة الأحرف بلا حيل |
| `email_verified_at` | `timestamptz` NULL | NULL = غير مفعّل |
| `password_hash` | `text` NULL | NULL للحسابات عبر OAuth فقط |
| `name` | `text` NULL | |
| `avatar_media_id` | `uuid` FK NULL | |
| `locale` | `text` DEFAULT `'ar'` | `ar` \| `en` |
| `role` | `user_role` ENUM | `customer` \| `planner` \| `support` \| `admin` \| `superadmin` |
| `status` | `user_status` ENUM | `active` \| `suspended` \| `pending_deletion` |
| `suspended_reason` | `text` NULL | |
| `deletion_requested_at` | `timestamptz` NULL | يبدأ عدّاد 30 يوماً |
| `last_login_at` | `timestamptz` NULL | |
| `failed_login_count` | `int` DEFAULT 0 | للحجب التدريجي |
| `locked_until` | `timestamptz` NULL | |
| `created_at`, `updated_at` | `timestamptz` | |

**فهارس:** `users_email_key` (UNIQUE) · `users_status_idx` · `users_deletion_requested_at_idx` (جزئي WHERE NOT NULL)

> **قرار:** الدور عمود واحد وليس جدول `roles` منفصل. عدد الأدوار ثابت وصغير،
> والصلاحيات الدقيقة تأتي من طبقة السياسات لا من الجدول. جدول أدوار كامل تعقيد بلا عائد الآن.

#### `sessions`

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → users ON DELETE CASCADE | |
| `token_hash` | `bytea` UNIQUE NOT NULL | **SHA-256 للرمز، لا الرمز نفسه** — تسريب DB لا يعطي جلسات |
| `expires_at` | `timestamptz` NOT NULL | |
| `ip_hash` | `bytea` NULL | مُملَّح، لكشف الاختطاف فقط |
| `user_agent` | `text` NULL | معروض للمستخدم في «أجهزتي» |
| `revoked_at` | `timestamptz` NULL | |
| `created_at`, `last_used_at` | `timestamptz` | |

**فهارس:** `sessions_token_hash_key` (UNIQUE) · `sessions_user_id_idx` · `sessions_expires_at_idx`

#### `oauth_accounts`, `email_verifications`, `password_resets`

بنية قياسية. المشترك بينها: تُخزَّن **hash الرمز** لا الرمز، مع `expires_at` و `used_at`
لضمان الاستخدام مرة واحدة.

---

### 3.2 وحدة القوالب (`template`)

#### `templates`

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `uuid` PK | |
| `key` | `text` UNIQUE NOT NULL | `classic-luxury` — ثابت، يُستخدم في الكود والـ assets |
| `name_i18n` | `jsonb` NOT NULL | `{"ar":"الفخامة الكلاسيكية","en":"Classic Luxury"}` |
| `description_i18n` | `jsonb` | |
| `preview_image_url` | `text` | |
| `category` | `text` | `classic` \| `modern` \| `floral` \| `traditional` |
| `required_plan_level` | `int` DEFAULT 0 | 0=free, 1=basic, 2=premium |
| `status` | `template_status` ENUM | `draft` \| `published` \| `deprecated` |
| `sort_order` | `int` | |
| `current_version_id` | `uuid` FK NULL | النسخة المعروضة للمستخدمين الجدد |
| `created_at`, `updated_at` | | |

#### `template_versions`

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `uuid` PK | |
| `template_id` | `uuid` FK | |
| `version` | `int` NOT NULL | يبدأ من 1 |
| `manifest` | `jsonb` NOT NULL | **قلب محرك القوالب** — انظر [05](05-template-engine.md) |
| `manifest_checksum` | `text` NOT NULL | لكشف التعديل غير المقصود |
| `changelog` | `text` | |
| `published_at` | `timestamptz` NULL | |
| `created_at` | | |

**قيد:** `UNIQUE (template_id, version)`
**قاعدة:** النسخة المنشورة **immutable**. أي تعديل = نسخة جديدة.

---

### 3.3 وحدة الدعوة (`invitation`) — القلب

#### `invitations`

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `uuid` PK | |
| `owner_id` | `uuid` FK → users | مالك الدعوة |
| `slug` | `citext` NULL | فريد بين غير المحذوفة فقط |
| `title` | `text` | تسمية داخلية للوحة التحكم |
| `status` | `invitation_status` ENUM | `DRAFT`\|`PUBLISHED`\|`PAUSED`\|`EXPIRED`\|`SUSPENDED`\|`DELETED` |
| `template_id` | `uuid` FK → templates | |
| `template_version_id` | `uuid` FK → template_versions | نسخة المسوّدة الحالية |
| `draft_document` | `jsonb` NOT NULL | مستند التحرير الحي |
| `draft_updated_at` | `timestamptz` | لكشف تعارض الـ Autosave |
| `published_version_id` | `uuid` FK → invitation_versions NULL | **NULL ⇔ لم تُنشر قط** |
| `locale` | `text` DEFAULT `'ar'` | لغة الدعوة نفسها |
| `event_date` | `date` NOT NULL | تاريخ الحفل الرئيسي (للفرز والانتهاء) |
| `event_time` | `time` NULL | وقت محلي |
| `timezone` | `text` NOT NULL DEFAULT `'Asia/Riyadh'` | IANA — انظر §4.3 |
| `expires_at` | `timestamptz` NULL | يُحسب: تاريخ الحفل + مدة الباقة |
| `rsvp_enabled` | `boolean` DEFAULT true | |
| `rsvp_deadline` | `date` NULL | |
| `max_party_size` | `int` DEFAULT 5 | **يُفرض server-side** |
| `is_indexable` | `boolean` DEFAULT false | **افتراضياً لا تُفهرس — الخصوصية أولاً** |
| `password_hash` | `text` NULL | حماية اختيارية بكلمة مرور (Phase 2) |
| `view_count` | `bigint` DEFAULT 0 | عدّاد مجمّع (denormalized) |
| `rsvp_yes_count`, `rsvp_no_count`, `rsvp_guest_count` | `int` DEFAULT 0 | عدّادات مجمّعة |
| `published_at`, `created_at`, `updated_at`, `deleted_at` | `timestamptz` | |

**فهارس:**
```sql
CREATE UNIQUE INDEX invitations_slug_key ON invitations (slug)
  WHERE deleted_at IS NULL AND slug IS NOT NULL;   -- فريد جزئي: يسمح بإعادة استخدام slug محذوف

CREATE INDEX invitations_owner_status_idx ON invitations (owner_id, status, created_at DESC);
CREATE INDEX invitations_expires_at_idx   ON invitations (expires_at)
  WHERE status = 'PUBLISHED';                       -- لمهمة الانتهاء الدورية
CREATE INDEX invitations_event_date_idx   ON invitations (event_date);
```

> **قرار: لماذا `draft_document` كـ JSONB واحد وليس جداول معيارية للأقسام؟**
> - المسوّدة تُقرأ وتُكتب **كوحدة واحدة دائماً** (الـ Builder يحمّل كل شيء ويحفظ كل شيء).
> - لا نستعلم أبداً «كل الدعوات التي فيها قسم معرض» — ولو احتجنا، فهرس GIN يكفي.
> - Autosave على صف واحد أبسط وأسرع بكثير من 12 عملية UPSERT على جداول أبناء.
> - شكل المستند يتطور مع القوالب — الـ schema المرن هنا مزية لا عيب.
>
> **لكن:** `events` جدول حقيقي منفصل لأننا **نستعلم عنه فعلاً** (التذكيرات، الفرز الزمني، التقويم).
> هذا هو الخط الفاصل: JSONB لما يُقرأ ككتلة، جداول لما يُستعلم عنه.

#### `invitation_versions`

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `uuid` PK | |
| `invitation_id` | `uuid` FK | |
| `version_number` | `int` NOT NULL | |
| `published_document` | `jsonb` NOT NULL | **snapshot كامل ومكتفٍ ذاتياً** |
| `template_version_id` | `uuid` FK | مجمّد |
| `document_checksum` | `text` | |
| `published_by` | `uuid` FK → users | |
| `published_at` | `timestamptz` | |

**قيد:** `UNIQUE (invitation_id, version_number)` · **immutable — لا UPDATE ولا DELETE**
**سياسة الاحتفاظ:** آخر 20 نسخة لكل دعوة؛ الأقدم يُحذف بمهمة دورية.

#### `invitation_members` (تعاون — Phase 3، لكن الجدول من الآن)

`(invitation_id, user_id, role: owner|editor|viewer, invited_by, accepted_at)`
**قيد:** `UNIQUE (invitation_id, user_id)`

> **لماذا الآن؟** إضافة تعدد الأعضاء لاحقاً يعني تعديل **كل** استعلام تفويض في النظام.
> إنشاء الجدول الآن (حتى لو استُخدم بصف واحد لكل دعوة) يجعل طبقة التفويض صحيحة من البداية.
> هذا أرخص 10× من إعادة كتابتها في Phase 3.

#### `slug_history`

`(id, invitation_id, old_slug UNIQUE, changed_at)` → لإصدار 301 من الروابط القديمة.
**حرج:** الرابط أُرسل لـ 300 شخص على WhatsApp. تغيير الـ slug بلا redirect = كارثة.

#### `events`

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `uuid` PK | |
| `invitation_id` | `uuid` FK ON DELETE CASCADE | |
| `type` | `event_type` ENUM | `contract`\|`reception`\|`wedding`\|`dinner`\|`custom` |
| `title_i18n` | `jsonb` | |
| `description_i18n` | `jsonb` NULL | |
| `event_date` | `date` NOT NULL | |
| `start_time`, `end_time` | `time` NULL | |
| `timezone` | `text` | يرث من الدعوة افتراضياً |
| `venue_name` | `text` NULL | |
| `venue_address` | `text` NULL | |
| `latitude`, `longitude` | `decimal(9,6)` / `decimal(10,6)` NULL | |
| `maps_url` | `text` NULL | يُتحقق منه: نطاق مسموح فقط |
| `sort_order` | `int` | |

**فهرس:** `events_invitation_sort_idx (invitation_id, sort_order)`

---

### 3.4 وحدة الوسائط (`media`)

#### `media_assets`

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `uuid` PK | |
| `owner_id` | `uuid` FK → users | **للعزل** |
| `invitation_id` | `uuid` FK NULL | NULL = في مكتبة المستخدم العامة |
| `kind` | `media_kind` ENUM | `image` \| `audio` |
| `purpose` | `text` | `cover`\|`couple`\|`gallery`\|`avatar`\|`og` |
| `storage_key` | `text` UNIQUE NOT NULL | المسار في R2 |
| `original_filename` | `text` | مطهَّر — لا يُستخدم في المسار |
| `mime_type` | `text` NOT NULL | **مُتحقَّق من المحتوى (magic bytes) لا من الترويسة** |
| `size_bytes` | `bigint` NOT NULL | |
| `width`, `height` | `int` NULL | |
| `duration_ms` | `int` NULL | للصوت |
| `blurhash` | `text` NULL | placeholder فوري بلا CLS |
| `variants` | `jsonb` | `{"thumb":{...},"medium":{...},"full":{...}}` |
| `status` | `media_status` ENUM | `pending`\|`processing`\|`ready`\|`failed`\|`quarantined` |
| `scan_status` | `scan_status` ENUM | `pending`\|`clean`\|`infected`\|`skipped` |
| `created_at`, `deleted_at` | | |

**فهارس:** `media_owner_idx (owner_id, created_at DESC)` · `media_invitation_idx (invitation_id)` · `media_status_idx` (جزئي للـ pending)

> **قاعدة:** لا bytes في PostgreSQL. الجدول ميتاداتا فقط. الملف في R2.
> **قاعدة:** لا يُدرَج أي أصل في مستند منشور ما لم يكن `status='ready' AND scan_status IN ('clean','skipped')`.

#### `music_tracks` (مكتبة المنصة المرخّصة)

`(id, title_i18n, artist, storage_key, duration_ms, license_type, license_url, license_proof_url, attribution_required, attribution_text, required_plan_level, mood, status)`

> **حقل `license_proof_url` ليس تجميلياً.** هو دليلنا القانوني عند مطالبة بحقوق.
> ممنوع إضافة مقطع للمكتبة بلا مصدر ترخيص موثّق. انظر [ADR-0012](adr/0012-licensed-music-library.md).

---

### 3.5 وحدة RSVP والضيوف

#### `rsvps`

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `uuid` PK | |
| `invitation_id` | `uuid` FK ON DELETE CASCADE | |
| `guest_id` | `uuid` FK NULL | مرتبط بقائمة الضيوف (Phase 3) |
| `name` | `text` NOT NULL | |
| `attending` | `boolean` NOT NULL | |
| `party_size` | `int` NOT NULL DEFAULT 1 | `CHECK (party_size >= 0 AND party_size <= 50)` |
| `phone` | `text` NULL | اختياري — **لا نطلبه إلا بمبرر** |
| `note` | `text` NULL | `CHECK (length(note) <= 500)` |
| `dedupe_hash` | `bytea` NOT NULL | `sha256(invitation_id ‖ normalized_name ‖ normalized_phone)` |
| `edit_token_hash` | `bytea` NULL | يسمح للضيف بتعديل ردّه |
| `source` | `text` | `public` \| `guest_link` \| `manual` |
| `submitted_at`, `updated_at` | | |

**فهارس:**
```sql
CREATE UNIQUE INDEX rsvps_dedupe_idx ON rsvps (invitation_id, dedupe_hash);
CREATE INDEX rsvps_invitation_idx    ON rsvps (invitation_id, submitted_at DESC);
CREATE INDEX rsvps_attending_idx     ON rsvps (invitation_id, attending);
```

> **الفهرس الفريد على `dedupe_hash` مقصود:** الضيف الذي يضغط «إرسال» مرتين (شبكة بطيئة)
> يُحدَّث ردّه بدل إنشاء ردّ مكرر. هذا سيناريو شائع جداً على الجوال، وتجاهله يفسد الأرقام.

⚠️ **ملاحظة خصوصية:** أسماء وهواتف الضيوف = بيانات شخصية لأطراف ثالثة **لم توافق على شروطنا**.
لذلك: احتفاظ محدود (تُحذف بعد 90 يوماً من الحفل افتراضياً)، لا تُستخدم للتسويق إطلاقاً،
وتُحذف مع الدعوة. انظر [12-security-threat-model.md](12-security-threat-model.md#8-الخصوصية).

#### `guests` (Phase 3)

`(id, invitation_id, name, phone, email, token UNIQUE, allowed_seats, group_label, sent_at, opened_at, rsvp_id, created_at)`
- `token`: 16 حرفاً base32 من CSPRNG (≥80 bit entropy) → غير قابل للتخمين.
- `UNIQUE (invitation_id, phone)` جزئياً لمنع التكرار.

---

### 3.6 وحدة الفوترة (`billing`)

#### `plans`

`(id, key UNIQUE, name_i18n, level int, price_amount int, currency, billing_period, features jsonb, limits jsonb, is_active, sort_order)`

`limits` مثال:
```json
{
  "maxActiveInvitations": 1,
  "maxGalleryImages": 10,
  "maxMediaStorageMb": 100,
  "customMusicUpload": false,
  "removeBranding": false,
  "customSlug": false,
  "guestManagement": false,
  "analyticsLevel": "basic",
  "activeDaysAfterEvent": 14
}
```

> **قرار مهم:** الحدود **بيانات لا كود**. إضافة باقة أو تعديل حد = صف في جدول، لا نشر إصدار.
> ولا يوجد في أي مكان في الكود `if (plan === 'premium')`. انظر [ADR-0014](adr/0014-entitlements-over-plan-checks.md).

#### `subscriptions`

`(id, user_id, plan_id, invitation_id NULL, status, current_period_start/end, cancel_at_period_end, provider, provider_subscription_id, created_at, updated_at)`

- `status`: `trialing`\|`active`\|`past_due`\|`canceled`\|`expired`
- `invitation_id` غير NULL ⇒ شراء لمرة واحدة مرتبط بدعوة (النموذج الشائع عندنا).
- `invitation_id` NULL ⇒ اشتراك على مستوى الحساب (Wedding Planner).

#### `payments`

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `uuid` PK | |
| `user_id`, `subscription_id`, `plan_id` | FK | |
| `provider` | `text` | `stripe`\|`moyasar`\|`tap`\|... |
| `provider_payment_id` | `text` | |
| `idempotency_key` | `text` UNIQUE NOT NULL | **يمنع الخصم المزدوج** |
| `amount`, `currency` | `int`, `char(3)` | بالهللة |
| `status` | ENUM | `pending`\|`succeeded`\|`failed`\|`refunded`\|`partially_refunded` |
| `refunded_amount` | `int` DEFAULT 0 | |
| `failure_code`, `failure_message` | `text` NULL | |
| `raw_event` | `jsonb` | **بعد تنقية الحقول الحساسة** |
| `created_at`, `updated_at` | | |

**قيد:** `UNIQUE (provider, provider_payment_id)` — يمنع المعالجة المزدوجة للـ webhook.

#### `webhook_events`

`(id, provider, provider_event_id UNIQUE, type, payload jsonb, signature_verified bool, processed_at, error, attempts, created_at)`

> **كل webhook يُسجَّل أولاً ثم يُعالَج.** المعالجة idempotent عبر `provider_event_id`.
> هذا يجعل إعادة تشغيل الأحداث بعد عطل آمنة تماماً.

---

### 3.7 التحليلات

#### `analytics_events` (خام، احتفاظ 90 يوماً)

| العمود | النوع | ملاحظات |
|--------|-------|---------|
| `id` | `bigserial` PK | حجم كبير ⇒ bigserial أرخص من uuid |
| `invitation_id` | `uuid` FK | |
| `type` | `text` | `view`\|`rsvp_open`\|`rsvp_submit`\|`share`\|`maps_click`\|`music_play`\|`gallery_open` |
| `visitor_hash` | `bytea` | `sha256(daily_salt ‖ ip ‖ user_agent ‖ invitation_id)` |
| `country` | `char(2)` NULL | من ترويسة CDN — الدولة فقط |
| `device_class` | `text` | `mobile`\|`tablet`\|`desktop` |
| `referrer_class` | `text` | `whatsapp`\|`direct`\|`social`\|`search`\|`other` |
| `occurred_at` | `timestamptz` | |

**فهرس:** `(invitation_id, occurred_at DESC)` · **تقسيم شهري (partitioning)** — الحذف يصبح `DROP PARTITION` فوري.

🔒 **`daily_salt` يُولَّد يومياً في الذاكرة/Redis ولا يُخزَّن أبداً بشكل دائم.**
بعد انقضاء اليوم يصبح `visitor_hash` غير قابل للربط بأي شخص — حتى نحن لا نستطيع.
هذا ليس تجميلاً: هو ما يجعلنا **لا نحتاج cookie banner** ولا نحمل مسؤولية بيانات شخصية للزوار.

#### `analytics_daily` (مجمّع، احتفاظ دائم)

`(invitation_id, date, views, unique_visitors, rsvp_submits, shares, maps_clicks, PRIMARY KEY (invitation_id, date))`
تُحدَّث بمهمة كل ساعة. الـ Dashboard يقرأ من هنا فقط → استعلامات فورية.

---

### 3.8 الإشراف والنظام

- **`reports`** — `(id, invitation_id, reporter_email NULL, reporter_ip_hash, reason ENUM, details, status, resolved_by, resolution_note, created_at)`
  `reason`: `copyright`\|`abuse`\|`spam`\|`impersonation`\|`inappropriate`\|`other`

- **`audit_logs`** — `(id, actor_id NULL, actor_type, action, resource_type, resource_id, metadata jsonb, ip_hash, request_id, created_at)`
  **كل إجراء إداري وكل تغيير حساس يُسجَّل.** لا يُحذف. تقسيم شهري.

- **`settings`** — `(key PK, value jsonb, updated_by, updated_at)` — أعلام ميزات وإعدادات تشغيلية.

- **`custom_domains`** (Phase 3) — `(id, user_id, invitation_id, domain UNIQUE, verification_token, verified_at, ssl_status, created_at)`

- **`reserved_slugs`** — `(slug PK, reason)` — كلمات محجوزة، انظر §4.2.

---

## 4. قرارات نمذجة حرجة

### 4.1 لماذا الـ Snapshot المنشور منفصل عن المسودة؟

| السيناريو | بلا snapshot | مع snapshot |
|-----------|--------------|-------------|
| المستخدم يعدّل بعد النشر | التعديل يظهر فوراً للـ 300 ضيف — حتى لو كان نصف مكتمل | التعديل في المسودة فقط حتى «إعادة النشر» |
| نحدّث قالباً | كل الدعوات المنشورة تتغير — قد تُكسَر | الدعوات مثبّتة على نسختها |
| المستخدم يحذف صورة | الدعوة المنشورة تُظهر رابطاً مكسوراً | الـ snapshot يحمل مرجعاً محمياً (لا يُحذف الأصل ما دام مستخدماً في نسخة منشورة) |
| نحتاج تراجعاً | مستحيل | `published_version_id` يعود لنسخة سابقة — فورياً |
| أداء القراءة | JOINs متعددة + حلّ العلاقات | **قراءة صف واحد** |

📄 [ADR-0005](adr/0005-published-snapshot-versioning.md)

### 4.2 نظام الـ Slug

**الشكل:** `^[a-z0-9]([a-z0-9-]{1,46})[a-z0-9]$` — 3 إلى 48 حرفاً، بلا شرطات متتالية أو طرفية.

**التوليد من أسماء عربية:** «أحمد وسارة» → نقحرة → `ahmad-sarah`.
عند التعارض: لاحقة قصيرة عشوائية (`ahmad-sarah-k3f`) لا رقم متسلسل (`-2` يفضح وجود دعوة أخرى بنفس الاسم).

**الكلمات المحجوزة** (جدول `reserved_slugs`):
```
api, admin, dashboard, login, register, logout, settings, billing, pricing,
templates, about, help, support, blog, docs, terms, privacy, static, assets,
_next, i, invitation, new, edit, preview, health, robots, sitemap, favicon,
www, mail, ftp, cdn, app, staging, test, demo, null, undefined, true, false
+ قائمة ألفاظ نابية بالعربية والإنجليزية
```

**قرار المساحة:** الدعوات تحت `/i/{slug}` **لا** تحت الجذر `/{slug}`.
لماذا؟ لأن الجذر يجب أن يبقى ملكاً لصفحات المنصة. وضع الدعوات في الجذر يعني أن إضافة صفحة
`/pricing` مستقبلاً قد تصطدم بدعوة موجودة. 📄 [ADR-0013](adr/0013-slug-and-reserved-words.md)

### 4.3 التوقيت — الخطأ الذي يكسر العد التنازلي

**المشكلة الحقيقية:** لو خزّنّا وقت الحفل كـ UTC فقط، ثم غيّرت الدولة توقيتها الصيفي
(أو تغيّرت قاعدة IANA)، ينزاح وقت العرس. وقد حدث هذا فعلاً في مصر والأردن وسوريا في السنوات الأخيرة.

**القاعدة:**
- خزّن **wall-clock محلياً** (`event_date` كـ `date` + `event_time` كـ `time`) + **IANA timezone** (`Asia/Riyadh`).
- **لا تخزّن لحظة UTC كمصدر للحقيقة.**
- احسب لحظة UTC عند العرض باستخدام أحدث بيانات المناطق الزمنية.

**العد التنازلي على العميل:**
```
1. الخادم يرسل: { eventLocalISO: "2026-09-20T20:00:00", timezone: "Asia/Riyadh", serverNowUtc: "..." }
2. العميل يحسب الإزاحة بين ساعته وساعة الخادم مرة واحدة (لأن ساعات الهواتف قد تكون خاطئة!)
3. يحسب اللحظة الهدف بـ Intl.DateTimeFormat / Temporal
4. يعدّ تنازلياً بالنسبة لوقت الخادم المصحَّح
```
**اختبار إلزامي:** منشئ في القاهرة، حفل في الرياض، ضيف في لندن، وجهاز ساعته متأخرة ساعتين.

### 4.4 استراتيجية العدّادات المجمّعة

عدّادات `view_count` و `rsvp_*_count` مكرّرة عن قصد على `invitations`.

- **عدّادات RSVP:** تُحدَّث في **نفس المعاملة** مع إدراج الرد → دقيقة دائماً.
- **عدّاد المشاهدات:** يُجمَّع في Redis ويُغسَل كل 60 ثانية → **لا نكتب في DB مع كل مشاهدة**.
  دقة تقريبية مقبولة تماماً هنا، والمقابل توفير ضخم في أحمال الكتابة.

### 4.5 المفاتيح الأجنبية وسلوك الحذف

| العلاقة | السلوك | السبب |
|---------|--------|-------|
| `invitations.owner_id` → users | `RESTRICT` | حذف المستخدم يمرّ عبر تدفق حذف مُدار، لا cascade صامت |
| `events.invitation_id` | `CASCADE` | لا معنى لحدث بلا دعوة |
| `rsvps.invitation_id` | `CASCADE` | كذلك |
| `invitation_versions.invitation_id` | `CASCADE` | كذلك |
| `media_assets.invitation_id` | `SET NULL` | الأصل يبقى في مكتبة المستخدم |
| `payments.user_id` | `RESTRICT` | **سجلات مالية لا تُحذف أبداً** — قيد قانوني/محاسبي |

---

## 5. استراتيجية الـ Migrations

**Expand → Migrate → Contract** إلزامياً على أي تغيير كاسر:

```
1. EXPAND    أضف العمود/الجدول الجديد (nullable، بقيمة افتراضية). الكود القديم يظل يعمل.
2. BACKFILL  عبّئ البيانات على دفعات (batches) خارج مسار الطلب.
3. MIGRATE   انشر كوداً يكتب في القديم والجديد، ثم كوداً يقرأ من الجديد.
4. CONTRACT  في إصدار لاحق: احذف القديم.
```

**قواعد:**
- ممنوع تماماً: `DROP COLUMN` أو `RENAME` في نفس نشرة الكود التي تستخدمه.
- كل migration له مسار تراجع موثّق (حتى لو كان «استرجاع من نسخة احتياطية»).
- `CREATE INDEX CONCURRENTLY` على الجداول الحية.
- تُختبَر الـ migrations في CI: من صفر، ومن آخر إصدار production.
- Migration يستغرق > 5 ثوانٍ على staging ⇒ يُرفض ويُعاد تصميمه كمهمة خلفية.

---

## 6. الأداء والفهرسة

### الاستعلامات الحرجة الثلاثة

```sql
-- 1. عرض دعوة منشورة (الأكثر تكراراً في النظام على الإطلاق)
SELECT v.published_document, i.id, i.status, i.expires_at
FROM invitations i
JOIN invitation_versions v ON v.id = i.published_version_id
WHERE i.slug = $1 AND i.deleted_at IS NULL;
-- Index Scan على invitations_slug_key ثم PK lookup → استعلامان بمفتاح. الهدف: < 5ms

-- 2. لوحة RSVP
SELECT * FROM rsvps
WHERE invitation_id = $1
ORDER BY submitted_at DESC LIMIT 50 OFFSET $2;
-- rsvps_invitation_idx يغطيه بالكامل. الهدف: < 20ms

-- 3. قائمة دعوات المستخدم
SELECT id, title, slug, status, event_date, rsvp_yes_count
FROM invitations
WHERE owner_id = $1 AND deleted_at IS NULL
ORDER BY created_at DESC;
-- invitations_owner_status_idx. الهدف: < 10ms
```

### التقسيم (Partitioning)

`analytics_events` و `audit_logs` مقسّمان شهرياً بـ `RANGE (occurred_at)`:
- الاستعلامات الحديثة تمسّ قسماً أو اثنين فقط.
- الاحتفاظ يصبح `DROP TABLE analytics_events_2026_05` — فوري وبلا vacuum مؤلم.

### تجمّع الاتصالات

Serverless + Postgres = خطر استنفاد الاتصالات. الحل: PgBouncer / Neon pooler في وضع transaction،
مع حد أقصى صريح للاتصالات لكل instance ومراقبة `pg_stat_activity`.

---

## 7. النسخ الاحتياطي والاحتفاظ

| البيانات | الاحتفاظ | ملاحظة |
|----------|----------|--------|
| نسخ DB الكاملة | يومية، 30 يوماً | + PITR بنافذة 7 أيام |
| `analytics_events` (خام) | 90 يوماً | ثم DROP PARTITION |
| `analytics_daily` | دائم | مجمّع ومجهّل |
| `audit_logs` | 2 سنة | متطلب امتثال |
| `invitation_versions` | آخر 20 نسخة | |
| الدعوات المحذوفة | 30 يوماً soft ثم حذف صلب | |
| بيانات RSVP | 90 يوماً بعد الحفل (افتراضي، قابل للتغيير) | بيانات طرف ثالث |
| الوسائط في R2 | تتبع الدعوة + 30 يوماً | تنظيف بمهمة دورية |
| سجلات الدفع | 7 سنوات | متطلب محاسبي/ضريبي |

تفاصيل RPO/RTO في [15-observability-and-dr.md](15-observability-and-dr.md).
