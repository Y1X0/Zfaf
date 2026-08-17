# Runbook — فشل migration أثناء النشر

**الشدة:** P0 إن كان النشر عالقاً · **الوقت:** أثناء النشر، غالباً

## أولاً: أي نوع من الفشل؟

```bash
DATABASE_URL=$PROD_URL pnpm --filter @zfaf/db exec prisma migrate status
```

| ما يقوله | ما حدث | اذهب إلى |
|----------|--------|----------|
| `Database schema is up to date` | نجحت، والفشل في مكان آخر | [site-down.md](site-down.md) |
| `following migration(s) have not yet been applied` | لم تبدأ | §1 |
| `migration started but failed` | **توقّفت في المنتصف** | §2 |
| `drift detected` | المخطط عُدِّل خارج الـ migrations | §3 |

## 1. لم تبدأ

الأسهل. المخطط لم يتغيّر، والكود القديم يعمل عليه. أصلح الـ migration وأعد
النشر بلا عجلة.

## 2. توقّفت في المنتصف

الحالة الوحيدة المقلقة هنا. PostgreSQL يجعل DDL معاملاتياً، فمعظم الفشل يتراجع
تلقائياً — لكن migration مقسّمة إلى عدة عبارات قد تترك بعضها مطبَّقاً.

```sql
SELECT migration_name, started_at, finished_at, logs
  FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;
```

1. **اقرأ أي عبارة نجحت** من `logs` قبل أي شيء آخر.
2. أكمل يدوياً بما يجعل الحالة متسقة، أو اعكس ما طُبِّق — بعبارات صريحة تكتبها
   وتقرؤها، لا بأداة.
3. علّم السجل: `prisma migrate resolve --applied <name>` أو `--rolled-back <name>`.
4. `migrate status` مرة أخرى قبل استئناف النشر.

**لا `prisma migrate reset`.** إطلاقاً. تحذف كل شيء، وهي أول ما تقترحه الأداة.

## 3. انحراف المخطط

شخص عدّل الإنتاج يدوياً. لا تُصلحه بـ `migrate dev` — سيولّد migration تحذف
التغيير اليدوي بلا سؤال.

```bash
DATABASE_URL=$PROD_URL pnpm --filter @zfaf/db exec prisma migrate diff \
  --from-migrations prisma/migrations --to-schema-datasource prisma/schema.prisma \
  --script > /tmp/drift.sql
```

اقرأ `/tmp/drift.sql` بعينيك. قرّر أي جانب هو الصحيح، واكتب migration صريحة
تصل بالإنتاج إلى المخطط المقصود.

## لماذا هذا نادر عندنا

docs/14 §5 يفرض **نمط الخطوتين**: كل migration متوافقة مع الإصدار السابق من
الكود. عمود جديد يصل nullable أولاً، ويُملأ، ويصبح NOT NULL في نشرة لاحقة.
النتيجة أن التراجع عن الكود لا يحتاج عكس المخطط أبداً — وهو ما يجعل
[rollback.md](rollback.md) إجراءً من خطوة واحدة.

وCI يطبّق **كل** migration من قاعدة فارغة في كل PR (`db:deploy` في وظيفة
التكامل)، فـ migration لا تعمل من الصفر لا تصل إلى الإنتاج أصلاً.

## آخر تمرين

**لم يُنفَّذ** — يتطلب افتعال فشل على staging. بوابة إطلاق مفتوحة صراحةً.
