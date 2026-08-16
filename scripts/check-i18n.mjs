/**
 * Two checks that fail CI (D9.1, M9 tests).
 *
 *   1. **The catalogues have identical key sets.** A key present in Arabic and
 *      missing in English renders the key path itself to an English visitor —
 *      `builder.publish.slugTaken` in the middle of a form — and next-intl logs
 *      it rather than throwing, precisely so one missing string cannot take a
 *      page down. That trade only works if something else catches it, and this
 *      is that something.
 *
 *   2. **No hard-coded Arabic in the interface.** A single literal that never
 *      made it into the catalogue is invisible in Arabic — it looks perfect —
 *      and appears untranslated to every English visitor. Grepping for Arabic
 *      script finds exactly that class of mistake, which review does not.
 *
 * The second check deliberately does not look at the invitation renderer or
 * the published page. Their strings are **content**, not interface: an Arabic
 * invitation says "هل ستحضر؟" to a guest in London because that is the
 * language the couple chose, and the locale of the person reading is not part
 * of the question (ADR-0011 §2).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const messagesDir = join(root, 'apps/web/src/i18n/messages');

let failures = 0;

const fail = (message) => {
  console.error(`  ✗ ${message}`);
  failures += 1;
};

// ── 1. key parity ───────────────────────────────────────────────────────────

/** Every leaf path in a catalogue, e.g. `builder.publish.slug`. */
function leafKeys(value, prefix = '') {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** The `{name}` placeholders a message uses, so a translation cannot drop one. */
function placeholders(message) {
  if (typeof message !== 'string') return [];
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

function valueAt(catalogue, path) {
  return path.split('.').reduce((node, key) => (node == null ? node : node[key]), catalogue);
}

console.log('Checking translation catalogues…');

const locales = readdirSync(messagesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({
    locale: name.replace(/\.json$/, ''),
    catalogue: JSON.parse(readFileSync(join(messagesDir, name), 'utf8')),
  }));

if (locales.length < 2) {
  fail(`expected at least two catalogues in ${relative(root, messagesDir)}`);
}

const [reference, ...others] = locales;
const referenceKeys = new Set(leafKeys(reference.catalogue));

for (const { locale, catalogue } of others) {
  const keys = new Set(leafKeys(catalogue));

  for (const key of referenceKeys) {
    if (!keys.has(key)) fail(`${locale}.json is missing "${key}"`);
  }
  for (const key of keys) {
    if (!referenceKeys.has(key))
      fail(`${locale}.json has "${key}", which ${reference.locale} does not`);
  }

  // A placeholder that exists in one language and not the other renders as
  // literal `{count}` to whoever reads the language that dropped it.
  for (const key of referenceKeys) {
    if (!keys.has(key)) continue;
    const expected = placeholders(valueAt(reference.catalogue, key));
    const actual = placeholders(valueAt(catalogue, key));
    if (expected.join() !== actual.join()) {
      fail(
        `"${key}" placeholders differ: ${reference.locale} has {${expected.join(', ')}}, ` +
          `${locale} has {${actual.join(', ')}}`,
      );
    }
  }
}

if (failures === 0) {
  console.log(`  ✓ ${referenceKeys.size} keys, identical across ${locales.length} catalogues`);
}

// ── 2. no hard-coded Arabic in the interface ────────────────────────────────

console.log('Checking for hard-coded interface strings…');

/**
 * Where interface text lives.
 *
 * Not `public-page/` or `invitation-renderer/`: those render the invitation
 * itself, whose language is the couple's choice rather than the visitor's.
 */
const SCANNED = ['apps/web/src/app', 'apps/web/src/builder', 'apps/web/src/dashboard'];

/** The admin console is internal, English, and deliberately not translated. */
const SKIPPED = ['apps/web/src/app/admin'];

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (SKIPPED.some((skip) => path.startsWith(join(root, skip)))) continue;
      yield* sourceFiles(path);
    } else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) {
      /**
       * Tests are skipped, and that is not a loophole.
       *
       * ADR-0011 §6 *requires* fixtures to use real Arabic names — "لا Lorem
       * Ipsum ولا كلمة واحدة" — because real names are longer than a designer
       * expects and are what surfaces wrapping bugs. Those literals are data
       * under test, not interface copy, and flagging them would make the only
       * sensible response "stop testing in Arabic".
       */
      yield path;
    }
  }
}

/**
 * Strips comments before scanning.
 *
 * Half this codebase's comments are in Arabic — they explain decisions to the
 * people who made them — and a check that flagged prose in a `/** … *\/` block
 * would be so noisy nobody would keep it.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

for (const dir of SCANNED) {
  const absolute = join(root, dir);
  for (const file of sourceFiles(absolute)) {
    const code = withoutComments(readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, index) => {
      if (!ARABIC.test(line)) return;
      fail(
        `${relative(root, file)}:${index + 1} has Arabic text outside the catalogue\n      ${line.trim()}`,
      );
    });
  }
}

if (failures === 0) {
  console.log('  ✓ every interface string comes from a catalogue');
  console.log('\n✓ i18n checks pass.');
  process.exit(0);
}

console.error(`\n✗ ${failures} i18n problem(s).`);
process.exit(1);
