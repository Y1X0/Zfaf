import {
  REQUIRED_SECTION_TYPES,
  type TemplateManifest,
  checkThemeContrast,
  parseManifest,
} from '@zfaf/core';

import { defaultRegistry } from '../registry/default-registry.js';
import type { SectionRegistry } from '../registry/registry.js';

/**
 * Manifest validation.
 *
 * Runs before a template can be published, so a broken manifest is caught while
 * a person is present to fix it rather than in front of guests. It checks two
 * things the schema alone cannot: that every variant a manifest names actually
 * exists in the registry, and that the declared props satisfy that variant.
 */

export interface ManifestIssue {
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

export interface ManifestValidationResult {
  readonly ok: boolean;
  readonly manifest: TemplateManifest | null;
  readonly issues: readonly ManifestIssue[];
}

export function validateManifest(
  input: unknown,
  registry: SectionRegistry = defaultRegistry,
): ManifestValidationResult {
  const parsed = parseManifest(input);
  if (!parsed.ok) {
    return {
      ok: false,
      manifest: null,
      issues: parsed.errors.map((error) => ({
        path: error.path,
        message: error.message,
        severity: 'error' as const,
      })),
    };
  }

  const manifest = parsed.manifest;
  const issues: ManifestIssue[] = [];

  for (const [index, section] of manifest.sections.entries()) {
    const definition = registry.get(section.variant);

    if (!definition) {
      // The core rule: a manifest may only name capabilities that exist. This
      // is what stops a manifest from being a way to introduce behaviour.
      issues.push({
        path: `sections[${index}].variant`,
        message: `Unknown variant "${section.variant}". Available for this type: ${
          registry.idsForType(section.type).join(', ') || 'none'
        }`,
        severity: 'error',
      });
      continue;
    }

    if (definition.type !== section.type) {
      issues.push({
        path: `sections[${index}].variant`,
        message: `Variant "${section.variant}" belongs to section type "${definition.type}"`,
        severity: 'error',
      });
    }

    const props = definition.propsSchema.parse(section.props);
    if (!props.ok) {
      issues.push({
        path: `sections[${index}].props`,
        message: props.issues.join('; '),
        severity: 'error',
      });
    }

    if (section.required && !section.enabled) {
      issues.push({
        path: `sections[${index}]`,
        message: 'A required section cannot be disabled',
        severity: 'error',
      });
    }
  }

  for (const required of REQUIRED_SECTION_TYPES) {
    if (!manifest.sections.some((section) => section.type === required)) {
      issues.push({
        path: 'sections',
        message: `Missing required section type "${required}"`,
        severity: 'error',
      });
    }
  }

  // Contrast is a warning, not an error: the renderer's accessibility guard
  // corrects it at render time, and refusing a designer's palette outright is
  // worse than telling them (docs/05-template-engine.md §6).
  for (const warning of checkThemeContrast(manifest.theme)) {
    issues.push({
      path: `theme.colors (${warning.pair})`,
      message: `Contrast ${warning.ratio}:1 is below the required ${warning.required}:1`,
      severity: 'warning',
    });
  }

  const errors = issues.filter((issue) => issue.severity === 'error');
  return { ok: errors.length === 0, manifest: errors.length === 0 ? manifest : null, issues };
}
