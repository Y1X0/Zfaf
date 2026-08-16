import type { ComponentType } from 'react';

import { type PublishedSnapshot, type SectionInstance, enabledSections } from '@zfaf/core';

import { defaultRegistry } from '../registry/default-registry.js';
import type { SectionRegistry } from '../registry/registry.js';
import type { RenderContent, SectionRenderProps } from '../registry/types.js';

/**
 * Deciding *what* to draw, separately from *how* the result is contained.
 *
 * Two render paths exist and they cannot be collapsed into one:
 *
 *   • The **builder preview** renders a React tree that is hydrated, so a
 *     failing section is contained by a class error boundary inside Suspense.
 *   • The **published page** renders to HTML with no hydration at all
 *     (ADR-0020). A class component is not permitted in that module graph, and
 *     it would be pointless there anyway — nothing hydrates, so nothing needs
 *     a boundary that survives into the browser. It contains failures with an
 *     ordinary `try`/`catch` around each section instead.
 *
 * That difference is forced by the environment, and it is *only* about
 * containment. Everything that decides what a guest sees — which sections are
 * enabled, in what order, which variant, which props after validation, what
 * happens to an unknown variant — is decided here, once, for both. ADR-0004's
 * promise is that preview and published agree, and this module is where that
 * promise is kept.
 */

export interface ResolvedSection {
  readonly section: SectionInstance;
  readonly variantId: string;
  readonly Component: ComponentType<SectionRenderProps<Record<string, unknown>>>;
  readonly renderProps: SectionRenderProps<Record<string, unknown>>;
}

export interface SectionDiagnostic {
  readonly sectionId: string;
  readonly variant: string;
  readonly reason: 'UNKNOWN_VARIANT' | 'INVALID_PROPS' | 'FALLBACK_USED';
  readonly detail?: string;
}

export interface ResolveSectionsOptions {
  readonly mode?: 'preview' | 'published';
  readonly registry?: SectionRegistry;
  /** Where a form section posts. Absent in preview, where nothing submits. */
  readonly formAction?: string | undefined;
  /** The outcome of a form post the guest was redirected back from. */
  readonly formStatus?: SectionRenderProps['formStatus'];
}

export function resolveSections(
  snapshot: PublishedSnapshot,
  options: ResolveSectionsOptions = {},
): { sections: ResolvedSection[]; diagnostics: SectionDiagnostic[] } {
  const registry = options.registry ?? defaultRegistry;
  const mode = options.mode ?? 'published';
  const diagnostics: SectionDiagnostic[] = [];

  const content = snapshot.content as unknown as RenderContent;
  const dir = snapshot.locale === 'ar' ? 'rtl' : 'ltr';

  // Ordering is resolved by the domain, so preview and published agree and ties
  // break deterministically.
  const ordered = enabledSections(snapshot.sections as unknown as SectionInstance[]);

  const sections = ordered.flatMap((section, index): ResolvedSection[] => {
    let definition = registry.get(section.variant);

    if (!definition) {
      // A manifest naming an unknown variant is data we do not understand — it
      // is never executed. Fall back to another variant of the same type so the
      // invitation keeps its structure.
      const fallback = registry.fallbackForType(section.type);
      diagnostics.push({
        sectionId: section.id,
        variant: section.variant,
        reason: 'UNKNOWN_VARIANT',
        detail: fallback ? `fell back to ${fallback.id}` : 'no fallback available',
      });
      if (!fallback) return [];
      definition = fallback;
    }

    const parsed = definition.propsSchema.parse(section.props);
    const props = parsed.ok ? parsed.value : definition.propsSchema.defaults;

    if (!parsed.ok) {
      // Malformed props degrade to the defaults rather than failing the render.
      diagnostics.push({
        sectionId: section.id,
        variant: definition.id,
        reason: 'INVALID_PROPS',
        detail: parsed.issues.join('; '),
      });
    }

    return [
      {
        section,
        variantId: definition.id,
        Component: definition.Component as ComponentType<
          SectionRenderProps<Record<string, unknown>>
        >,
        renderProps: {
          props,
          content,
          theme: snapshot.theme,
          locale: snapshot.locale,
          dir,
          mode,
          index,
          sectionId: section.id,
          formAction: options.formAction,
          formStatus: options.formStatus,
        },
      },
    ];
  });

  return { sections, diagnostics };
}
