import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Architectural invariants, asserted against the source itself.
 *
 * These are the claims that a behavioural test cannot make. "The renderer
 * contains no template-specific code" is not a property of any one render — it
 * is a property of the source, and the only honest way to assert it is to read
 * the source.
 *
 * They exist because the failure they guard against is gradual: the first
 * `if (templateKey === …)` always looks reasonable, and by the fifth the
 * template engine has become three hard-coded pages.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = join(packageRoot, 'src');

/** Every non-test source file the renderer ships. */
function productionSources(): { path: string; source: string }[] {
  const files: { path: string; source: string }[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        // `testing/` holds fixtures, which legitimately read manifests.
        if (entry.name !== 'testing') walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      files.push({ path: relative(packageRoot, full), source: readFileSync(full, 'utf8') });
    }
  };

  walk(sourceRoot);
  return files;
}

const SOURCES = productionSources();

/** The templates M3 ships. None of them may be named in renderer source. */
const TEMPLATE_KEYS = ['classic-luxury', 'royal-gold', 'minimal-white'] as const;

describe('the source has files to check', () => {
  it('found the renderer sources', () => {
    // A guard on the guards: a broken path would make every test below pass
    // vacuously, which is worse than no test at all.
    expect(SOURCES.length).toBeGreaterThan(15);
    expect(SOURCES.some((file) => file.path.endsWith('render/InvitationRenderer.tsx'))).toBe(true);
    expect(SOURCES.some((file) => file.path.includes('testing/'))).toBe(false);
  });
});

describe('no template is special-cased', () => {
  it.each(TEMPLATE_KEYS)('no source file mentions "%s"', (templateKey) => {
    // The M3 acceptance criterion, stated literally: the third template had to
    // compose from existing capability, not earn a branch of its own.
    const offenders = SOURCES.filter((file) => file.source.includes(templateKey)).map(
      (file) => file.path,
    );
    expect(offenders).toEqual([]);
  });

  it('branches on no template key or template id at all', () => {
    const offenders = SOURCES.filter((file) =>
      /\btemplateKey\s*===|\btemplateId\s*===|switch\s*\(\s*\w*[Tt]emplate/.test(file.source),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('names no section id from a manifest', () => {
    // Section *types* are a closed domain vocabulary and appear freely. Section
    // *instance* ids come from a manifest, so comparing against one would be a
    // template-specific branch wearing a different hat.
    const offenders = SOURCES.filter((file) => /\bsectionId\s*===/.test(file.source)).map(
      (file) => file.path,
    );
    expect(offenders).toEqual([]);
  });
});

describe('the render path reaches nothing outside itself', () => {
  it('imports no filesystem, process or network module', () => {
    const forbidden =
      /from\s+['"](?:node:)?(?:fs|fs\/promises|path|child_process|http|https|net|dns|os|worker_threads)['"]/;
    const offenders = SOURCES.filter((file) => forbidden.test(file.source)).map(
      (file) => file.path,
    );
    expect(offenders).toEqual([]);
  });

  it('contains no dynamic evaluation', () => {
    /**
     * `eval`, `new Function` and `import(expression)` are the three ways data
     * becomes code. A manifest is data; it must stay that way (ADR-0004).
     *
     * `import('a-literal')` is deliberately *not* among them, and the
     * distinction is the whole point rather than a loophole: a literal
     * specifier is resolved by the bundler at build time and can no more be
     * influenced by a manifest than a top-level `import` can. What must never
     * appear is a specifier assembled at runtime — `import(variable)`,
     * `import(\`…${x}\`)` — because that is the form a template could reach.
     *
     * The published render path needs one such literal import
     * (`react-dom/server`), because the framework refuses a static import of
     * it from application code (ADR-0020).
     */
    const dangerous = /\beval\s*\(|new\s+Function\s*\(|\bimport\s*\(\s*(?!['"][^'"]*['"]\s*\))/;
    const offenders = SOURCES.filter((file) => dangerous.test(file.source)).map(
      (file) => file.path,
    );
    expect(offenders).toEqual([]);
  });

  it('still rejects an import whose specifier is built at runtime', () => {
    // Guards the guard: the exception above is narrow, and a regex is exactly
    // the kind of thing that quietly stops matching.
    const dangerous = /\beval\s*\(|new\s+Function\s*\(|\bimport\s*\(\s*(?!['"][^'"]*['"]\s*\))/;

    expect(dangerous.test("await import('react-dom/server')")).toBe(false);
    expect(dangerous.test('await import(specifier)')).toBe(true);
    expect(dangerous.test('await import(`${base}/mod.js`)')).toBe(true);
    expect(dangerous.test('eval(source)')).toBe(true);
    expect(dangerous.test('new Function(body)')).toBe(true);
  });

  it('issues no network call', () => {
    const offenders = SOURCES.filter((file) =>
      /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket/.test(file.source),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('reads no clock and draws no random value', () => {
    // Determinism is what makes the published page cacheable and the preview
    // trustworthy. Either of these would silently end it.
    const offenders = SOURCES.filter((file) =>
      /Date\.now\s*\(|new\s+Date\s*\(\s*\)|Math\.random\s*\(|performance\.now\s*\(/.test(
        file.source,
      ),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('uses no raw-HTML sink', () => {
    const offenders = SOURCES.filter((file) =>
      /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(
        file.source,
      ),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('imports no database, Prisma or repository module', () => {
    // A section that could reach a repository could reach another tenant's
    // data. The contract in registry/types.ts says it cannot; this says the
    // source agrees.
    const offenders = SOURCES.filter((file) =>
      /@prisma\/client|@zfaf\/db|PrismaClient|Repository/.test(file.source),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});

describe('styling stays in logical properties', () => {
  it('uses no direction-sensitive CSS property anywhere in the package', () => {
    // ADR-0011. The `zfaf/no-physical-css-properties` lint rule covers authored
    // JSX; these patterns mirror the ones that rule uses, so the stylesheet —
    // a template literal the rule reads differently — is held to the same
    // standard. Only direction-sensitive properties are listed: `width` and
    // `height` read the same in both directions and are not the concern.
    const physical = [
      /(?:^|[;{\s])(?:margin|padding|border)-(?:left|right)\s*:/i,
      /(?:^|[;{\s])(?:left|right)\s*:/i,
      /text-align\s*:\s*(?:left|right)\b/i,
      /(?:^|[;{\s])float\s*:\s*(?:left|right)\b/i,
      /border-(?:top|bottom)-(?:left|right)-radius/i,
    ];

    for (const file of SOURCES) {
      for (const pattern of physical) {
        const match = pattern.exec(file.source);
        expect(match?.[0], `${file.path}: ${match?.[0] ?? ''}`).toBeUndefined();
      }
    }
  });
});
