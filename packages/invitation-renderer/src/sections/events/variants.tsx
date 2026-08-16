import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { SectionShell, formatEventDate, formatTime, safeMapUrl } from '../shared.js';

const eventsProps = defineProps<{ heading: string; showDescriptions: boolean; showVenue: boolean }>(
  {
    heading: { kind: 'text', default: '', maxLength: 80 },
    showDescriptions: { kind: 'boolean', default: true },
    showVenue: { kind: 'boolean', default: true },
  },
);

type EventsProps = typeof eventsProps.defaults;

function EventItems({
  props,
  content,
  theme,
  locale,
}: SectionRenderProps<EventsProps>): ReactElement {
  return (
    <>
      {[...content.events]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .map((event) => {
          const mapUrl = safeMapUrl(event.mapsUrl);
          const time = formatTime(event.startTime, locale, theme.numerals);
          return (
            <li className="zf-events__item" key={event.id}>
              <h3 className="zf-events__title">{event.title}</h3>
              <p className="zf-events__when">
                {formatEventDate(event.date, event.timezone, locale, theme.numerals)}
                {time ? <span className="zf-events__time"> · {time}</span> : null}
              </p>
              {props.showVenue && event.venueName ? (
                <p className="zf-events__venue">{event.venueName}</p>
              ) : null}
              {props.showDescriptions && event.description ? (
                <p className="zf-events__description">{event.description}</p>
              ) : null}
              {mapUrl ? (
                <a
                  className="zf-events__map"
                  href={mapUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {locale === 'ar' ? 'افتح الموقع' : 'Open location'}
                </a>
              ) : null}
            </li>
          );
        })}
    </>
  );
}

function withShell(variantClass: string) {
  return function EventsVariant(renderProps: SectionRenderProps<EventsProps>): ReactElement {
    const { props, content, sectionId } = renderProps;
    // A section with nothing to show renders nothing at all, rather than an
    // empty heading — the builder relies on this to keep defaults sensible.
    if (content.events.length === 0) return <></>;
    return (
      <SectionShell sectionId={sectionId} variantClass={variantClass}>
        {props.heading ? <h2 className="zf-events__heading">{props.heading}</h2> : null}
        <ol className="zf-events__list">
          <EventItems {...renderProps} />
        </ol>
      </SectionShell>
    );
  };
}

const editor = [
  { key: 'heading', kind: 'text' as const, labelKey: 'events.heading', max: 80 },
  { key: 'showDescriptions', kind: 'boolean' as const, labelKey: 'events.showDescriptions' },
  { key: 'showVenue', kind: 'boolean' as const, labelKey: 'events.showVenue' },
];

const shared = {
  type: 'events' as const,
  propsSchema: eventsProps,
  editor,
  capabilities: { needsEvents: true },
  a11y: { headingLevel: 2 as const },
};

export const eventsVariants: readonly SectionVariantDefinition<EventsProps>[] = [
  { ...shared, id: 'events.timeline', Component: withShell('zf-events zf-events--timeline') },
  { ...shared, id: 'events.cards', Component: withShell('zf-events zf-events--cards') },
  { ...shared, id: 'events.simpleList', Component: withShell('zf-events zf-events--list') },
];
