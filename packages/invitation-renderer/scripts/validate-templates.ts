import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultRegistry } from '../src/registry/default-registry.js';
import { validateManifest } from '../src/validate/validate-manifest.js';

/**
 * Validates every shipped template.
 *
 * Run in CI. A manifest that names a variant the registry does not provide is
 * rejected here — which is the mechanism that keeps templates data rather than
 * code, and keeps an unknown variant from ever reaching a guest's browser.
 */

const templatesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../templates');
let failed = 0;

console.warn(`Registry provides ${defaultRegistry.size()} section variants\n`);

for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const manifestPath = join(templatesDir, entry.name, 'manifest.json');
  const result = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

  const errors = result.issues.filter((issue) => issue.severity === 'error');
  const warnings = result.issues.filter((issue) => issue.severity === 'warning');

  if (result.ok) {
    console.warn(`  ✓ ${entry.name}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${entry.name}`);
  }

  for (const issue of errors) console.error(`      error  ${issue.path}: ${issue.message}`);
  for (const issue of warnings) console.warn(`      warn   ${issue.path}: ${issue.message}`);
}

if (failed > 0) {
  console.error(`\n✗ ${failed} template(s) failed validation`);
  process.exitCode = 1;
} else {
  console.warn('\n✓ All templates valid');
}
