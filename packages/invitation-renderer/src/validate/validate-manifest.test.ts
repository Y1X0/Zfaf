import { describe, expect, it } from 'vitest';

import { SectionRegistry } from '../registry/registry.js';
import { defineProps } from '../registry/schema.js';
import type { SectionVariantDefinition } from '../registry/types.js';
import { TEMPLATE_KEYS, manifestFor } from '../testing/snapshot-fixture.js';
import { validateManifest } from './validate-manifest.js';

/**
 * Manifest validation.
 *
 * Validation runs before a template can be published, so a broken manifest is
 * caught while someone is present to fix it. These tests are written by
 * mutating a *shipped* manifest one field at a time: each failure therefore
 * isolates one rule, and a passing test says something about a template we
 * actually ship rather than about a fixture.
 */

/** A shipped manifest with one edit applied. Clones first — no shared state. */
function mutated(
  templateKey: string,
  mutate: (manifest: Record<string, unknown>) => void,
): Record<string, unknown> {
  const manifest = JSON.parse(JSON.stringify(manifestFor(templateKey)));
  mutate(manifest);
  return manifest;
}

function sectionsOf(manifest: Record<string, unknown>): Record<string, unknown>[] {
  return manifest['sections'] as Record<string, unknown>[];
}

function messages(input: unknown): string {
  return validateManifest(input)
    .issues.map((issue) => `${issue.path}: ${issue.message}`)
    .join(' | ');
}

// ── the shipped templates ──────────────────────────────────────────────────

