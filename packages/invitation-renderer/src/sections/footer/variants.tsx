import type { ReactElement } from 'react';

import { defineProps } from '../../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../../registry/types.js';
import { Divider, SectionShell, coupleNames } from '../shared.js';

const footerProps = defineProps<{ closingLine: string; showBranding: boolean }>({
  closingLine: { kind: 'text', default: '', maxLength: 160 },
  // The free plan's mark. It is the growth loop, not decoration
  // (docs/11-payments-architecture.md §5).
  showBranding: { kind: 'boolean', default: true },
});

type FooterProps = typeof footerProps.defaults;

function Branding({ locale }: { locale: 'ar' | 'en' }): ReactElement {
  return (
    <p className="zf-footer__branding">
      {locale === 'ar' ? 'أُنشئت عبر Zfaf' : 'Created with Zfaf'}
    </p>
  );
}

function Ornament({
  props,
  content,
  locale,
  sectionId,
}: SectionRenderProps<FooterProps>): ReactElement {
  return (
    <SectionShell
      sectionId={sectionId}
      variantClass="zf-footer zf-footer--ornament"
      landmark="contentinfo"
    >
      <Divider />
      <p className="zf-footer__names">{coupleNames(content, true)}</p>
      {props.closingLine ? <p className="zf-footer__closing">{props.closingLine}</p> : null}
      {props.showBranding ? <Branding locale={locale} /> : null}
    </SectionShell>
  );
}

function Minimal({
  props,
  content,
  locale,
  sectionId,
}: SectionRenderProps<FooterProps>): ReactElement {
  return (
    <SectionShell
      sectionId={sectionId}
      variantClass="zf-footer zf-footer--minimal"
      landmark="contentinfo"
    >
      {props.closingLine ? <p className="zf-footer__closing">{props.closingLine}</p> : null}
      <p className="zf-footer__names">{coupleNames(content, true)}</p>
      {props.showBranding ? <Branding locale={locale} /> : null}
    </SectionShell>
  );
}

const editor = [
  { key: 'closingLine', kind: 'text' as const, labelKey: 'footer.closingLine', max: 160 },
  { key: 'showBranding', kind: 'boolean' as const, labelKey: 'footer.showBranding' },
];

const shared = {
  type: 'footer' as const,
  propsSchema: footerProps,
  editor,
  capabilities: {},
  a11y: { landmark: 'contentinfo' as const },
};

export const footerVariants: readonly SectionVariantDefinition<FooterProps>[] = [
  { ...shared, id: 'footer.ornament', Component: Ornament },
  { ...shared, id: 'footer.minimal', Component: Minimal },
];
