import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { Divider, SectionShell } from '../shared.js';

const messageProps = defineProps<{ heading: string; body: string; attribution: string }>({
  heading: { kind: 'text', default: '', maxLength: 80 },
  body: { kind: 'text', default: '', maxLength: 1200 },
  attribution: { kind: 'text', default: '', maxLength: 80 },
});

type MessageProps = typeof messageProps.defaults;

function withShell(variantClass: string, withDivider: boolean) {
  return function MessageVariant({
    props,
    content,
    sectionId,
  }: SectionRenderProps<MessageProps>): ReactElement {
    // Falls back to the couple's own message, so the section is useful without
    // the owner filling in a second copy of the same text.
    const body = props.body || content.couple.message || '';
    if (!body) return <></>;

    return (
      <SectionShell sectionId={sectionId} variantClass={variantClass}>
        {props.heading ? <h2 className="zf-message__heading">{props.heading}</h2> : null}
        <blockquote className="zf-message__body">
          <p>{body}</p>
          {props.attribution ? (
            <footer className="zf-message__attribution">{props.attribution}</footer>
          ) : null}
        </blockquote>
        {withDivider ? <Divider /> : null}
      </SectionShell>
    );
  };
}

const editor = [
  { key: 'heading', kind: 'text' as const, labelKey: 'message.heading', max: 80 },
  { key: 'body', kind: 'longText' as const, labelKey: 'message.body', max: 1200 },
  { key: 'attribution', kind: 'text' as const, labelKey: 'message.attribution', max: 80 },
];

const shared = {
  type: 'message' as const,
  propsSchema: messageProps,
  editor,
  capabilities: {},
  a11y: { headingLevel: 2 as const },
};

export const messageVariants: readonly SectionVariantDefinition<MessageProps>[] = [
  {
    ...shared,
    id: 'message.centeredQuote',
    Component: withShell('zf-message zf-message--quote', true),
  },
  {
    ...shared,
    id: 'message.letterCard',
    Component: withShell('zf-message zf-message--letter', false),
  },
];
