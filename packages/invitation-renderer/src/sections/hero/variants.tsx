import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { Divider, Picture, SectionShell, coupleNames, formatEventDate } from '../shared.js';

/**
 * Hero variants.
 *
 * Three genuinely different openings, so the three templates in M3 can look
 * unlike one another without any of them needing renderer changes.
 */

const heroProps = defineProps<{
  showDate: boolean;
  useShortName: boolean;
  eyebrow: string;
  overlay: boolean;
}>({
  showDate: { kind: 'boolean', default: true },
  useShortName: { kind: 'boolean', default: false },
  eyebrow: { kind: 'text', default: '', maxLength: 60 },
  overlay: { kind: 'boolean', default: true },
});

type HeroProps = typeof heroProps.defaults;

function HeroText({ props, content, theme, locale }: SectionRenderProps<HeroProps>): ReactElement {
  return (
    <>
      {props.eyebrow ? <p className="zf-hero__eyebrow">{props.eyebrow}</p> : null}
      <h1 className="zf-hero__names">{coupleNames(content, props.useShortName)}</h1>
      {props.showDate ? (
        <p className="zf-hero__date">
          {formatEventDate(content.wedding.date, content.wedding.timezone, locale, theme.numerals)}
        </p>
      ) : null}
    </>
  );
}

/** Centred, framed by an arch ornament. The classic wedding opening. */
function CenteredArch(renderProps: SectionRenderProps<HeroProps>): ReactElement {
  const { content, sectionId } = renderProps;
  return (
    <SectionShell sectionId={sectionId} variantClass="zf-hero zf-hero--arch" landmark="banner">
      <div className="zf-hero__arch" aria-hidden="true" />
      {content.cover ? (
        <Picture image={content.cover} className="zf-hero__cover" priority sizes="100vw" />
      ) : null}
      <div className="zf-hero__body">
        <HeroText {...renderProps} />
        <Divider />
      </div>
    </SectionShell>
  );
}

/** A full-bleed photograph with the names laid over it. */
function FullBleedPhoto(renderProps: SectionRenderProps<HeroProps>): ReactElement {
  const { content, props, sectionId } = renderProps;
  return (
    <SectionShell sectionId={sectionId} variantClass="zf-hero zf-hero--fullbleed" landmark="banner">
      {content.cover ? (
        <Picture image={content.cover} className="zf-hero__bleed" priority sizes="100vw" />
      ) : null}
      {props.overlay ? <div className="zf-hero__scrim" aria-hidden="true" /> : null}
      <div className="zf-hero__body zf-hero__body--over">
        <HeroText {...renderProps} />
      </div>
    </SectionShell>
  );
}

/**
 * Typography only — no photograph at all.
 *
 * Not merely a stylistic option: some families do not want personal photographs
 * on a public link, and a template that works without them is the honest answer
 * to that (docs/18-risks.md L6).
 */
function Typographic(renderProps: SectionRenderProps<HeroProps>): ReactElement {
  const { sectionId } = renderProps;
  return (
    <SectionShell
      sectionId={sectionId}
      variantClass="zf-hero zf-hero--typographic"
      landmark="banner"
    >
      <div className="zf-hero__body">
        <HeroText {...renderProps} />
      </div>
    </SectionShell>
  );
}

/** Names sealed behind a wax stamp, revealed on open. */
function WaxSeal(renderProps: SectionRenderProps<HeroProps>): ReactElement {
  const { content, props, sectionId } = renderProps;
  return (
    <SectionShell sectionId={sectionId} variantClass="zf-hero zf-hero--seal" landmark="banner">
      <div className="zf-hero__seal" aria-hidden="true">
        <span className="zf-hero__seal-mark">
          {props.useShortName && content.couple.shortName
            ? content.couple.shortName
            : `${content.couple.groomName.charAt(0)} ${content.couple.brideName.charAt(0)}`}
        </span>
      </div>
      <div className="zf-hero__body">
        <HeroText {...renderProps} />
        <Divider />
      </div>
    </SectionShell>
  );
}

const editor = [
  { key: 'eyebrow', kind: 'text' as const, labelKey: 'hero.eyebrow', max: 60 },
  { key: 'showDate', kind: 'boolean' as const, labelKey: 'hero.showDate' },
  { key: 'useShortName', kind: 'boolean' as const, labelKey: 'hero.useShortName' },
];

export const heroVariants: readonly SectionVariantDefinition<HeroProps>[] = [
  {
    id: 'hero.centeredArch',
    type: 'hero',
    propsSchema: heroProps,
    Component: CenteredArch,
    editor,
    capabilities: { needsMedia: ['cover'], aboveTheFold: true },
    a11y: { landmark: 'banner', headingLevel: 1 },
  },
  {
    id: 'hero.fullBleedPhoto',
    type: 'hero',
    propsSchema: heroProps,
    Component: FullBleedPhoto,
    editor: [...editor, { key: 'overlay', kind: 'boolean', labelKey: 'hero.overlay' }],
    capabilities: { needsMedia: ['cover'], aboveTheFold: true },
    a11y: { landmark: 'banner', headingLevel: 1 },
  },
  {
    id: 'hero.typographic',
    type: 'hero',
    propsSchema: heroProps,
    Component: Typographic,
    editor,
    // No media at all — the point of this variant.
    capabilities: { aboveTheFold: true },
    a11y: { landmark: 'banner', headingLevel: 1 },
  },
  {
    id: 'hero.waxSeal',
    type: 'hero',
    propsSchema: heroProps,
    Component: WaxSeal,
    editor,
    capabilities: { aboveTheFold: true, heavyAnimation: true },
    a11y: { landmark: 'banner', headingLevel: 1 },
  },
];
