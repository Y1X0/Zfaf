import type { MailMessage, MailTemplate } from '@zfaf/core';

/**
 * Transactional email copy, in both languages (Go-Live gate 2).
 *
 * Kept here rather than in the i18n catalogue, and the split is deliberate: the
 * catalogue is bundled into the browser, and an email body is server-only text
 * a client never needs. Mixing them would ship every transactional message to
 * every visitor of the marketing page.
 *
 * ## What an email from this system may contain
 *
 * A link, and as little else as possible. No guest names, no phone numbers, no
 * invitation content — an inbox is not where those should accumulate (docs/15
 * §2 forbids logging them, and mailing them is worse). The RSVP notification
 * carries a count and a first name because the owner asked to be told somebody
 * replied; it deliberately carries no contact details.
 *
 * ## Why the HTML is this plain
 *
 * Because it is read in Gmail, in Apple Mail, in the Outlook desktop client,
 * and in the in-app browser of whatever the recipient is holding. Table
 * layouts and inline styles are not nostalgia — they are the only thing those
 * four render alike. There is no image, no web font and no external asset, so
 * nothing here can leak a read receipt or break behind a corporate proxy.
 *
 * RTL is set on the `<html>` element per locale, exactly as ADR-0011 sets it
 * on the application.
 */

export interface RenderedMail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

type Copy = {
  readonly subject: string;
  readonly heading: string;
  readonly body: readonly string[];
  /** Absent when the message carries no link — a notice rather than an action. */
  readonly action?: { readonly label: string; readonly url: string };
  readonly footer: string;
};

/** A day, in words, so the reader knows how long they have. */
const EXPIRY = {
  ar: { day: '٢٤ ساعة', quarter: '١٥ دقيقة' },
  en: { day: '24 hours', quarter: '15 minutes' },
} as const;

