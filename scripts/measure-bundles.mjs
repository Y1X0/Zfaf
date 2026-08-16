/**
 * Measures what each budgeted route actually downloads (M5, M6, M9 acceptance).
 *
 * Three surfaces, measured two different ways, and the difference is the point.
 *
 *   • **`/builder/[id]`** is a private, interactive App Router page whose whole
 *     cost is client components, so its cost is the chunks the build manifest
 *     says it loads. Next prints a "First Load JS" figure, but the label does
 *     not say whether it is compressed and the number has changed meaning
 *     between releases. The budget is expressed in gzipped bytes, so this reads
 *     the manifest, collects the route's chunks, and gzips them itself.
 *
 *   • **`/i/[slug]`** is a Route Handler that returns hand-assembled HTML
 *     (ADR-0020), so the manifest says nothing useful about it — Next lists
 *     the shared client chunks for every entry, and this response references
 *     none of them. Measuring it from the manifest would report 100 KB for a
 *     page that downloads 1.4 KB.
 *
 *   • **The marketing surface** (`/` and `/en`) has the mirror-image problem:
 *     the manifest lists two chunks the served document never references and
 *     a first-time visitor therefore never downloads. Measuring it from the
 *     manifest would overstate it (ADR-0021 §3).
 *
 * So both public surfaces are measured from the **served document**: fetch the
 * page, read the `<script>` and stylesheet references it actually contains,
 * fetch those, and gzip the lot. That is what a visitor downloads, and it is
 * the one method that cannot be argued with in either direction.
 *
 * A budget checked against a number nobody can reproduce is not a budget, and
 * a budget checked against the wrong number is worse than none.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const KB = 1024;

/**
 * Owner-approved budgets. The two public numbers are deliberately **separate**
 * and must not be merged into one generic figure (ADR-0021 §8): they describe
 * two architectures serving two audiences.
 */
const BUDGETS = {
  // PRD §4.2 — private, interactive, logged-in user.
  builder: { js: 250 * KB },
  // ADR-0020 — the guest's page: streamed HTML, zero hydration.
  publicPage: { js: 90 * KB, css: 25 * KB },
  // ADR-0021 — App Router marketing pages: 138.4 KB measured framework floor
  // plus a 4% safety margin for Next/React patch drift. Not room to grow: one
  // `'use client'` on a marketing page exceeds it.
  marketing: { js: 144 * KB, css: 30 * KB },
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

// ── the public surfaces, from the served document ───────────────────────────

/**
 * Weighs one served page: every script and stylesheet it actually references.
 *
 * Returns `null` when the page does not answer 200, so the caller can fail
 * loudly. A budget check that quietly measures an error page is worse than no
 * check at all.
 */
async function weigh(pageUrl) {
  const response = await fetch(pageUrl);
  if (!response.ok) {
    console.error(`\n${pageUrl} answered ${response.status}; cannot measure.`);
    failed = true;
    return null;
  }

  const html = await response.text();

  // Inline `<style>` blocks are part of the document, so they are weighed as
  // CSS rather than ignored — the theme sheet is inlined deliberately and it
  // would be dishonest to leave it out of the CSS budget.
  const inlineCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1])
    .join('');

  /**
   * Every `<script src>`, including the `noModule` polyfill bundle that no
   * browser in our `browserslist` downloads. Excluding it would have brought
   * the marketing surface in under its old budget — which is precisely why it
   * is counted (ADR-0021 §2.1). A budget is not allowed to move by changing
   * what the measurement looks at.
   */
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

  return {
    js,
    css,
    scriptSrcs,
    stylesheets,
    html: gzipSync(Buffer.from(html, 'utf8'), { level: 9 }).byteLength,
  };
}

/**
 * Fetches a published invitation and weighs what a guest downloads.
 *
 * Needs a running server and a published slug, so it is skipped when either is
 * absent rather than guessing — and it says so, because a silently skipped
 * budget check reads exactly like a passing one.
 */
async function measurePublicPage(baseUrl, slug) {
  const pageUrl = `${baseUrl}/i/${slug}`;
  const measured = await weigh(pageUrl);
  if (!measured) return;

  console.log(
    `\n/i/[slug]  (${measured.scriptSrcs.length} scripts, ${measured.stylesheets.length} stylesheets)`,
  );
  console.log(`    scripts: ${measured.scriptSrcs.join(', ') || 'none'}`);
  report('initial JS (gzip)', measured.js, BUDGETS.publicPage.js);
  report('CSS incl. inline (gzip)', measured.css, BUDGETS.publicPage.css);
  console.log(`    document itself: ${kb(measured.html)} gzip`);

  // The premise of ADR-0020 in one assertion: if a framework chunk ever
  // appears here, the budget above stopped meaning what it says.
  const framework = measured.scriptSrcs.filter((src) => src.includes('/_next/'));
  if (framework.length > 0) {
    console.error(`\n✗ The public page loaded framework chunks: ${framework.join(', ')}`);
    console.error('  ADR-0020 says it ships none. Either the ADR changed or this is a regression.');
    failed = true;
  }
}

/**
 * Weighs the marketing surface in **both languages** and budgets the heavier.
 *
 * Both, because a client component added to the English tree only would
 * otherwise pass — and the two locales share every chunk, so a divergence is
 * itself the signal worth failing on.
 */
async function measureMarketing(baseUrl) {
  const pages = [
    ['/', 'ar'],
    ['/en', 'en'],
  ];

  let worst = null;
  console.log('\n/  and  /en   (marketing surface, ADR-0021)');
  for (const [path, locale] of pages) {
    const measured = await weigh(`${baseUrl}${path}`);
    if (!measured) return;
    console.log(
      `    ${locale}: ${measured.scriptSrcs.length} scripts ${kb(measured.js)} · ` +
        `${measured.stylesheets.length} stylesheets ${kb(measured.css)} · document ${kb(measured.html)}`,
    );
    if (!worst || measured.js > worst.js) worst = measured;
  }

  report('initial JS (gzip)', worst.js, BUDGETS.marketing.js);
  report('CSS incl. inline (gzip)', worst.css, BUDGETS.marketing.css);

  /**
   * The framework floor dominates this number, so an application regression of
   * a few KB would still fit under the budget if the floor ever shrank. Naming
   * the chunks makes the composition auditable rather than implied: anything
   * beyond the five known framework entries is our code arriving on a page
   * that is supposed to ship none.
   */
  const FRAMEWORK = ['ebbcf', 'polyfills-', 'webpack-', 'main-app-', '6428-'];
  const ours = worst.scriptSrcs.filter(
    (src) => !FRAMEWORK.some((known) => src.includes(known)) && src.includes('/_next/'),
  );
  if (ours.length > 0) {
    console.log(`    ⚠ non-framework chunks on the marketing surface: ${ours.join(', ')}`);
    console.log('      Expected under ADR-0021 §5 (application contribution: 0 bytes).');
    console.log('      Not a failure by itself — the budget above is what fails — but check why.');
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

if (baseUrl) {
  await measureMarketing(baseUrl);
} else {
  console.log('\n/  and /en  skipped — set MEASURE_BASE_URL to measure the marketing surface.');
}

if (failed) {
  console.error('\n✗ At least one budget was exceeded.');
  process.exit(1);
}
console.log('\n✓ Every measured budget holds.');
