'use strict';

const path = require('node:path');

/**
 * Keeps market-specific values out of application code (ADR-0015).
 *
 * Saudi Arabia is the first market, not a baked-in assumption. Currency codes,
 * calling codes and time zones belong to `MarketConfig` data; adding Kuwait or
 * the UAE later must be a config row, not a code change.
 *
 * Tax constants are banned outright: no tax logic may be written on our own
 * assumptions before a qualified specialist has verified it (ADR-0008).
 */

const CURRENCY_CODES = new Set([
  'SAR',
  'KWD',
  'AED',
  'BHD',
  'QAR',
  'OMR',
  'EGP',
  'JOD',
  'USD',
  'EUR',
  'GBP',
]);

const CALLING_CODE_RE = /^\+(?:9\d{2}|1|2\d{1,2}|[3-8]\d{0,2})$/;
const IANA_TZ_RE =
  /^(Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/;
const CURRENCY_SYMBOL_RE = /^(ر\.س|د\.ك|د\.إ|ر\.ق|ر\.ع|د\.ب)$/;
const TAX_IDENTIFIER_RE = /^(VAT|TAX|ZATCA)_?[A-Z_]*(RATE|PERCENT|BPS|AMOUNT)?$/i;

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hard-coded market-specific values (currency, calling code, time zone, tax rate) outside market configuration.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      currency:
        'Hard-coded currency "{{value}}". Read it from MarketConfig.currency instead (ADR-0015).',
      callingCode:
        'Hard-coded calling code "{{value}}". Read it from MarketConfig.phone instead (ADR-0015).',
      timezone:
        'Hard-coded time zone "{{value}}". Read it from MarketConfig.defaultTimezone or the invitation itself (ADR-0015).',
      taxConstant:
        'Hard-coded tax constant "{{name}}". No tax logic may be written before a specialist has verified it — use the configurable TaxConfig (ADR-0008, ADR-0015).',
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allow = options.allow ?? ['packages/core/src/market', 'markets'];
    const filename = (context.filename ?? context.getFilename()).split(path.sep).join('/');

    const isExempt =
      allow.some(
        (prefix) => filename.includes(`/${prefix}/`) || filename.startsWith(`${prefix}/`),
      ) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
      filename.includes('/__fixtures__/') ||
      filename.includes('/fixtures/');

    if (isExempt) return {};

    function checkString(node, value) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 64) return;

      if (CURRENCY_CODES.has(value) || CURRENCY_SYMBOL_RE.test(value)) {
        context.report({ node, messageId: 'currency', data: { value } });
        return;
      }
      if (value.startsWith('+') && CALLING_CODE_RE.test(value)) {
        context.report({ node, messageId: 'callingCode', data: { value } });
        return;
      }
      if (IANA_TZ_RE.test(value)) {
        context.report({ node, messageId: 'timezone', data: { value } });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') checkString(node, node.value);
      },

      TemplateElement(node) {
        checkString(node, node.value.cooked ?? node.value.raw);
      },

      VariableDeclarator(node) {
        if (
          node.id.type === 'Identifier' &&
          TAX_IDENTIFIER_RE.test(node.id.name) &&
          node.init &&
          node.init.type === 'Literal' &&
          typeof node.init.value === 'number'
        ) {
          context.report({
            node,
            messageId: 'taxConstant',
            data: { name: node.id.name },
          });
        }
      },
    };
  },
};
