# Runbooks

ثمانية إجراءات، واحد لكل حالة يمكن أن تُوقظ أحداً (docs/14 §13).

**قاعدة هذا المجلد:** Runbook غير مُختبَر = وثيقة أمنيات. كل ملف هنا يحمل قسم
«آخر تمرين» يقول **متى نُفِّذ فعلاً ومن نفّذه وما الذي تغيّر بعده**. تاريخ فارغ
هناك ليس تفصيلاً إدارياً — إنه إقرار بأن الإجراء غير مُثبَت.

| الحالة | الملف | ينبّه عليه |
|--------|-------|------------|
| الموقع ساقط | [site-down.md](site-down.md) | `site_down` · `public_invitations_failing` · `error_rate_severe` |
| قاعدة البيانات ساقطة | [db-down.md](db-down.md) | `database_unreachable` · `disk_pressure` |
| إيقاف دعوة مسيئة | [suspend-invitation.md](suspend-invitation.md) | بلاغ بشري |
| تسريب بيانات | [data-breach.md](data-breach.md) | `privilege_escalation_suspected` |
| مزوّد الدفع معطّل | [payments-down.md](payments-down.md) | (Phase 2) |
| تراجع عن نشرة | [rollback.md](rollback.md) | `publish_failing` |
| استرجاع من نسخة احتياطية | [restore-backup.md](restore-backup.md) | `backup_missing` |
| فشل migration | [migration-failed.md](migration-failed.md) | يدوي، أثناء النشر |

تعريفات التنبيهات في [`infra/monitoring/alerts.yml`](../../infra/monitoring/alerts.yml)،
و`pnpm alerts:check` يفشل إن أشار تنبيه P0/P1 إلى runbook غير موجود.

## قبل أي إجراء

1. **أعلن.** سطر واحد في قناة الحوادث: ماذا تلاحظ، ومنذ متى، ومن يقود.
2. **لا تصلح وتشرح في آن.** القيادة تعني عدم لمس لوحة المفاتيح إن كان هناك أحد آخر.
3. **اكتب الوقت.** كل خطوة بختم زمني. مراجعة ما بعد الحادث تُبنى على هذا لا على الذاكرة.
4. **الليلة مهمة.** إن كان هناك عرس الليلة، فأولوية `/i/{slug}` تسبق كل شيء آخر —
   لوحة التحكم يمكنها الانتظار ساعة، والدعوة لا يمكنها.
