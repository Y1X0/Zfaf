import type { ReactElement } from 'react';

import { EventDateTime } from '@zfaf/core';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { SectionShell } from '../shared.js';

/**
 * Countdown variants.
 *
 * Renders a **static shell** carrying the target instant in a data attribute.
 * It deliberately does not compute a remaining time at render: reading the
 * clock here would make the renderer non-deterministic, and the same markup has
 * to be reproducible for caching and for snapshot tests (ADR-0004).
 *
 * The ticking is a client behaviour, attached in M6 and corrected against
 * server time, because phone clocks are frequently wrong.
 */

const countdownProps = defineProps<{ heading: string; showSeconds: boolean }>({
  heading: { kind: 'text', default: '', maxLength: 80 },
  showSeconds: { kind: 'boolean', default: true },
});

type CountdownProps = typeof countdownProps.defaults;

const UNIT_LABELS: Record<'ar' | 'en', Record<string, string>> = {
  ar: { days: 'يوم', hours: 'ساعة', minutes: 'دقيقة', seconds: 'ثانية' },
  en: { days: 'Days', hours: 'Hours', minutes: 'Minutes', seconds: 'Seconds' },
};

/** The instant the client script counts toward. Empty when the date is unusable. */
function targetInstant(content: SectionRenderProps<CountdownProps>['content']): string {
  const parsed = EventDateTime.create({
    date: content.wedding.date,
    startTime: content.wedding.startTime,
    timezone: content.wedding.timezone,
  });
  return parsed.ok ? parsed.value.toInstant().toISOString() : '';
}

function units(props: CountdownProps): readonly string[] {
  return props.showSeconds ? ['days', 'hours', 'minutes', 'seconds'] : ['days', 'hours', 'minutes'];
}

function Shell({
  renderProps,
  variantClass,
}: {
  renderProps: SectionRenderProps<CountdownProps>;
  variantClass: string;
}): ReactElement {
  const { props, content, locale, sectionId } = renderProps;
  const labels = UNIT_LABELS[locale];

  return (
    <SectionShell sectionId={sectionId} variantClass={variantClass}>
      {props.heading ? <h2 className="zf-countdown__heading">{props.heading}</h2> : null}
      <div
        className="zf-countdown__units"
        data-countdown-target={targetInstant(content)}
        data-countdown-timezone={content.wedding.timezone}
        role="timer"
        aria-live="off"
        style={{ direction: 'ltr' }}
      >
        {units(props).map((unit) => (
          <div className="zf-countdown__unit" key={unit}>
            {/* Placeholder until the client script starts; never a computed value. */}
            <span className="zf-countdown__value" data-countdown-unit={unit}>
              --
            </span>
            <span className="zf-countdown__label">{labels[unit]}</span>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function OrnateBoxes(renderProps: SectionRenderProps<CountdownProps>): ReactElement {
  return <Shell renderProps={renderProps} variantClass="zf-countdown zf-countdown--ornate" />;
}

function MinimalDigits(renderProps: SectionRenderProps<CountdownProps>): ReactElement {
  return <Shell renderProps={renderProps} variantClass="zf-countdown zf-countdown--minimal" />;
}

function CircularRings(renderProps: SectionRenderProps<CountdownProps>): ReactElement {
  return <Shell renderProps={renderProps} variantClass="zf-countdown zf-countdown--rings" />;
}

const editor = [
  { key: 'heading', kind: 'text' as const, labelKey: 'countdown.heading', max: 80 },
  { key: 'showSeconds', kind: 'boolean' as const, labelKey: 'countdown.showSeconds' },
];

const shared = {
  type: 'countdown' as const,
  propsSchema: countdownProps,
  editor,
  capabilities: { interactive: true },
  a11y: { headingLevel: 2 as const },
};

export const countdownVariants: readonly SectionVariantDefinition<CountdownProps>[] = [
  { ...shared, id: 'countdown.ornateBoxes', Component: OrnateBoxes },
  { ...shared, id: 'countdown.minimalDigits', Component: MinimalDigits },
  { ...shared, id: 'countdown.circularRings', Component: CircularRings },
];