describe('the shipped manifests', () => {
  it.each(TEMPLATE_KEYS)('%s validates against the registry', (templateKey) => {
    const result = validateManifest(manifestFor(templateKey));
    expect(result.ok, messages(manifestFor(templateKey))).toBe(true);
    expect(result.manifest).not.toBeNull();
    expect(result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it.each(TEMPLATE_KEYS)('%s carries no contrast warning', (templateKey) => {
    // A warning here would still publish, but it means we shipped a palette a
    // guest with low vision cannot read.
    const result = validateManifest(manifestFor(templateKey));
    expect(result.issues.filter((issue) => issue.severity === 'warning')).toHaveLength(0);
  });

  it('returns the parsed manifest, not the raw input', () => {
    const result = validateManifest(manifestFor('classic-luxury'));
    expect(result.manifest?.key).toBe('classic-luxury');
    expect(result.manifest?.schemaVersion).toBe(1);
    // Defaults are applied by the schema, so downstream code never branches on
    // an absent field.
    expect(typeof result.manifest?.sections[0]?.required).toBe('boolean');
  });
});

// ── schema-level rejection ─────────────────────────────────────────────────

describe('a manifest with an invalid envelope is rejected', () => {
  it('rejects an unsupported schema version', () => {
    expect(validateManifest(mutated('classic-luxury', (m) => (m['schemaVersion'] = 2))).ok).toBe(
      false,
    );
    expect(validateManifest(mutated('classic-luxury', (m) => delete m['schemaVersion'])).ok).toBe(
      false,
    );
  });

  it('rejects a non-positive or non-integer template version', () => {
    for (const version of [0, -1, 1.5, '1', null]) {
      expect(
        validateManifest(mutated('classic-luxury', (m) => (m['version'] = version))).ok,
        `version ${String(version)}`,
      ).toBe(false);
    }
  });

  it('rejects a template key that is not a lowercase slug', () => {
    for (const key of ['Classic-Luxury', 'classic luxury', 'x', '../etc/passwd', '']) {
      expect(
        validateManifest(mutated('classic-luxury', (m) => (m['key'] = key))).ok,
        `key "${key}"`,
      ).toBe(false);
    }
  });

  it('rejects an unknown top-level field', () => {
    // `.strict()` throughout: an unrecognised key is a hard failure, never a
    // silently ignored one. That is what stops a manifest carrying a payload
    // for some future version of the renderer.
    expect(
      validateManifest(mutated('classic-luxury', (m) => (m['scripts'] = ['alert(1)']))).ok,
    ).toBe(false);
  });

  it('rejects a manifest that is missing a whole block', () => {
    for (const block of ['meta', 'theme', 'customizable', 'sections', 'assets']) {
      expect(
        validateManifest(mutated('classic-luxury', (m) => delete m[block])).ok,
        `missing ${block}`,
      ).toBe(false);
    }
  });
});

// ── theme ──────────────────────────────────────────────────────────────────

describe('an invalid theme is rejected', () => {
  it('rejects a colour that is not a hex or rgb() value', () => {
    for (const colour of ['red', 'var(--x)', '#ggg', 'rgb(1,2,3);', '']) {
      expect(
        validateManifest(
          mutated('classic-luxury', (m) => {
            (
              (m['theme'] as Record<string, Record<string, unknown>>)['colors'] as Record<
                string,
                unknown
              >
            )['primary'] = colour;
          }),
        ).ok,
        `colour "${colour}"`,
      ).toBe(false);
    }
  });

  it('rejects a font that is not in the registry', () => {
    expect(
      validateManifest(
        mutated('classic-luxury', (m) => {
          (
            (m['theme'] as Record<string, Record<string, unknown>>)['typography'] as Record<
              string,
              unknown
            >
          )['displayFont'] = 'Comic Sans';
        }),
      ).ok,
    ).toBe(false);
  });

  it('rejects a keyword outside its closed set', () => {
    for (const [field, value] of [
      ['spacing', 'enormous'],
      ['radius', '20px'],
      ['buttons', 'shiny'],
      ['dividers', 'sparkles'],
    ] as const) {
      expect(
        validateManifest(
          mutated(
            'classic-luxury',
            (m) => ((m['theme'] as Record<string, unknown>)[field] = value),
          ),
        ).ok,
        `${field} = ${value}`,
      ).toBe(false);
    }
  });

  it('reports low contrast as a warning, not an error', () => {
    // Refusing a designer's palette outright is worse product behaviour than
    // telling them and correcting it at render time (docs/05 §6).
    const result = validateManifest(
      mutated('classic-luxury', (m) => {
        const colors = (m['theme'] as Record<string, Record<string, unknown>>)['colors'] as Record<
          string,
          unknown
        >;
        colors['background'] = '#ffffff';
        colors['textPrimary'] = '#f2f2f2';
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.manifest).not.toBeNull();
    expect(result.issues.some((issue) => issue.severity === 'warning')).toBe(true);
    expect(result.issues.some((issue) => /Contrast/.test(issue.message))).toBe(true);
  });
});

// ── sections ───────────────────────────────────────────────────────────────

describe('section composition is checked against the registry', () => {
  it('rejects a variant that does not exist', () => {
    const result = validateManifest(
      mutated('classic-luxury', (m) => (sectionsOf(m)[0]!['variant'] = 'hero.invented')),
    );

    expect(result.ok).toBe(false);
    expect(result.manifest).toBeNull();
    const issue = result.issues.find((candidate) => candidate.path === 'sections[0].variant');
    expect(issue?.message).toContain('Unknown variant');
    // The message names what *is* available, so a designer can fix it without
    // reading our source.
    expect(issue?.message).toContain('hero.centeredArch');
  });

  it('rejects a variant belonging to another section type', () => {
    expect(
      validateManifest(
        mutated('classic-luxury', (m) => (sectionsOf(m)[0]!['variant'] = 'footer.minimal')),
      ).ok,
    ).toBe(false);
  });

  it('rejects an unknown section type', () => {
    expect(
      validateManifest(
        mutated('classic-luxury', (m) => {
          sectionsOf(m)[0]!['type'] = 'analytics';
          sectionsOf(m)[0]!['variant'] = 'analytics.beacon';
        }),
      ).ok,
    ).toBe(false);
  });

  it('rejects props the variant will not accept', () => {
    const result = validateManifest(
      mutated('classic-luxury', (m) => (sectionsOf(m)[0]!['props'] = { showDate: 'yes please' })),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path === 'sections[0].props')).toBe(true);
  });

  it('rejects a duplicate section id', () => {
    expect(
      validateManifest(
        mutated('classic-luxury', (m) => (sectionsOf(m)[1]!['id'] = sectionsOf(m)[0]!['id'])),
      ).ok,
    ).toBe(false);
  });

  it('rejects a manifest with no hero or no footer', () => {
    // Every invitation must be able to open and close, whatever else it omits.
    for (const type of ['hero', 'footer']) {
      const result = validateManifest(
        mutated('classic-luxury', (m) => {
          m['sections'] = sectionsOf(m).filter((section) => section['type'] !== type);
        }),
      );
      expect(result.ok, `without ${type}`).toBe(false);
    }
  });

  it('rejects a required section that is disabled', () => {
    const result = validateManifest(
      mutated('classic-luxury', (m) => {
        const hero = sectionsOf(m).find((section) => section['type'] === 'hero');
        if (hero) {
          hero['required'] = true;
          hero['enabled'] = false;
        }
      }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.issues.some((issue) => /required section cannot be disabled/.test(issue.message)),
    ).toBe(true);
  });

  it('rejects an empty section list', () => {
    expect(validateManifest(mutated('classic-luxury', (m) => (m['sections'] = []))).ok).toBe(false);
  });

  it('rejects more sections than a template may declare', () => {
    const result = validateManifest(
      mutated('classic-luxury', (m) => {
        const template = sectionsOf(m)[0] as Record<string, unknown>;
        m['sections'] = Array.from({ length: 31 }, (_, index) => ({
          ...template,
          id: `s${index}`,
          order: index,
        }));
      }),
    );
    expect(result.ok).toBe(false);
  });
});

// ── the registry is a parameter, not a global ──────────────────────────────

describe('validation is relative to the registry it is given', () => {
  it('accepts a manifest against a registry that has the variants', () => {
    // The same manifest is valid or invalid depending on what is registered.
    // That is the whole claim of ADR-0004: capability lives in code, and a
    // manifest can only name it.
    const full = validateManifest(manifestFor('minimal-white'));
    expect(full.ok).toBe(true);

    const empty = validateManifest(manifestFor('minimal-white'), new SectionRegistry());
    expect(empty.ok).toBe(false);
    expect(
      empty.issues.every((issue) => issue.severity === 'error' || issue.severity === 'warning'),
    ).toBe(true);
    expect(empty.issues.some((issue) => issue.message.includes('none'))).toBe(true);
  });

  it('accepts a variant registered only in a custom registry', () => {
    // Stubs rather than shipped definitions: the point is that validation
    // consults whatever registry it is handed, not that these ids are ours.
    const registry = new SectionRegistry();
    for (const id of ['hero.centeredArch', 'footer.minimal']) {
      registry.register(stubVariant(id));
    }

    const manifest = mutated('classic-luxury', (m) => {
      m['sections'] = [
        {
          id: 'hero',
          type: 'hero',
          variant: 'hero.centeredArch',
          enabled: true,
          order: 0,
          props: {},
        },
        {
          id: 'footer',
          type: 'footer',
          variant: 'footer.minimal',
          enabled: true,
          order: 1,
          props: {},
        },
      ];
    });

    expect(validateManifest(manifest, registry).ok).toBe(true);
  });
});

function stubVariant(id: string): SectionVariantDefinition<Record<string, unknown>> {
  const type = id.split('.')[0] as string;
  return {
    id,
    type,
    propsSchema: defineProps({}),
    Component: () => null,
    editor: [],
    capabilities: {},
    a11y: {},
  } as unknown as SectionVariantDefinition<Record<string, unknown>>;
}