function copyFor(message: MailMessage, baseUrl: string): Copy {
  const arabic = message.locale !== 'en';
  const data = message.data;
  const link = (path: string, token?: string): string =>
    `${baseUrl.replace(/\/$/, '')}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  const templates: Record<MailTemplate, () => Copy> = {
    email_verification: () =>
      arabic
        ? {
            subject: 'فعّل بريدك في زفاف',
            heading: 'خطوة واحدة قبل النشر',
            body: [
              'أهلاً بك. اضغط الزر أدناه لتفعيل بريدك، وعندها يمكنك نشر دعوتك ومشاركة رابطها.',
              `الرابط صالح ${EXPIRY.ar.day}. تستطيع تصميم دعوتك الآن دون انتظار — التفعيل مطلوب للنشر فقط.`,
            ],
            action: { label: 'فعّل بريدي', url: link('/verify-email', data['token']) },
            footer: 'إن لم تكن أنت من أنشأ هذا الحساب، تجاهل هذه الرسالة ولن يحدث شيء.',
          }
        : {
            subject: 'Verify your email for Zfaf',
            heading: 'One step before publishing',
            body: [
              'Welcome. Press the button below to verify your address, and you can publish your invitation and share its link.',
              `The link is valid for ${EXPIRY.en.day}. You can design your invitation right now without waiting — verification is only needed to publish.`,
            ],
            action: { label: 'Verify my email', url: link('/verify-email', data['token']) },
            footer:
              'If you did not create this account, ignore this message and nothing will happen.',
          },

    password_reset: () =>
      arabic
        ? {
            subject: 'إعادة تعيين كلمة المرور',
            heading: 'طلب إعادة تعيين',
            body: [
              'وصلنا طلب لإعادة تعيين كلمة مرور حسابك. اضغط الزر أدناه لاختيار كلمة مرور جديدة.',
              `الرابط صالح ${EXPIRY.ar.quarter} ويُستخدم مرة واحدة. وعند استخدامه ستُغلق كل الجلسات المفتوحة على حسابك.`,
            ],
            action: { label: 'اختر كلمة مرور جديدة', url: link('/reset-password', data['token']) },
            footer:
              'إن لم تطلب هذا، تجاهل الرسالة — كلمة مرورك لم تتغيّر، ولا يستطيع أحد تغييرها بلا هذا الرابط.',
          }
        : {
            subject: 'Reset your password',
            heading: 'A reset was requested',
            body: [
              'We received a request to reset your account password. Press the button below to choose a new one.',
              `The link is valid for ${EXPIRY.en.quarter} and works once. Using it signs out every open session on your account.`,
            ],
            action: { label: 'Choose a new password', url: link('/reset-password', data['token']) },
            footer:
              'If you did not ask for this, ignore it — your password has not changed, and nobody can change it without this link.',
          },

    password_changed: () =>
      arabic
        ? {
            subject: 'تغيّرت كلمة مرور حسابك',
            heading: 'تأكيد تغيير كلمة المرور',
            body: [
              'تم تغيير كلمة مرور حسابك للتو، وأُغلقت كل الجلسات المفتوحة.',
              'إن لم تكن أنت، فحسابك في خطر الآن: أعد تعيين كلمة المرور فوراً وتواصل معنا.',
            ],
            footer: 'هذه رسالة أمان تُرسَل دائماً عند تغيير كلمة المرور.',
          }
        : {
            subject: 'Your password was changed',
            heading: 'Password change confirmed',
            body: [
              'Your account password was just changed, and every open session was signed out.',
              'If this was not you, your account is at risk right now: reset your password immediately and contact us.',
            ],
            footer: 'This is a security notice, sent whenever a password changes.',
          },

    new_device_sign_in: () =>
      arabic
        ? {
            subject: 'نشاط على حسابك',
            heading: 'محاولة استخدام بريدك',
            body: [
              'حاول أحدهم إنشاء حساب ببريدك، وهو مسجَّل لدينا بالفعل.',
              'إن كنت أنت، فحسابك موجود — استخدم «نسيت كلمة المرور» للدخول. وإن لم تكن أنت، فلا إجراء مطلوب: لم يُنشأ حساب جديد ولم يتغيّر شيء.',
            ],
            action: { label: 'استعادة كلمة المرور', url: link('/forgot-password') },
            footer: 'لا نكشف أبداً ما إذا كان بريد ما مسجَّلاً لدينا لأي شخص غير صاحبه.',
          }
        : {
            subject: 'Activity on your account',
            heading: 'Somebody used your address',
            body: [
              'Somebody tried to create an account with your email address, which is already registered with us.',
              'If that was you, your account already exists — use "forgot password" to get back in. If it was not, no action is needed: no new account was created and nothing changed.',
            ],
            action: { label: 'Recover my password', url: link('/forgot-password') },
            footer: 'We never reveal whether an address is registered to anyone but its owner.',
          },

    account_deletion_requested: () =>
      arabic
        ? {
            subject: 'طلب حذف حسابك',
            heading: 'الحذف مجدول',
            body: [
              'سجّلنا طلبك بحذف الحساب. سيُحذف نهائياً بعد ٣٠ يوماً، ومعه كل دعواتك وردود ضيوفك.',
              'تسجيل الدخول في أي وقت خلال هذه المدة يُلغي الحذف تلقائياً. بعدها لا يمكن التراجع.',
            ],
            footer: 'إن لم تطلب هذا، سجّل الدخول الآن لإلغاء الحذف.',
          }
        : {
            subject: 'Your account deletion request',
            heading: 'Deletion scheduled',
            body: [
              'We recorded your request to delete your account. It will be permanently deleted after 30 days, along with every invitation and every guest reply.',
              'Signing in at any point during that window cancels the deletion automatically. After it, there is no undo.',
            ],
            footer: 'If you did not request this, sign in now to cancel it.',
          },

    rsvp_received: () =>
      arabic
        ? {
            subject: `ردّ جديد على «${data['invitationTitle'] ?? 'دعوتك'}»`,
            heading: data['attending'] === 'yes' ? 'تأكيد حضور' : 'اعتذار عن الحضور',
            body: [
              data['attending'] === 'yes'
                ? `${data['guestName'] ?? 'ضيف'} أكّد الحضور بعدد ${data['partySize'] ?? '1'}.`
                : `${data['guestName'] ?? 'ضيف'} اعتذر عن الحضور.`,
              'الأعداد الكاملة والتفاصيل في لوحة التحكم.',
            ],
            action: { label: 'افتح لوحة الردود', url: link('/dashboard') },
            footer: 'لا نرسل هاتف الضيف ولا ملاحظته في البريد — تجدهما في اللوحة وحدها.',
          }
        : {
            subject: `A new reply to "${data['invitationTitle'] ?? 'your invitation'}"`,
            heading: data['attending'] === 'yes' ? 'Attending' : 'Not attending',
            body: [
              data['attending'] === 'yes'
                ? `${data['guestName'] ?? 'A guest'} is coming, with a party of ${data['partySize'] ?? '1'}.`
                : `${data['guestName'] ?? 'A guest'} has sent their apologies.`,
              'Full counts and details are on your dashboard.',
            ],
            action: { label: 'Open the replies', url: link('/dashboard') },
            footer:
              'We never email a guest’s phone number or their note — those stay on the dashboard.',
          },
  };

  return templates[message.template]();
}

/** Escapes for an HTML text node or attribute. Nothing here is trusted markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMail(message: MailMessage, baseUrl: string): RenderedMail {
  const copy = copyFor(message, baseUrl);
  const arabic = message.locale !== 'en';
  const dir = arabic ? 'rtl' : 'ltr';
  const lang = arabic ? 'ar' : 'en';

  const paragraphs = copy.body
    .map(
      (line) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:${arabic ? '1.9' : '1.6'};color:#241f1a">${escapeHtml(line)}</p>`,
    )
    .join('');

  const button = copy.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(copy.action.url)}" style="display:inline-block;padding:14px 28px;background:#8a6d24;color:#fffdf8;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px">${escapeHtml(copy.action.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#5c5348">${escapeHtml(
         arabic
           ? 'إن لم يعمل الزر، انسخ هذا الرابط:'
           : 'If the button does not work, copy this link:',
       )}<br><span style="word-break:break-all;color:#5c5348">${escapeHtml(copy.action.url)}</span></p>`
    : '';

  /**
   * A table, and inline styles.
   *
   * Not nostalgia: Outlook's desktop client renders with Word's engine, which
   * ignores most of a stylesheet. This is the layout those clients agree on.
   */
  const html = `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(copy.subject)}</title></head>
<body style="margin:0;padding:24px;background:#f7f2e7;font-family:-apple-system,'Segoe UI',Tahoma,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fffdf8;border-radius:12px">
<tr><td style="padding:32px;text-align:${arabic ? 'right' : 'left'}">
<p style="margin:0 0 24px;font-size:20px;font-weight:700;color:#241f1a">${escapeHtml(copy.heading)}</p>
${paragraphs}${button}
<p style="margin:32px 0 0;padding-top:16px;border-top:1px solid #d9c89a;font-size:13px;line-height:1.6;color:#5c5348">${escapeHtml(copy.footer)}</p>
</td></tr></table>
</body></html>`;

  // Always sent alongside the HTML. Some clients show it, some people prefer
  // it, and a screen reader handles it better than a table layout.
  const text = [
    copy.heading,
    '',
    ...copy.body,
    ...(copy.action ? ['', copy.action.label, copy.action.url] : []),
    '',
    copy.footer,
  ].join('\n');

  return { subject: copy.subject, html, text };
}
