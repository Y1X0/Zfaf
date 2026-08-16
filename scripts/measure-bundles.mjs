/**
 * Measures what each budgeted route actually downloads (M5, M6 acceptance).
 *
 * Two routes, measured two different ways, and the difference is the point.
 *
 *   • **`/builder/[id]`** is an ordinary App Router page, so its cost is the
 *     chunks the build manifest says it loads. Next prints a "First Load JS"
 *     figure, but the label does not say whether it is compressed and the
 *     number has changed meaning between releases. The budget is expressed in
 *     gzipped bytes, so this reads the manifest, collects the route's chunks,
 *     and gzips them itself.
 *
 *   • **`/i/[slug]`** is a Route Handler that returns hand-assembled HTML
 *     (ADR-0020), so the manifest says nothing useful about it — Next lists
 *     the shared client chunks for every entry, and this response references
 *     none of them. Measuring it from the manifest would report 100 KB for a
 *     page that downloads 1.4 KB. So it is measured from the **served
 *     document**: fetch the page, read the `<script>` and stylesheet
 *     references it actually contains, fetch those, and gzip the lot.
 *
 * A budget checked against a number nobody can reproduce is not a budget, and
 * a budget checked against the wrong number is worse than none.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const KB = 1024;

/** From PRD §4.1 and docs/07 §10, both owner-approved. */
const BUDGETS = {
  builder: { js: 250 * KB },
  publicPage: { js: 90 * KB, css: 25 * KB },
};

const webRoot = resolve(process.argv[2] ?? 'apps/web');
const nextDir = join(webRoot, '.next');

const kb = (value) => `${(value / KB).toFixed(1)} KB`;

let failed = false;

function report(label, actual, budget) {
  const verdict = actual <= budget ? '✓' : '✗';
  const margin =
    actual <= budget ? `${kb(budget - actual)} to spare` : `OVER by ${kb(actual - budget)}`;
  console.log(
    `  ${verdict} ${label.padEnd(28)} ${kb(actual).padStart(9)} / ${kb(budget).padStart(9)}   ${margin}`,
  );
  if (actual > budget) failed = true;
}

// ── the builder, from the build manifest ────────────────────────────────────

function measureBuilder() {
  const manifest = JSON.parse(readFileSync(join(nextDir, 'app-build-manifest.json'), 'utf8'));
  const routeKey = Object.keys(manifest.pages).find((key) => key.includes('/builder/'));
  if (!routeKey) {
    console.error('Could not find a /builder route in the build manifest.');
    process.exitCode = 1;
    return;
  }

  const files = [...new Set(manifest.pages[routeKey])].filter((file) => file.endsWith('.js'));
  let gzip = 0;
  for (const file of files) {
    const path = join(nextDir, file);
    try {
      statSync(path);
    } catch {
      continue;
    }
    gzip += gzipSync(readFileSync(path), { level: 9 }).byteLength;
  }

  console.log(`\n${routeKey}  (${files.length} chunks)`);
  report('initial JS (gzip)', gzip, BUDGETS.builder.js);
}

// ── the public page, from the served document ───────────────────────────────

/**
 * Fetches a published invitation and weighs what a guest downloads.
 *
 * Needs a running server and a published slug, so it is skipped when either is
 * absent rather than guessing — and it says so, because a silently skipped
 * budget check reads exactly like a passing one.
 */
async function measurePublicPage(baseUrl, slug) {
  const pageUrl = `${baseUrl}/i/${slug}`;
  const response = await fetch(pageUrl);
  if (!response.ok) {
    console.error(`\n${pageUrl} answered ${response.status}; cannot measure.`);
    failed = true;
    return;
  }

  const html = await response.text();

  // Inline `<style>` blocks are part of the document, so they are weighed as
  // CSS rather than ignored — the theme sheet is inlined deliberately and it
  // would be dishonest to leave it out of the CSS budget.
  const inlineCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1])
    .join('');

  const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  const stylesheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
    (match) => match[1],
  );

  let js = 0;
  for (const src of scriptSrcs) {
    const asset = await fetch(new URL(src, pageUrl));
    js += gzipSync(Buffer.from(await asset.arrayBuffer()), { level: 9 }).byteLength;
  }

  let css = gzipSync(Buffer.from(inlineCss, 'utf8'), { level: 9 }).byteLength;
  for (const href of stylesheets) {
    const asset = await fetch(new URL(href, pageUrl));
    css += gzipSync(Buffer.from(await asset.arrayBuffer()), { level: 9 }).byteLength;
  }

  const htmlBytes = gzipSync(Buffer.from(html, 'utf8'), { level: 9 }).byteLength;

  console.log(`\n/i/[slug]  (${scriptSrcs.length} scripts, ${stylesheets.length} stylesheets)`);
  console.log(`    scripts: ${scriptSrcs.join(', ') || 'none'}`);
  report('initial JS (gzip)', js, BUDGETS.publicPage.js);
  report('CSS incl. inline (gzip)', css, BUDGETS.publicPage.css);
  console.log(`    document itself: ${kb(htmlBytes)} gzip`);

  // The premise of ADR-0020 in one assertion: if a framework chunk ever
  // appears here, the budget above stopped meaning what it says.
  const framework = scriptSrcs.filter((src) => src.includes('/_next/'));
  if (framework.length > 0) {
    console.error(`\n✗ The public page loaded framework chunks: ${framework.join(', ')}`);
    console.error('  ADR-0020 says it ships none. Either the ADR changed or this is a regression.');
    failed = true;
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

measureBuilder();

const baseUrl = process.env['MEASURE_BASE_URL'];
const slug = process.env['MEASURE_SLUG'];
if (baseUrl && slug) {
  await measurePublicPage(baseUrl, slug);
} else {
  console.log('\n/i/[slug]  skipped — set MEASURE_BASE_URL and MEASURE_SLUG to measure it.');
}

if (failed) {
  console.error('\n✗ At least one budget was exceeded.');
  process.exit(1);
}
console.log('\n✓ Every measured budget holds.');
