import { z } from 'zod';

/**
 * Section identity (ADR-0004).
 *
 * Section *types* are a closed set: adding one is a considered decision that
 * needs space in the editor and the data model. Section *variants* are open:
 * they are how the visual vocabulary grows, and a new variant becomes available
 * to every template at once rather than being cloned per template.
 */

export const SECTION_TYPES = [
  'hero',
  'couple',
  'countdown',
  'events',
  'location',
  'gallery',
  'story',
  'rsvp',
  'message',
  'music',
  'footer',
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];
export const SectionTypeSchema = z.enum(SECTION_TYPES);

/** `hero.waxSeal` — the type, then the variant within it. */
export const VariantIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/, 'Must be of the form "type.variantName"');

/**
 * Section props.
 *
 * Validated in depth by the variant's own schema in the renderer registry (M3).
 * Here the contract is only that props are plain JSON: bounded, and free of the
 * prototype-pollution keys that turn a config object into a code path.
 */
const JsonPrimitive = z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const SectionPropsSchema = z
  .record(z.union([JsonPrimitive, z.array(JsonPrimitive).max(50)]))
  .refine((props) => Object.keys(props).every((key) => !FORBIDDEN_KEYS.has(key)), {
    message: 'Props must not contain prototype-pollution keys',
  })
  .refine((props) => Object.keys(props).length <= 40, {
    message: 'A section may not declare more than 40 props',
  });

export const SectionInstanceSchema = z
  .object({
    /** Stable across reordering, so edits target the right section. */
    id: z.string().min(1).max(64),
    type: SectionTypeSchema,
    variant: VariantIdSchema,
    enabled: z.boolean(),
    order: z.number().int().min(0).max(1000),
    props: SectionPropsSchema.default({}),
  })
  .strict()
  .refine((section) => section.variant.startsWith(`${section.type}.`), {
    message: 'variant must belong to the declared section type',
    path: ['variant'],
  });

export type SectionInstance = z.infer<typeof SectionInstanceSchema>;

/** Sections a template must always include; the builder cannot disable them. */
export const REQUIRED_SECTION_TYPES: ReadonlySet<SectionType> = new Set(['hero', 'footer']);

export function isRequiredSection(type: SectionType): boolean {
  return REQUIRED_SECTION_TYPES.has(type);
}

/**
 * Orders sections for rendering.
 *
 * Ties break on id so the output is deterministic — the renderer must produce
 * identical HTML for identical input (ADR-0004).
 */
export function sortSections(sections: readonly SectionInstance[]): SectionInstance[] {
  return [...sections].sort((a, b) =>
    a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order,
  );
}

export function enabledSections(sections: readonly SectionInstance[]): SectionInstance[] {
  return sortSections(sections.filter((section) => section.enabled));
}
