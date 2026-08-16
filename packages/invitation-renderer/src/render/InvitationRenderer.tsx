import { Suspense, type ReactElement } from 'react';

import type { PublishedSnapshot } from '@zfaf/core';

import type { SectionRegistry } from '../registry/registry.js';
import { themeToStyleSheet } from '../theme/to-css-variables.js';
import { BASE_STYLESHEET } from '../theme/base-stylesheet.js';
import { SectionBoundary } from './SectionBoundary.js';
import { resolveSections } from './resolve-sections.js';

/**
 * The invitation renderer (ADR-0004).
 *
 * One renderer serves both the builder preview and the published page. That is
 * not a convenience — it is what makes "what you see is what gets published"
 * true rather than approximately true, and it removes the whole category of
 * bugs where a preview quietly disagrees with the result.
 *
 * Three properties are load-bearing:
 *
 *   • **Deterministic.** No clock, no randomness, no I/O. The same document
 *     always produces byte-identical markup, which is what makes CDN caching
 *     and snapshot testing meaningful.
 *   • **Generic.** It never names a template or a section. Everything specific
 *     comes from the manifest (data) or the registry (capability), so adding a
 *     template cannot require changes here.
 *   • **Fail-soft.** A section that cannot render is skipped; the invitation
 *     still shows. Guests seeing a partly rendered page is bad; seeing a blank
 *     one the night of a wedding is unrecoverable.
 */

export interface RenderOptions {
  /**
   * Preview may show placeholders where published output omits a section. It
   * must never change layout or styling, or the guarantee above is void.
   */
  readonly mode?: 'preview' | 'published';
  /** Injected for testing; production uses the default registry. */
  readonly registry?: SectionRegistry;
  /** Nonce for the inline style element, matching the page's CSP. */
  readonly styleNonce?: string;
}

export interface InvitationRendererProps extends RenderOptions {
  readonly snapshot: PublishedSnapshot;
}

/** Diagnostics for the builder. Never shown to a guest. */
export interface RenderDiagnostic {
  readonly sectionId: string;
  readonly variant: string;
  readonly reason: 'UNKNOWN_VARIANT' | 'INVALID_PROPS' | 'FALLBACK_USED';
  readonly detail?: string;
}

export function renderSections(
  snapshot: PublishedSnapshot,
  options: RenderOptions = {},
): { elements: ReactElement[]; diagnostics: RenderDiagnostic[] } {
  // What to draw is decided in one place, shared with the published path, so
  // the two cannot disagree about ordering, variants or props (ADR-0004).
  const { sections, diagnostics } = resolveSections(snapshot, options);

  const elements = sections.map(({ section, variantId, Component, renderProps }) => (
    // The Suspense boundary is load-bearing, not decorative. During server
    // rendering React only lets an error boundary contain a throw when the
    // failing subtree sits inside a Suspense boundary; without it the whole
    // document render rejects and a guest gets nothing. Verified by
    // "a section whose component throws does not take the page down".
    <Suspense key={section.id} fallback={null}>
      <SectionBoundary sectionId={section.id} variant={variantId}>
        <Component {...renderProps} />
      </SectionBoundary>
    </Suspense>
  ));

  return { elements, diagnostics };
}

/**
 * Renders a published snapshot.
 *
 * The theme is emitted as CSS custom properties in a single inline `<style>`:
 * no extra request, no flash of unstyled colour, and changing a colour in the
 * builder is one variable update rather than a React re-render.
 */
export function InvitationRenderer({
  snapshot,
  ...options
}: InvitationRendererProps): ReactElement {
  const { elements } = renderSections(snapshot, options);
  const dir = snapshot.locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <div
      className="zf-invitation"
      dir={dir}
      lang={snapshot.locale}
      data-template={snapshot.templateKey}
    >
      <style {...(options.styleNonce ? { nonce: options.styleNonce } : {})}>
        {`${themeToStyleSheet(snapshot.theme)}${BASE_STYLESHEET}`}
      </style>
      <main className="zf-invitation__main">{elements}</main>
    </div>
  );
}
