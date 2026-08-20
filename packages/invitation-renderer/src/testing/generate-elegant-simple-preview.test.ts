import { describe, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotFrom, render } from './snapshot-fixture.js';

describe('generate-elegant-simple-preview', () => {
  it('generates a 390px screenshot of the elegant-simple template', async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));

    // Generate snapshot and HTML
    const snapshot = snapshotFrom('elegant-simple');
    const html = render(snapshot, 'published');

    // Read CSS files
    const baseCssPath = resolve(__dirname, '../theme/base-stylesheet.ts');
    const baseCssContent = readFileSync(baseCssPath, 'utf8');
    const baseCssMatch = baseCssContent.match(/export const BASE_STYLESHEET = `([\s\S]*?)`\.replace/);
    if (!baseCssMatch) throw new Error('Could not extract base stylesheet');
    const baseCss = baseCssMatch[1];

    const sitesCssPath = resolve(__dirname, '../../../../apps/web/src/app/site.css');
    const sitesCss = readFileSync(sitesCssPath, 'utf8');

    // Create full HTML document
    const fullHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Elegant Simple Preview</title>
  <style>
    body { margin: 0; padding: 0; }
    ${sitesCss}
    ${baseCss}
  </style>
</head>
<body>
  ${html}
</body>
</html>`;

    // Save HTML to temp file
    const htmlPath = '/tmp/elegant-simple-screenshot.html';
    writeFileSync(htmlPath, fullHtml);
    console.log(`✓ HTML file created: ${htmlPath}`);

    // Create output directory
    const outputDir = resolve(__dirname, '../../templates/elegant-simple');
    mkdirSync(outputDir, { recursive: true });
  });
});
