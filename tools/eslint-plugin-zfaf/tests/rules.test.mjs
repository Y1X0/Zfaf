import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import noPhysicalCssProperties from '../rules/no-physical-css-properties.js';
import noDangerousHtml from '../rules/no-dangerous-html.js';
import noPrismaOutsideDb from '../rules/no-prisma-outside-db.js';
import noMarketLiterals from '../rules/no-market-literals.js';

// Bind ESLint's RuleTester to Vitest so failures are reported as test failures
// rather than raw throws.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

// ── ADR-0011: RTL correctness must be enforced, not merely intended ──────────
ruleTester.run('no-physical-css-properties', noPhysicalCssProperties, {
  valid: [
    { code: 'const s = { marginInlineStart: 4 };' },
    { code: 'const s = { paddingInlineEnd: "1rem" };' },
    { code: 'const c = "ms-4 pe-2 text-start border-s rounded-s-lg";' },
    { code: 'const css = `.a { margin-inline-start: 1rem; text-align: start; }`;' },
    // "insetInlineStart" is logical; the physical shorthand is what we reject.
    { code: 'const s = { insetInlineStart: 0 };' },
    // Unrelated identifiers that merely contain the word must not trip the rule.
    { code: 'const leftovers = compute();' },
  ],
  invalid: [
    {
      code: 'const s = { marginLeft: 4 };',
      errors: [{ messageId: 'styleObject' }],
    },
    {
      code: 'const s = { paddingRight: "1rem" };',
      errors: [{ messageId: 'styleObject' }],
    },
    {
      code: 'const s = { left: 0 };',
      errors: [{ messageId: 'styleObject' }],
    },
    {
      code: 'const css = ".a { margin-left: 1rem; }";',
      errors: [{ messageId: 'cssText' }],
    },
    {
      code: 'const css = `.a { text-align: left; }`;',
      errors: [{ messageId: 'cssText' }],
    },
    {
      code: 'const c = "ml-4 flex";',
      errors: [{ messageId: 'tailwind' }],
    },
    {
      code: 'const c = "flex text-left";',
      errors: [{ messageId: 'tailwind' }],
    },
    {
      code: 'const el = <div className="pl-2" />;',
      errors: [{ messageId: 'tailwind' }],
    },
  ],
});

// ── ADR-0004 + threat model: user content is never raw HTML ──────────────────
ruleTester.run('no-dangerous-html', noDangerousHtml, {
  valid: [
    { code: 'const el = <div>{content}</div>;' },
    { code: 'const props = { className: "x" };' },
  ],
  invalid: [
    {
      code: 'const el = <div dangerouslySetInnerHTML={{ __html: content }} />;',
      errors: [{ messageId: 'banned' }],
    },
    {
      code: 'React.createElement("div", { dangerouslySetInnerHTML: { __html: x } });',
      errors: [{ messageId: 'banned' }],
    },
  ],
});

// ── ADR-0003 + ADR-0001: the domain core stays ORM-free ──────────────────────
ruleTester.run('no-prisma-outside-db', noPrismaOutsideDb, {
  valid: [
    {
      code: 'import { PrismaClient } from "@prisma/client";',
      filename: '/repo/packages/db/src/client.ts',
    },
    {
      code: 'import { buildDocument } from "./document.js";',
      filename: '/repo/packages/core/src/invitation/usecases/publish.ts',
    },
  ],
  invalid: [
    {
      code: 'import { PrismaClient } from "@prisma/client";',
      filename: '/repo/packages/core/src/invitation/usecases/publish.ts',
      errors: [{ messageId: 'banned' }],
    },
    {
      code: 'const { PrismaClient } = require("@prisma/client");',
      filename: '/repo/apps/web/src/app/api/route.ts',
      errors: [{ messageId: 'banned' }],
    },
    {
      code: 'const m = await import("@prisma/client");',
      filename: '/repo/packages/core/src/x.ts',
      errors: [{ messageId: 'banned' }],
    },
  ],
});

// ── ADR-0015: Saudi Arabia is the first market, not a hard-coded assumption ──
ruleTester.run('no-market-literals', noMarketLiterals, {
  valid: [
    {
      code: 'export const SA = { currency: { code: "SAR" }, defaultTimezone: "Asia/Riyadh" };',
      filename: '/repo/packages/core/src/market/sa.ts',
    },
    {
      code: 'const currency = market.currency.code;',
      filename: '/repo/packages/core/src/billing/price.ts',
    },
    {
      code: 'const tz = invitation.timezone;',
      filename: '/repo/apps/web/src/app/i/[slug]/page.tsx',
    },
    // Test files are exempt so fixtures can name concrete markets.
    {
      code: 'const c = "SAR";',
      filename: '/repo/packages/core/src/billing/price.test.ts',
    },
  ],
  invalid: [
    {
      code: 'const currency = "SAR";',
      filename: '/repo/packages/core/src/billing/price.ts',
      errors: [{ messageId: 'currency' }],
    },
    {
      code: 'const tz = "Asia/Riyadh";',
      filename: '/repo/apps/web/src/lib/time.ts',
      errors: [{ messageId: 'timezone' }],
    },
    {
      code: 'const prefix = "+966";',
      filename: '/repo/apps/web/src/lib/phone.ts',
      errors: [{ messageId: 'callingCode' }],
    },
    {
      code: 'const VAT_RATE = 0.15;',
      filename: '/repo/packages/core/src/billing/tax.ts',
      errors: [{ messageId: 'taxConstant' }],
    },
    {
      code: 'const TAX_PERCENT = 15;',
      filename: '/repo/packages/core/src/billing/tax.ts',
      errors: [{ messageId: 'taxConstant' }],
    },
  ],
});
