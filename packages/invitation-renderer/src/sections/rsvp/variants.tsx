import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { SectionShell } from '../shared.js';

/**
 * RSVP variants.
 *
 * Renders the form shell only. Submission is wired in M7, and the party-size
 * limit shown here is a hint for the guest — it is enforced server-side on
 * every submission, never trusted from the markup.
 */

const rsvpProps = defineProps<{ heading: string; prompt: string; showNote: boolean }>({
  heading: { kind: 'text', default: '', maxLength: 80 },
  prompt: { kind: 'text', default: '', maxLength: 200 },
  showNote: { kind: 'boolean', default: true },
});

type RsvpProps = typeof rsvpProps.defaults;

function withShell(variantClass: string) {
  return function RsvpVariant({
    props,
    content,
    locale,
    sectionId,
  }: SectionRenderProps<RsvpProps>): ReactElement {
    if (!content.rsvp.enabled) return <></>;
    const arabic = locale === 'ar';

    return (
      <SectionShell sectionId={sectionId} variantClass={variantClass}>
        {props.heading ? <h2 className="zf-rsvp__heading">{props.heading}</h2> : null}
        {props.prompt ? <p className="zf-rsvp__prompt">{props.prompt}</p> : null}

        <form
          className="zf-rsvp__form"
          method="post"
          data-rsvp-form
          data-max-party-size={content.rsvp.maxPartySize}
          {...(content.rsvp.deadline ? { 'data-rsvp-deadline': content.rsvp.deadline } : {})}
        >
          <div className="zf-rsvp__choice">
            <label className="zf-rsvp__option">
              <input type="radio" name="attending" value="yes" defaultChecked />
              <span>{arabic ? 'سأحضر' : "I'll be there"}</span>
            </label>
            <label className="zf-rsvp__option">
              <input type="radio" name="attending" value="no" />
              <span>{arabic ? 'لن أستطيع الحضور' : "I can't make it"}</span>
            </label>
          </div>

          <label className="zf-field">
            <span className="zf-field__label">{arabic ? 'الاسم' : 'Name'}</span>
            <input className="zf-field__input" type="text" name="name" required maxLength={80} />
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
