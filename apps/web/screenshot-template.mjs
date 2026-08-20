const { chromium } = await import('@playwright/test');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium'
});

const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  locale: 'ar',
  timezoneId: 'UTC',
});

await page.goto('file:///tmp/elegant-simple-screenshot.html', { waitUntil: 'networkidle' });

// Wait for fonts to load
await page.waitForTimeout(1000);

// Remove animations for consistent screenshot
await page.addStyleTag({
  content: `*, *::before, *::after { animation: none !important; transition: none !important; }`,
});

// Take screenshot
await page.screenshot({
  path: '/home/user/Zfaf/packages/invitation-renderer/templates/elegant-simple/preview-390px.png',
  fullPage: false,
});

console.log('✓ Screenshot saved: packages/invitation-renderer/templates/elegant-simple/preview-390px.png');

await browser.close();
