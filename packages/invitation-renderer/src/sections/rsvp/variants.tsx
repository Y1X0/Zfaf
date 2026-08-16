import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { SectionShell } from '../shared.js';

/**
 * RSVP variants (M3 shell, wired in M7).
 *
 * A **native HTML form**, and that is a decision rather than a starting point.
 * The public page ships no framework (ADR-0020), so this markup is the whole
 * mechanism: a guest with JavaScript blocked, or on a phone where the script
 * failed to download over hotel wi-fi, still replies. The enhancement script
 * intercepts the submit to avoid a page navigation; when it is absent the
 * browser posts the form and the server redirects back with the outcome.
 *
 * Nothing here is trusted. `maxPartySize` is rendered as a hint and as an
 * `max` attribute so the phone shows the right keyboard and the browser gives
 * immediate feedback — and it is re-checked server-side against the published
 * snapshot on every submission, because markup is something a guest can edit.
 */

const rsvpProps = defineProps<{ heading: string; prompt: string; showNote: boolean }>({
  heading: { kind: 'text', default: '', maxLength: 80 },
  prompt: { kind: 'text', default: '', maxLength: 200 },
  showNote: { kind: 'boolean', default: true },
});

type RsvpProps = typeof rsvpProps.defaults;

/** What a guest is told after a form post, per outcome. */
const STATUS_TEXT: Record<'ar' | 'en', Record<string, string>> = {
  ar: {
    ok: 'شكراً لك! تم تسجيل ردّك.',
    invalid: 'تحقّق من الاسم وعدد الأشخاص ثم أعد المحاولة.',
    closed: 'هذه الدعوة لم تعد تستقبل الردود.',
    rate: 'وصلنا عدد كبير من المحاولات. انتظر قليلاً ثم أعد المحاولة.',
    check: 'نحتاج تأكيداً بسيطاً أنك لست روبوتاً. أعد المحاولة.',
  },
  en: {
    ok: 'Thank you — your reply has been recorded.',
    invalid: 'Please check the name and number of guests, then try again.',
    closed: 'This invitation is no longer accepting replies.',
    rate: 'That is a lot of attempts. Please wait a moment and try again.',
    check: 'We need a quick check that you are not a robot. Please try again.',
  },
};

function withShell(variantClass: string) {
  return function RsvpVariant({
    props,
    content,
    locale,
    sectionId,
    formAction,
    formStatus,
  }: SectionRenderProps<RsvpProps>): ReactElement {
    if (!content.rsvp.enabled) return <></>;
    const arabic = locale === 'ar';
    const status = formStatus ? STATUS_TEXT[locale][formStatus] : null;

    /**
     * Once a reply is in, the form is replaced rather than left beside a
     * confirmation. Showing both invites a second submission, which the
     * server would deduplicate — but a guest who cannot tell whether they
     * replied has been failed by the interface regardless.
     */
    if (formStatus === 'ok') {
      return (
        <SectionShell sectionId={sectionId} variantClass={variantClass}>
          <p className="zf-rsvp__status" data-rsvp-status="ok" role="status">
            {status}
          </p>
        </SectionShell>
      );
    }

    return (
      <SectionShell sectionId={sectionId} variantClass={variantClass}>
        {props.heading ? <h2 className="zf-rsvp__heading">{props.heading}</h2> : null}
        {props.prompt ? <p className="zf-rsvp__prompt">{props.prompt}</p> : null}

        {/*
          `aria-live` and `role="status"` so a screen reader announces the
          outcome. Present even when empty: a live region added to the page at
          the same moment its content arrives is frequently not announced.
        */}
        <p
          className="zf-rsvp__status"
          data-rsvp-status={formStatus ?? ''}
          role="status"
          aria-live="polite"
        >
          {status}
        </p>

        <form
          className="zf-rsvp__form"
          method="post"
          {...(formAction ? { action: formAction } : {})}
          data-rsvp-form
          data-max-party-size={content.rsvp.maxPartySize}
          {...(content.rsvp.deadline ? { 'data-rsvp-deadline': content.rsvp.deadline } : {})}
        >
          <fieldset className="zf-rsvp__choice">
            <legend className="zf-field__label">{arabic ? 'هل ستحضر؟' : 'Will you attend?'}</legend>
            <label className="zf-rsvp__option">
              <input type="radio" name="attending" value="yes" defaultChecked />
              <span>{arabic ? 'سأحضر' : "I'll be there"}</span>
            </label>
            <label className="zf-rsvp__option">
              <input type="radio" name="attending" value="no" />
              <span>{arabic ? 'لن أستطيع الحضور' : "I can't make it"}</span>
            </label>
          </fieldset>

          <label className="zf-field">
            <span className="zf-field__label">{arabic ? 'الاسم' : 'Name'}</span>
            <input
              className="zf-field__input"
              type="text"
              name="name"
              required
              minLength={2}
              maxLength={80}
              autoComplete="name"
            />
          </label>

          <label className="zf-field">
            <span className="zf-field__label">{arabic ? 'عدد الأشخاص' : 'Guests'}</span>
            <input
              className="zf-field__input"
              type="number"
              name="partySize"
              min={1}
              max={content.rsvp.maxPartySize}
              defaultValue={1}
              // `numeric` rather than `tel`: it puts a digit keypad on a phone
              // without offering the punctuation a phone number needs.
              inputMode="numeric"
            />
          </label>

          <label className="zf-field">
            <span className="zf-field__label">
              {arabic ? 'رقم الجوال (اختياري)' : 'Phone (optional)'}
            </span>
            <input
              className="zf-field__input"
              type="tel"
              name="phone"
              maxLength={32}
              autoComplete="tel"
              dir="ltr"
            />
          </label>

          {props.showNote ? (
            <label className="zf-field">
              <span className="zf-field__label">{arabic ? 'ملاحظات' : 'Notes'}</span>
              <textarea className="zf-field__input" name="note" maxLength={500} rows={3} />
            </label>
          ) : null}

          {/* Honeypot: a bot fills it, a person never sees it. */}
          <label className="zf-rsvp__trap" aria-hidden="true">
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </label>

          <button className="zf-button zf-rsvp__submit" type="submit">
            {arabic ? 'إرسال' : 'Send'}
          </button>
        </form>
      </SectionShell>
    );
  };
}

const editor = [
  { key: 'heading', kind: 'text' as const, labelKey: 'rsvp.heading', max: 80 },
  { key: 'prompt', kind: 'text' as const, labelKey: 'rsvp.prompt', max: 200 },
  { key: 'showNote', kind: 'boolean' as const, labelKey: 'rsvp.showNote' },
];

const shared = {
  type: 'rsvp' as const,
  propsSchema: rsvpProps,
  editor,
  capabilities: { interactive: true },
  a11y: { headingLevel: 2 as const },
};

export const rsvpVariants: readonly SectionVariantDefinition<RsvpProps>[] = [
  { ...shared, id: 'rsvp.elegantForm', Component: withShell('zf-rsvp zf-rsvp--elegant') },
  { ...shared, id: 'rsvp.compactForm', Component: withShell('zf-rsvp zf-rsvp--compact') },
];
