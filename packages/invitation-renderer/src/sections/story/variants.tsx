import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { SectionShell } from '../shared.js';

/**
 * Story variants.
 *
 * Content comes from the section's own props rather than the invitation
 * document: this is optional narrative copy, not structured wedding data, so it
 * does not belong in the content model.
 */

const storyProps = defineProps<{ heading: string; body: string }>({
  heading: { kind: 'text', default: '', maxLength: 80 },
  body: { kind: 'text', default: '', maxLength: 2000 },
});

type StoryProps = typeof storyProps.defaults;

function withShell(variantClass: string) {
  return function StoryVariant({ props, sectionId }: SectionRenderProps<StoryProps>): ReactElement {
    if (!props.body) return <></>;
    return (
      <SectionShell sectionId={sectionId} variantClass={variantClass}>
        {props.heading ? <h2 className="zf-story__heading">{props.heading}</h2> : null}
        {/* Paragraph breaks come from the text, never from embedded markup. */}
        {props.body
          .split('\n')
          .filter(Boolean)
          .map((paragraph, index) => (
            <p className="zf-story__paragraph" key={`${index}-${paragraph.slice(0, 12)}`}>
              {paragraph}
            </p>
          ))}
      </SectionShell>
    );
  };
}

const editor = [
  { key: 'heading', kind: 'text' as const, labelKey: 'story.heading', max: 80 },
  { key: 'body', kind: 'longText' as const, labelKey: 'story.body', max: 2000 },
];

const shared = {
  type: 'story' as const,
  propsSchema: storyProps,
  editor,
  capabilities: {},
  a11y: { headingLevel: 2 as const },
};

export const storyVariants: readonly SectionVariantDefinition<StoryProps>[] = [
  { ...shared, id: 'story.timeline', Component: withShell('zf-story zf-story--timeline') },
  { ...shared, id: 'story.quote', Component: withShell('zf-story zf-story--quote') },
];
