import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { Divider, SectionShell, safeMapUrl } from '../shared.js';

const locationProps = defineProps<{ heading: string; buttonLabel: string }>({
  heading: { kind: 'text', default: '', maxLength: 80 },
  buttonLabel: { kind: 'text', default: '', maxLength: 40 },
});

type LocationProps = typeof locationProps.defaults;

/**
 * Location variants.
 *
 * Deliberately no embedded map: an iframe would add hundreds of kilobytes of
 * third-party JavaScript and tracking to the page with the strictest budget,
 * and a guest wants directions in their own maps app anyway
 * (docs/07-frontend-architecture.md §3).
 */
function LocationBody({ props, content, locale }: SectionRenderProps<LocationProps>): ReactElement {
  const mapUrl = safeMapUrl(content.location.mapsUrl);
  const label = props.buttonLabel || (locale === 'ar' ? 'افتح الموقع' : 'Open location');

  return (
    <>
      {props.heading ? <h2 className="zf-location__heading">{props.heading}</h2> : null}
      {content.location.venueName ? (
        <p className="zf-location__venue">{content.location.venueName}</p>
      ) : null}
      {content.location.address ? (
        <p className="zf-location__address">{content.location.address}</p>
      ) : null}
      {mapUrl ? (
        <a
          className="zf-button zf-location__button"
          href={mapUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          {label}
        </a>
      ) : null}
    </>
  );
}

function MapCard(renderProps: SectionRenderProps<LocationProps>): ReactElement {
  const { content, sectionId } = renderProps;
  if (!content.location.venueName && !content.location.address) return <></>;
  return (
    <SectionShell sectionId={sectionId} variantClass="zf-location zf-location--card">
      <div className="zf-location__card">
        <LocationBody {...renderProps} />
      </div>
      <Divider />
    </SectionShell>
  );
}

function TextWithButton(renderProps: SectionRenderProps<LocationProps>): ReactElement {
  const { content, sectionId } = renderProps;
  if (!content.location.venueName && !content.location.address) return <></>;
  return (
    <SectionShell sectionId={sectionId} variantClass="zf-location zf-location--plain">
      <LocationBody {...renderProps} />
    </SectionShell>
  );
}

const editor = [
  { key: 'heading', kind: 'text' as const, labelKey: 'location.heading', max: 80 },
  { key: 'buttonLabel', kind: 'text' as const, labelKey: 'location.buttonLabel', max: 40 },
];

const shared = {
  type: 'location' as const,
  propsSchema: locationProps,
  editor,
  capabilities: { needsLocation: true },
  a11y: { headingLevel: 2 as const },
};

export const locationVariants: readonly SectionVariantDefinition<LocationProps>[] = [
  { ...shared, id: 'location.mapCard', Component: MapCard },
  { ...shared, id: 'location.textWithButton', Component: TextWithButton },
];
