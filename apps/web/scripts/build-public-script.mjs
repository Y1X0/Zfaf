/**
 * Bundles the public page's enhancement script (ADR-0020).
 *
 * The published invitation loads no framework, so this one file is the whole
 * of its JavaScript. It is written in TypeScript under `src/` — typechecked,
 * linted, and importing the countdown arithmetic from `@zfaf/core` rather than
 * copying it — and emitted here as a single minified file that `public/` can
 * serve under `script-src 'self'`.
 *
 * The import is from `@zfaf/core/countdown`, not from the package root: the
 * root barrel builds Zod schemas at module scope, which no bundler may drop,
 * and pulling those into a page whose whole point is a small budget would
 * defeat the exercise.
 */
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(webRoot, 'public', 'invitation.js');

mkdirSync(join(webRoot, 'public'), { recursive: true });

await build({
  entryPoints: [join(webRoot, 'src', 'public-page', 'invitation.ts')],
  outfile,
  bundle: true,
  minify: true,
  format: 'iife',
  // The floor of what the target market's phones run. Anything newer risks a
  // syntax error on a device that would otherwise have shown the invitation.
  // Safari 15 rather than 14: esbuild will not emit destructuring for 14,
  // because that release shipped it broken in some positions.
  // The same floor `browserslist` in package.json gives Next, kept in step on
  // purpose: two different answers to "which browsers do we support" is how a
  // page ends up shipping 39 KB of polyfills for browsers the rest of the
  // build already assumes away.
  target: ['es2020', 'safari15', 'chrome91', 'firefox90'],
  legalComments: 'none',
  logLevel: 'warning',
});

const bytes = readFileSync(outfile);
const gzip = gzipSync(bytes, { level: 9 }).byteLength;
console.warn(
  `public/invitation.js  ${(bytes.byteLength / 1024).toFixed(1)} KB raw  ${(gzip / 1024).toFixed(1)} KB gzip`,
);
