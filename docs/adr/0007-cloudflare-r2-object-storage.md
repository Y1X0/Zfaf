# ADR-0007 — Cloudflare R2 كـ Object Storage

**الحالة:** ✅ Accepted · **اقتُرح:** 2026-08-16 · **اعتُمد:** 2026-08-16

## السياق

المنتج **يبثّ صوراً بكثافة**. حساب واقعي لدعوة واحدة:

```
400 مشاهدة × 6 صور محمّلة × 120KB  ≈  290MB egress لكل دعوة
```

عند 1,000 دعوة/شهر = **~290GB egress شهرياً**.
عند 10,000 دعوة/شهر = **~2.9TB egress شهرياً**.

هذا يجعل **رسوم الخروج (egress)** — لا التخزين — هي بند التكلفة الحقيقي.

## القرار

**Cloudflare R2** كتخزين كائنات أساسي، عبر واجهة S3 API القياسية،
خلف Cloudflare Worker على نطاق `cdn.zfaf.app`.

## المقارنة الاقتصادية

| المزوّد | تخزين/GB | Egress/GB | التكلفة عند 2.9TB egress |
|---------|---------:|----------:|--------------------------:|
| **Cloudflare R2** | $0.015 | **$0.00** | **$0** |
| AWS S3 | $0.023 | $0.09 | **~$260/شهر** |
| Supabase Storage | $0.021 | مدفوع بعد حد | متغيّر، مرتفع |
| Backblaze B2 | $0.006 | مجاني عبر Cloudflare | $0 |

**الفرق ليس تحسيناً هامشياً** — إنه الفرق بين بند تكلفة بـ 3% من الفاتورة وبند بـ 25%،
ويتضاعف خطياً مع النمو بلا سقف.

## البدائل المرفوضة

| البديل | لماذا |
|--------|-------|
| AWS S3 | رسوم egress قاتلة لنمط استخدامنا تحديداً |
| Supabase Storage | يجرّنا لكامل حزمة Supabase؛ تسعير egress أسوأ |
| Backblaze B2 | اقتصاديات ممتازة، لكن تكامل أضعف وأداء أدنى قليلاً — **نستخدمه كوجهة نسخ احتياطي** |
| تخزين محلي على الخادم | لا يتوسع، لا يتحمل الأعطال، لا CDN |
| صور في PostgreSQL | ❌ ممنوع صراحةً في المتطلبات، ولسبب وجيه |

## العواقب

### إيجابية
- egress مجاني ⇒ التكلفة تنمو مع **التخزين** (بطيء) لا مع **الحركة** (سريع).
- S3 API قياسي ⇒ **لا قفل مزوّد** — الهجرة تغيير endpoint.
- تكامل أصلي مع Cloudflare CDN و Workers.
- روابط موقّعة، versioning، قواعد دورة حياة — كلها متاحة.

### سلبية
- ارتباط بمنظومة Cloudflare (لكننا نستخدمها للـ CDN والـ WAF أصلاً).
- لا مزايا S3 المتقدمة (Glacier، Intelligent-Tiering) — **لا نحتاجها**.
- الأداء في بعض المناطق أقل قليلاً من S3 — مهمَل عملياً لأن كل شيء خلف CDN.

## تفاصيل التنفيذ

- الوصول عبر واجهة `StorageService` (منفذ) → تبديل المزوّد = محوّل جديد.
- التطوير المحلي: **MinIO** (نفس S3 API) في Docker Compose.
- الوسائط تُخدَم من `cdn.zfaf.app` عبر Worker، لا من نطاق التطبيق.
- `Cache-Control: public, max-age=31536000, immutable` — الأصول غير قابلة للتغيير.
- نسخ احتياطي أسبوعي إلى **Backblaze B2** — لتفادي الاعتماد على مزوّد واحد.

## محفّزات إعادة النظر

- تغيّر تسعير R2 جوهرياً.
- حاجة لتخزين في منطقة جغرافية محددة لأسباب تنظيمية (سيادة البيانات).
- حاجة لميزات S3 المتقدمة.

---

## تعديل عند الاعتماد (2026-08-16)

المالك اعتمد R2 **بشرط تجريد إلزامي**: التطبيق لا يُربط بـ R2 إلى الأبد.

### `StorageProvider` — العقد المُلزِم

```typescript
// packages/core/src/media/ports/storage-provider.ts
export interface StorageProvider {
  readonly key: string;                                  // 'r2' | 's3' | 'minio' | ...

  createUploadUrl(input: {
    key: StorageKey;
    contentType: string;                                 // ← يُقيَّد في التوقيع
    maxSizeBytes: number;                                // ← يُقيَّد في التوقيع
    expiresInSeconds: number;
  }): Promise<SignedUpload>;

  createSignedDownloadUrl(key: StorageKey, ttlSeconds: number): Promise<string>;
  head(key: StorageKey): Promise<ObjectMetadata | null>; // الحجم، ETag، النوع الفعلي
  delete(key: StorageKey): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;         // لحذف الحساب/الدعوة
}
```

**القدرات المطلوبة صراحةً من المالك:**

| القدرة | مكان التنفيذ |
|--------|---------------|
| Upload | `createUploadUrl` — رفع مباشر بلا مرور بخادمنا |
| Delete | `delete` / `deletePrefix` |
| Signed access | `createSignedDownloadUrl` — للمسودات والمعاينات |
| Metadata | `head` — **مصدر الحقيقة للحجم والنوع، لا ادعاء العميل** |
| Content-Type validation | قائمة بيضاء عند طلب الرابط + **magic bytes في الـ worker** |
| File size limits | مقيّد في توقيع الرابط + مُتحقَّق بـ `head` بعد الرفع |
| Image optimization | `apps/worker` — Sharp، نسخ AVIF/WebP/JPEG |
| **EXIF stripping** | `apps/worker` — **إلزامي وغير قابل للتعطيل** |

**قواعد تنفيذ مُلزِمة:**
- ❌ لا استيراد لـ AWS SDK أو أي عميل R2 خارج `infra/storage/`.
  → قاعدة `dependency-cruiser` تفشل CI.
- ✅ `StorageKey` **نوع محدَّد** (branded type) يُبنى من الخادم فقط — لا سلاسل حرة.
- ✅ التطوير المحلي يستخدم **MinIO** عبر **نفس المحوّل** (S3 API) — يثبت التجريد عملياً.
- ✅ اختبارات العقد (contract tests) تعمل على المحوّلين معاً بنفس المجموعة.

**نتيجة قابلة للتحقق:** الانتقال من R2 إلى S3 أو Supabase Storage = محوّل جديد
يحقق نفس الواجهة، بلا مساس بأي منطق أعمال.
