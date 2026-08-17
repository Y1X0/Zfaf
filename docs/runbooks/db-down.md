# Runbook — قاعدة البيانات غير متاحة

**الشدة:** P0 · **يوقظ:** نعم · **التنبيهات:** `database_unreachable` · `disk_pressure`

## ما يستمر بالعمل بدونها

هذا أول ما يجب أن تعرفه، لأنه يحدّد كم من الوقت لديك:

| السطح | بدون قاعدة بيانات |
|-------|--------------------|
| `/i/{slug}` **المخزَّنة على الحافة** | ✅ تعمل حتى 24 ساعة (`stale-while-revalidate=86400`) |
| `/i/{slug}` غير المخزَّنة | ❌ 500 |
| RSVP | ❌ الكتابة تفشل — وهذا مرئي للضيف |
| لوحة التحكم / البنّاء | ❌ |

**النتيجة العملية:** لديك ساعات لا دقائق للدعوات المرسَلة سابقاً، ولا وقت
إطلاقاً لدعوة نُشرت اليوم أو لضيف يحاول الردّ.

## 1. التشخيص

```bash
curl -s -H "Authorization: Bearer $HEALTH_CHECK_TOKEN" \
     https://$PUBLIC_HOST/api/health/deep | jq '.components[] | select(.name=="database")'

psql "$DATABASE_URL" -c 'SELECT 1'                 # هل تقبل اتصالاً أصلاً؟
psql "$DATABASE_URL" -c 'SELECT count(*) FROM pg_stat_activity'
psql "$DATABASE_URL" -c "SELECT pg_size_pretty(pg_database_size(current_database()))"
```

| النتيجة | السبب المرجّح | الإجراء |
|---------|----------------|---------|
| `too many clients` | استنزاف تجمّع الاتصالات | §2 |
| `no space left` | القرص امتلأ | §3 |
| لا اتصال إطلاقاً | المثيل ساقط أو الشبكة | §4 |
| بطيئة لا ساقطة | استعلام جامح أو قفل | §5 |

## 2. استنزاف تجمّع الاتصالات

السبب الأشهر هنا معروف ومكتوب في `apps/web/src/server/container.ts`: إنشاء
عميل Prisma لكل طلب يستنزف التجمّع خلال دقائق. المحوّلات singletons على مستوى
الوحدة لهذا السبب — إن رأيت هذا العرض بعد تغيير في التركيب، فهذا أول ما تنظر فيه.

```sql
-- من يمسك الاتصالات؟
SELECT state, count(*) FROM pg_stat_activity GROUP BY state;
-- أنهِ الخاملة في معاملة، وهي التي تسرّب
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE state = 'idle in transaction' AND state_change < now() - interval '5 minutes';
```

## 3. القرص امتلأ

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size
  FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;
```

المرشّحان المعتادان: `audit_logs` (احتفاظ سنتان، docs/09 §6) و`analytics_events`.
**لا تحذف من `audit_logs` يدوياً** — المُشغِّل يمنع الحذف عمداً، والالتفاف عليه
يفقد سجل التدقيق الذي ستحتاجه في المراجعة. وسّع القرص، ثم عالج الاحتفاظ لاحقاً.

## 4. المثيل ساقط

1. تحقّق من حالة المزوّد قبل أي شيء.
2. إن كان هناك replica: رقِّه، وحدّث `DATABASE_URL`، وأعد تشغيل النسخ.
3. إن لم يكن: [restore-backup.md](restore-backup.md). RPO المستهدف 5 دقائق
   و RTO ساعة واحدة (docs/15 §9) — ابدأ العدّ الآن وأعلنه.

## 5. بطيئة لا ساقطة

```sql
SELECT pid, now() - query_start AS duration, left(query, 120)
  FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > interval '30 seconds'
  ORDER BY duration DESC;
```

أنهِ الاستعلام الطويل الواحد قبل إعادة تشغيل أي شيء. إعادة التشغيل تُخفي السبب
وتعيده بعد دقائق.

## ما لا يُفعَل أبداً

- **لا `prisma migrate reset`.** لا في الإنتاج، ولا «لتنظيف الحالة»، ولا بأي مبرر.
- **لا حذف من `invitation_versions`.** غير قابلة للتعديل بمُشغِّل (ADR-0005)،
  وهي اللقطة التي تُعرَض للضيوف.
- **لا إبطال cache الحافة** بينما الأصل مكسور (انظر [site-down.md](site-down.md) §3).

## آخر تمرين

**لم يُنفَّذ بعد** — يتطلب مثيل إنتاج. بوابة إطلاق مفتوحة صراحةً.
