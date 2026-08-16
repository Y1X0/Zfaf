/**
 * Subsets the vendored Arabic face and writes the woff2 the site loads (D9.3).
 *
 * Run deliberately, not on every build, and the output is committed. Two
 * reasons:
 *
 *   • **Subsetting needs Python and `fonttools`.** Making `next build` depend
 *     on a second language runtime would mean CI, every developer machine and
 *     the deploy image all need it, to produce a file that changes roughly
 *     never.
 *   • **The output is an asset, like the source `.ttf` beside it.** Both are
 *     OFL-1.1 and the licence travels with them (`assets/fonts/OFL.txt`), so
 *     the committed file is exactly as licence-clear as its input.
 *
 * Regenerate with `pnpm fonts:build` after changing the character set below.
 *
 * The range is Arabic plus Latin plus the punctuation a bilingual interface
 * actually uses. Shipping the whole face would be 411 KB for a page that
 * displays a few hundred distinct glyphs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'apps/web/assets/fonts/Amiri-Regular.ttf');
const outDir = join(root, 'apps/web/public/fonts');
const output = join(outDir, 'zfaf-arabic.woff2');

/**
 * Arabic, Arabic Supplement and Extended-A, the presentation forms some
 * software still emits, Latin-1, general punctuation, and the arrows and box
 * characters the interface uses as glyphs. Kept in one place so the CSS
 * `unicode-range` and this list cannot drift apart.
 */
const UNICODES = [
  'U+0600-06FF',
  'U+0750-077F',
  'U+08A0-08FF',
  'U+FB50-FDFF',
  'U+FE70-FEFF',
  'U+0020-007E',
  'U+00A0-00FF',
  'U+2000-206F',
  'U+2190-21FF',
  'U+2500-25FF',
].join(',');

if (!existsSync(source)) {
  console.error(`Source font not found: ${source}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

try {
  execFileSync(
    'python3',
    [
      '-m',
      'fontTools.subset',
      source,
      `--unicodes=${UNICODES}`,
      '--flavor=woff2',
      `--output-file=${output}`,
      /**
       * The shaping features, explicitly — and no stylistic sets.
       *
       * `init`, `medi` and `fina` choose which of a letter's forms to draw;
       * `ccmp`, `rlig` and `liga` compose the mandatory ligatures Arabic
       * requires (لا is not two letters); `mark`, `mkmk` and `curs` position
       * the diacritics and the cursive joins. Without them a word renders as a
       * row of disconnected shapes an Arabic reader cannot read, and the file
       * is smaller and still passes every size check — which is why the step
       * below verifies the output rather than trusting this list.
       *
       * Amiri's eight stylistic sets are deliberately absent. They are
       * calligraphic alternates for setting Qur'anic text, they are not
       * requested by anything in this interface, and each one drags its own
       * alternate glyphs into the subset: keeping them costs **74 KB** for
       * shapes no page ever asks for.
       *
       * `--layout-features=…` *replaces* fontTools' default set rather than
       * adding to it, so this list is the whole set and an omission here is
       * silent.
       */
      '--layout-features=ccmp,init,medi,fina,isol,rlig,liga,calt,locl,mark,mkmk,curs,kern',
      '--no-hinting',
      '--desubroutinize',
      '--drop-tables+=DSIG',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
} catch {
  console.error(
    'Subsetting failed. This needs Python with fonttools and brotli:\n' +
      '  pip install "fonttools[woff]" brotli',
  );
  process.exit(1);
}

/**
 * Checks the output rather than trusting the flags.
 *
 * A subset that silently dropped `init`/`medi`/`fina`/`isol` still produces a
 * valid, smaller, correct-looking font file — and renders every Arabic word on
 * the site as disconnected letters. That failure is invisible to a size check
 * and to a build that exits zero, so it is asserted here.
 */
try {
  execFileSync(
    'python3',
    [
      '-c',
      [
        'from fontTools.ttLib import TTFont',
        'def feats(font):',
        '    out = set()',
        '    for table in ("GSUB", "GPOS"):',
        '        if table in font:',
        '            out |= {r.FeatureTag for r in font[table].table.FeatureList.FeatureRecord}',
        '    return out',
        `src, sub = TTFont(${JSON.stringify(source)}), TTFont(${JSON.stringify(output)})`,
        // Compared against the source, not against a list written from memory.
        // Amiri has no `isol` feature at all — its isolated form is the base
        // glyph — so demanding one would fail a subset that is perfectly
        // correct. What matters is that the subset keeps what the source had.
        'shaping = {"init", "medi", "fina", "isol", "rlig", "liga", "calt",',
        '           "ccmp", "mark", "mkmk", "curs", "kern", "locl"}',
        'lost = (feats(src) & shaping) - feats(sub)',
        'assert not lost, f"subset lost Arabic shaping features: {sorted(lost)}"',
        'cmap = sub.getBestCmap()',
        'absent = [c for c in "أحمدوسارةABC0123" if ord(c) not in cmap]',
        'assert not absent, f"subset lost glyphs: {absent}"',
        'kept = sorted(feats(src) & shaping)',
        'print(f"  shaping features kept: {\' \'.join(kept)}")',
        'print(f"  {len(sub.getGlyphOrder())} glyphs")',
      ].join('\n'),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
} catch {
  console.error('The subset is not usable for Arabic. Not writing it off as a size win.');
  process.exit(1);
}

const before = statSync(source).size;
const after = statSync(output).size;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

console.log(`${kb(before)} → ${kb(after)}  (${((1 - after / before) * 100).toFixed(0)}% smaller)`);
console.log(`wrote ${output}`);
