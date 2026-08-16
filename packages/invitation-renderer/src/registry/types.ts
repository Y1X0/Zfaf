import type { ComponentType } from 'react';
import type { SectionType, Theme } from '@zfaf/core';

/**
 * The section contract (ADR-0004).
 *
 * Every section component receives the same shape. That uniformity is what
 * makes the renderer generic: it never needs to know which section it is
 * rendering, so adding a template cannot require renderer changes.
 *
 * A section that needed anything beyond this contract would be a signal that
 * the abstraction is wrong — not an invitation to widen the props.
 */

/** Content resolved for rendering. Mirrors a published snapshot's `content`. */
export interface RenderContent {
  readonly couple: {
    readonly groomName: string;
    readonly brideName: string;
    readonly shortName: string | null;
    readonly message: string | null;
    readonly photo: ResolvedImage | null;
  };
  readonly wedding: {
    readonly date: string;
    readonly startTime: string | null;
    readonly endTime: string | null;
    readonly timezone: string;
  };
  readonly location: {
    readonly venueName: string | null;
    readonly address: string | null;
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly mapsUrl: string | null;
  };
  readonly events: readonly RenderEvent[];
  readonly cover: ResolvedImage | null;
  readonly gallery: readonly ResolvedImage[];
  readonly music: {
    readonly trackId: string | null;
    readonly url: string | null;
    readonly title: string | null;
    readonly attribution: string | null;
  };
  readonly rsvp: {
    readonly enabled: boolean;
    readonly deadline: string | null;
    readonly maxPartySize: number;
  };
}

export interface ResolvedImage {
  readonly id: string;
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly blurhash: string | null;
  readonly alt: string | null;
}

export interface RenderEvent {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description: string | null;
  readonly date: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly timezone: string;
  readonly venueName: string | null;
  readonly venueAddress: string | null;
  readonly mapsUrl: string | null;
  readonly sortOrder: number;
}

/**
 * Props every section component receives.
 *
 * Note the absence of anything the section could use to reach outside itself:
 * no repository, no fetch, no request context, no tenant identifier. A section
 * can only render what it was handed.
 */
export interface SectionRenderProps<P = Record<string, unknown>> {
  /** Validated against the variant's own schema before it arrives here. */
  readonly props: P;
  readonly content: RenderContent;
  /** Available for the rare case a value cannot be expressed as a CSS variable. */
  readonly theme: Theme;
  readonly locale: 'ar' | 'en';
  readonly dir: 'rtl' | 'ltr';
  /**
   * Preview may show placeholders where published output would omit a section.
   * It must never change layout, spacing or styling — otherwise "what you see
   * is what gets published" stops being true.
   */
  readonly mode: 'preview' | 'published';
  /** Position in the rendered order, for above-the-fold decisions. */
  readonly index: number;
  /** Stable per-section id, used for anchors and test hooks. */
  readonly sectionId: string;
  /**
   * Where the RSVP form posts, when it is rendered for a published invitation.
   *
   * Absent in preview, and absent for every section that does not submit
   * anything — a section still cannot reach outside itself, it is simply told
   * the one address it is allowed to name. Passing the invitation's *slug*
   * would be worse: the section would then be constructing a URL, which is
   * exactly the knowledge this contract keeps out of sections.
   */
  readonly formAction?: string | undefined;
  /**
   * The outcome of a form post the guest has just been redirected back from.
   *
   * Read from the query string by the caller. It exists because the public
   * page has no client framework to hold that state (ADR-0020), so a guest
   * with JavaScript disabled is told what happened by the server render.
   */
  readonly formStatus?: 'ok' | 'invalid' | 'closed' | 'rate' | 'check' | undefined;
}

/** Validates and normalises a variant's props. Pure — no I/O, no randomness. */
export interface PropsSchema<P> {
  parse(input: unknown): { ok: true; value: P } | { ok: false; issues: readonly string[] };
  readonly defaults: P;
}

/**
 * What the builder needs in order to expose a variant's props (M5).
 *
 * Declared alongside the variant so a new visual capability arrives with its
 * editor affordance rather than needing a second, separate change.
 */
export interface EditorField {
  readonly key: string;
  readonly kind: 'text' | 'longText' | 'boolean' | 'select' | 'number';
  readonly labelKey: string;
  readonly options?: readonly string[];
  readonly max?: number;
}

export interface VariantCapabilities {
  /** Media this variant uses. Lets the builder warn before a section renders empty. */
  readonly needsMedia?: readonly ('cover' | 'couple' | 'gallery')[];
  readonly needsEvents?: boolean;
  readonly needsLocation?: boolean;
  /** Disabled automatically on low-end devices (ADR-0010). */
  readonly heavyAnimation?: boolean;
  /** Affects image loading priority. */
  readonly aboveTheFold?: boolean;
  /** Needs client-side JavaScript once hydrated (M6). */
  readonly interactive?: boolean;
}

export interface SectionVariantDefinition<P = Record<string, unknown>> {
  /** `hero.centeredArch` — the type, then the variant within it. */
  readonly id: string;
  readonly type: SectionType;
  readonly propsSchema: PropsSchema<P>;
  readonly Component: ComponentType<SectionRenderProps<P>>;
  readonly editor: readonly EditorField[];
  readonly capabilities: VariantCapabilities;
  readonly a11y: {
    readonly landmark?: 'banner' | 'main' | 'contentinfo' | 'region';
    readonly headingLevel?: 1 | 2 | 3;
  };
}

/** Erases the props type so definitions of different shapes share one registry. */
export type AnyVariantDefinition = SectionVariantDefinition<never>;
