import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { Divider, Picture, SectionShell } from '../shared.js';

const coupleProps = defineProps<{ heading: string; showMessage: boolean }>({
  heading: { kind: 'text', default: '', maxLength: 80 },
  showMessage: { kind: 'boolean', default: true },
});

type CoupleProps = typeof coupleProps.defaults;

function Names({ props, content }: SectionRenderProps<CoupleProps>): ReactElement {
  return (
    <>
      {props.heading ? <h2 className="zf-couple__heading">{props.heading}</h2> : null}
      <div className="zf-couple__names">
        <span className="zf-couple__name">{content.couple.groomName}</span>
        <span className="zf-couple__amp" aria-hidden="true">
          &amp;
        </span>
        <span className="zf-couple__name">{content.couple.brideName}</span>
      </div>
      {props.showMessage && content.couple.message ? (
        <p className="zf-couple__message">{content.couple.message}</p>
      ) : null}
    </>
  );
}

function PortraitPair(renderProps: SectionRenderProps<CoupleProps>): ReactElement {
  const { content, sectionId } = renderProps;
  return (
    <SectionShell sectionId={sectionId} variantClass="zf-couple zf-couple--portrait">
      {content.couple.photo ? (
        <Picture
          image={content.couple.photo}
          className="zf-couple__photo"
          sizes="(max-width: 768px) 90vw, 520px"
        />
      ) : null}
      <Names {...renderProps} />
      <Divider />
    </SectionShell>
  );
}

/** Names only — for templates and families that publish no photographs. */
function NamesOnly(renderProps: SectionRenderProps<CoupleProps>): ReactElement {
  return (
    <SectionShell sectionId={renderProps.sectionId} variantClass="zf-couple zf-couple--names">
      <Names {...renderProps} />
    </SectionShell>
  );
}

const editor = [
  { key: 'heading', kind: 'text' as const, labelKey: 'couple.heading', max: 80 },
  { key: 'showMessage', kind: 'boolean' as const, labelKey: 'couple.showMessage' },
];

export const coupleVariants: readonly SectionVariantDefinition<CoupleProps>[] = [
  {
    id: 'couple.portraitPair',
    type: 'couple',
    propsSchema: coupleProps,
    Component: PortraitPair,
    editor,
    capabilities: { needsMedia: ['couple'] },
    a11y: { headingLevel: 2 },
  },
  {
    id: 'couple.namesOnly',
    type: 'couple',
    propsSchema: coupleProps,
    Component: NamesOnly,
    editor,
    capabilities: {},
    a11y: { headingLevel: 2 },
  },
];
