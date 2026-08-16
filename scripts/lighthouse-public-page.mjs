/**
 * Lighthouse on the published invitation (M6 acceptance).
 *
 * The thresholds are the owner-approved ones from PRD §4.1 and docs/07 §10:
 * Performance ≥ 92 and Accessibility ≥ 95, measured on a simulated mid-range
 * phone over slow 4G. Those conditions are the point — the target audience
 * opens these links on exactly that, and a score taken on a desktop with
 * fibre would be a number that flatters us and predicts nothing.
 *
 * Run it against a server that is already up:
 *
 *   LH_URL=https://127.0.0.1:3100/i/<slug> node scripts/lighthouse-public-page.mjs
 *
 * The certificate in the end-to-end environment is self-signed, so Chrome is
 * launched with certificate errors ignored. That affects transport only; every
 * metric below is measured on the real response.
 */
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';

const url = process.env['LH_URL'];
if (!url) {
  console.error('Set LH_URL to the published invitation to measure.');
  process.exit(1);
}

const THRESHOLDS = { performance: 92, accessibility: 95 };

/** From PRD §4.1. Absolute, not "advisory". */
const METRIC_BUDGETS = {
  'largest-contentful-paint': { max: 2500, label: 'LCP' },
  'cumulative-layout-shift': { max: 0.05, label: 'CLS' },
  'total-blocking-time': { max: 200, label: 'TBT' },
};

const chrome = await launch({
  chromePath: process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium',
  chromeFlags: [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--ignore-certificate-errors',
  ],
});

try {
  const result = await lighthouse(
    url,
    { port: chrome.port, output: 'json', logLevel: 'error' },
    {
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        formFactor: 'mobile',
        // A Moto G Power on slow 4G: 1.6 Mbps down, 150ms RTT, 4× CPU
        // slowdown. The numbers come from docs/00 §4.1.
        throttling: {
          rttMs: 150,
          throughputKbps: 1600,
          cpuSlowdownMultiplier: 4,
          requestLatencyMs: 150 * 3.75,
          downloadThroughputKbps: 1600 * 0.9,
          uploadThroughputKbps: 750 * 0.9,
        },
        screenEmulation: { mobile: true, width: 390, height: 844, deviceScaleFactor: 2.625 },
      },
    },
  );

  if (!result?.lhr) {
    console.error('Lighthouse returned no report.');
    process.exit(1);
  }

  const { categories, audits } = result.lhr;
  let failed = false;

  console.warn(`\nLighthouse — ${url}\n`);
  for (const [key, category] of Object.entries(categories)) {
    const score = Math.round((category.score ?? 0) * 100);
    const threshold = THRESHOLDS[key];
    const verdict = threshold === undefined ? ' ' : score >= threshold ? '✓' : '✗';
    const target = threshold === undefined ? '' : `  (needs ${threshold})`;
    console.warn(`  ${verdict} ${category.title.padEnd(16)} ${String(score).padStart(3)}${target}`);
    if (threshold !== undefined && score < threshold) failed = true;
  }

  console.warn('');
  for (const [id, budget] of Object.entries(METRIC_BUDGETS)) {
    const audit = audits[id];
    const value = audit?.numericValue;
    if (value === undefined) continue;
    const within = value <= budget.max;
    const shown = id === 'cumulative-layout-shift' ? value.toFixed(3) : `${Math.round(value)}ms`;
    const limit = id === 'cumulative-layout-shift' ? budget.max : `${budget.max}ms`;
    console.warn(`  ${within ? '✓' : '✗'} ${budget.label.padEnd(16)} ${shown}  (max ${limit})`);
    if (!within) failed = true;
  }

  // Naming what failed, rather than leaving the reader to open a report.
  if (failed) {
    console.error('\n✗ At least one Lighthouse threshold was missed.');
    process.exit(1);
  }
  console.warn('\n✓ Every Lighthouse threshold holds.');
} finally {
  await chrome.kill();
}
