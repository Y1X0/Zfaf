import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { Picture, SectionShell } from '../shared.js';

const galleryProps = defineProps<{ heading: string; maxImages: number }>({
  heading: { kind: 'text', default: '', maxLength: 80 },
  maxImages: { kind: 'number', default: 24, min: 1, max: 60 },
});

type GalleryProps = typeof galleryProps.defaults;

function withShell(variantClass: string) {
  return function GalleryVariant({
    props,
    content,
    sectionId,
  }: SectionRenderProps<GalleryProps>): ReactElement {
    // No photographs means no gallery — the section disappears rather than
    // showing an empty state the owner never asked for.
    if (content.gallery.length === 0) return <></>;
    const images = content.gallery.slice(0, props.maxImages);

    return (
      <SectionShell sectionId={sectionId} variantClass={variantClass}>
        {props.heading ? <h2 className="zf-gallery__heading">{props.heading}</h2> : null}
        <ul className="zf-gallery__grid">
          {images.map((image, index) => (
            <li className="zf-gallery__item" key={image.id}>
              <Picture
                image={image}
                className="zf-gallery__image"
                // Only the first two are eager; the rest load as the guest
                // scrolls, which is most of the page weight on a phone.
                priority={index < 2}
                sizes="(max-width: 768px) 45vw, 300px"
              />
            </li>
          ))}
        </ul>
      </SectionShell>
    );
  };
}

const editor = [
  { key: 'heading', kind: 'text' as const, labelKey: 'gallery.heading', max: 80 },
  { key: 'maxImages', kind: 'number' as const, labelKey: 'gallery.maxImages', max: 60 },
];

const shared = {
  type: 'gallery' as const,
  propsSchema: galleryProps,
  editor,
  capabilities: { needsMedia: ['gallery' as const] },
  a11y: { headingLevel: 2 as const },
};

export const galleryVariants: readonly SectionVariantDefinition<GalleryProps>[] = [
  { ...shared, id: 'gallery.masonry', Component: withShell('zf-gallery zf-gallery--masonry') },
  { ...shared, id: 'gallery.grid', Component: withShell('zf-gallery zf-gallery--grid') },
  { ...shared, id: 'gallery.carousel', Component: withShell('zf-gallery zf-gallery--carousel') },
];
