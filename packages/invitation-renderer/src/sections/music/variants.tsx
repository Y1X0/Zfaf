import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { SectionShell, safeMediaUrl } from '../shared.js';

/**
 * Music variants.
 *
 * No browser allows audio to start without a user gesture, and iOS Safari is
 * the strictest. Rather than fight that, the control is part of the design:
 * `preload="none"` so nothing is fetched until a guest asks, which also spares
 * their data (docs/07-frontend-architecture.md §8).
 */

const musicProps = defineProps<{ label: string; showAttribution: boolean }>({
  label: { kind: 'text', default: '', maxLength: 60 },
  showAttribution: { kind: 'boolean', default: true },
});

type MusicProps = typeof musicProps.defaults;

function withShell(variantClass: string) {
  return function MusicVariant({
    props,
    content,
    locale,
    sectionId,
  }: SectionRenderProps<MusicProps>): ReactElement {
    // Same scheme check as images: the snapshot schema validates URL syntax,
    // not what the URI would do.
    const audioUrl = safeMediaUrl(content.music.url);
    if (!audioUrl) return <></>;
    const label = props.label || (locale === 'ar' ? 'تشغيل الموسيقى' : 'Play music');

    return (
      <SectionShell sectionId={sectionId} variantClass={variantClass}>
        <div className="zf-music__player" data-music-player>
          <button className="zf-music__toggle" type="button" data-music-toggle aria-pressed="false">
            {label}
          </button>
          {/* preload="none": a guest's data is not spent before they ask. */}
          <audio className="zf-music__audio" src={audioUrl} preload="none" loop data-music-audio>
            <track kind="captions" />
          </audio>
        </div>
        {props.showAttribution && content.music.attribution ? (
          <p className="zf-music__attribution">{content.music.attribution}</p>
        ) : null}
      </SectionShell>
    );
  };
}

const editor = [
  { key: 'label', kind: 'text' as const, labelKey: 'music.label', max: 60 },
  { key: 'showAttribution', kind: 'boolean' as const, labelKey: 'music.showAttribution' },
];

const shared = {
  type: 'music' as const,
  propsSchema: musicProps,
  editor,
  capabilities: { interactive: true },
  a11y: {},
};

export const musicVariants: readonly SectionVariantDefinition<MusicProps>[] = [
  { ...shared, id: 'music.floatingButton', Component: withShell('zf-music zf-music--floating') },
  { ...shared, id: 'music.inlineBar', Component: withShell('zf-music zf-music--inline') },
];
