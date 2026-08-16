import { z } from 'zod';

import { FontKeySchema, ThemeSchema } from './theme.js';
import { SectionInstanceSchema, SectionTypeSchema, REQUIRED_SECTION_TYPES } from './section.js';

/**
 * Template manifest (ADR-0004).
 *
 * A manifest is **untrusted data**. It may eventually arrive from an external
 * designer through the marketplace, so it carries no executable code, no
 * expressions and no external URLs — only values drawn from closed sets or
 * matched against strict patterns.
 *
 * This is what makes the marketplace possible at all: a designer can change how
 * an invitation looks without being able to run anything on our servers or in a
 * guest's browser.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

/** Asset keys reference our own registry; arbitrary URLs are never accepted. */
const AssetKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Must be an asset key');

export const TemplateManifestSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    key: z.string().regex(/^[a-z][a-z0-9-]{1,48}$/, 'Must be a lowercase template key'),
    version: z.number().int().positive(),

    meta: z
      .object({
        name: z.record(z.enum(['ar', 'en']), z.string().min(1).max(80)),
        description: z.record(z.enum(['ar', 'en']), z.string().max(500)),
        category: z.enum(['classic', 'modern', 'floral', 'traditional', 'minimal']),
        author: z.string().min(1).max(120),
        previewImage: AssetKeySchema,
        /** 0 = free, 1 = basic, 2 = premium. Compared, never branched on by name. */
        requiredPlanLevel: z.number().int().min(0).max(9),
        supportedLocales: z.array(z.enum(['ar', 'en'])).min(1),
      })
      .strict(),

    theme: ThemeSchema,

    customizable: z
      .object({
        colors: z.array(z.string().min(1).max(40)).max(8),
        fonts: z.boolean(),
        /** Restricting the choices keeps a template from being ruined by hand. */
        fontOptions: z.array(FontKeySchema).max(9).optional(),
        spacing: z.boolean(),
        motion: z.boolean(),
        sectionOrder: z.boolean(),
      })
      .strict(),

    sections: z
      .array(
        SectionInstanceSchema.innerType()
          .extend({ required: z.boolean().default(false) })
          .strict(),
      )
      .min(1)
      .max(30),

    assets: z
      .object({
        ornaments: z.array(AssetKeySchema).max(30),
        patterns: z.array(AssetKeySchema).max(30),
        fontSubsets: z.array(z.string().max(64)).max(10),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    // Every template must be able to open and close.
    for (const required of REQUIRED_SECTION_TYPES) {
      if (!manifest.sections.some((section) => section.type === required)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections'],
          message: `A manifest must include a "${required}" section`,
        });
      }
    }

    const ids = new Set<string>();
    for (const [index, section] of manifest.sections.entries()) {
      if (ids.has(section.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections', index, 'id'],
          message: `Duplicate section id "${section.id}"`,
        });
      }
      ids.add(section.id);

      if (!section.variant.startsWith(`${section.type}.`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections', index, 'variant'],
          message: 'variant must belong to the declared section type',
        });
      }
    }

    if (manifest.customizable.fontOptions && !manifest.customizable.fonts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customizable', 'fontOptions'],
        message: 'fontOptions is meaningless when fonts are not customizable',
      });
    }

    for (const locale of manifest.meta.supportedLocales) {
      if (!manifest.meta.name[locale]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['meta', 'name', locale],
          message: `Missing name for supported locale "${locale}"`,
        });
      }
    }
  });

export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;

export type ManifestValidationError = { readonly path: string; readonly message: string };

/** Manifests larger than this are rejected outright as a denial-of-service guard. */
export const MAX_MANIFEST_BYTES = 128 * 1024;

/**
 * Parses a manifest from untrusted input.
 *
 * Rejects prototype-pollution keys before Zod runs: `JSON.parse` will happily
 * produce a `__proto__` key, and a later spread of that object is how config
 * data turns into a code path.
 */
export function parseManifest(
  input: unknown,
): { ok: true; manifest: TemplateManifest } | { ok: false; errors: ManifestValidationError[] } {
  if (typeof input === 'string' && input.length > MAX_MANIFEST_BYTES) {
    return { ok: false, errors: [{ path: '(root)', message: 'Manifest exceeds the size limit' }] };
  }

  const candidate = typeof input === 'string' ? safeJsonParse(input) : input;
  if (candidate === undefined) {
    return { ok: false, errors: [{ path: '(root)', message: 'Manifest is not valid JSON' }] };
  }

  const polluted = findPrototypePollution(candidate);
  if (polluted) {
    return {
      ok: false,
      errors: [{ path: polluted, message: 'Manifest contains a forbidden key' }],
    };
  }

  const parsed = TemplateManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    };
  }
  return { ok: true, manifest: parsed.data };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function findPrototypePollution(value: unknown, path = '(root)'): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findPrototypePollution(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) return `${path}.${key}`;
    const found = findPrototypePollution((value as Record<string, unknown>)[key], `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

/** Identifies a specific published version of a template. */
export interface TemplateRef {
  readonly key: string;
  readonly version: number;
}

export function templateRefEquals(a: TemplateRef, b: TemplateRef): boolean {
  return a.key === b.key && a.version === b.version;
}

export { SectionTypeSchema };
