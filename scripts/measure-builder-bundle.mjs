/**
 * Measures the JavaScript the builder page actually downloads (M5 budget).
 *
 * Next prints a "First Load JS" figure, but the label does not say whether it
 * is compressed and the number has changed meaning between releases. The
 * budget is expressed in gzipped bytes, so this reads the build manifest,
 * collects the chunks the route loads, and gzips them itself. A budget checked
 * against a number nobody can reproduce is not a budget.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BUDGET_BYTES = 250 * 1024;
const root = resolve(process.argv[2] ?? 'apps/web');
const nextDir = join(root, '.next');

const manifest = JSON.parse(readFileSync(join(nextDir, 'app-build-manifest.json'), 'utf8'));

const routeKey = Object.keys(manifest.pages).find((key) => key.includes('/builder/'));
if (!routeKey) {
  console.error('Could not find a /builder route in the build manifest.');
  process.exit(1);
}

// The route's own chunks plus the shared ones every page loads.
const shared = manifest.pages['/_app'] ?? [];
const files = [...new Set([...shared, ...manifest.pages[routeKey]])].filter((file) =>
  file.endsWith('.js'),
);

let rawTotal = 0;
let gzipTotal = 0;
const rows = [];

for (const file of files) {
  const path = join(nextDir, file);
  try {
    statSync(path);
  } catch {
    continue;
  }
  const bytes = readFileSync(path);
  const gzipped = gzipSync(bytes, { level: 9 }).byteLength;
  rawTotal += bytes.byteLength;
  gzipTotal += gzipped;
  rows.push({ file, raw: bytes.byteLength, gzip: gzipped });
}

rows.sort((a, b) => b.gzip - a.gzip);
for (const row of rows) {
  console.log(`  ${(row.gzip / 1024).toFixed(1).padStart(7)} KB gzip  ${row.file}`);
}

const kb = (value) => `${(value / 1024).toFixed(1)} KB`;
console.log(`\nroute:  ${routeKey}`);
console.log(`chunks: ${rows.length}`);
console.log(`raw:    ${kb(rawTotal)}`);
console.log(`gzip:   ${kb(gzipTotal)}   budget ${kb(BUDGET_BYTES)}`);

if (gzipTotal > BUDGET_BYTES) {
  console.error(`\n✗ Over budget by ${kb(gzipTotal - BUDGET_BYTES)}`);
  process.exit(1);
}
console.log(`\n✓ Within budget, ${kb(BUDGET_BYTES - gzipTotal)} to spare`);
