'use strict';

const noPhysicalCssProperties = require('./rules/no-physical-css-properties.js');
const noDangerousHtml = require('./rules/no-dangerous-html.js');
const noPrismaOutsideDb = require('./rules/no-prisma-outside-db.js');
const noMarketLiterals = require('./rules/no-market-literals.js');

/**
 * Local ESLint rules that enforce architectural decisions mechanically.
 * Each rule prevents a documented class of defect — see the ADR referenced in
 * the rule's own header.
 */
const plugin = {
  meta: { name: 'eslint-plugin-zfaf', version: '0.1.0' },
  rules: {
    'no-physical-css-properties': noPhysicalCssProperties,
    'no-dangerous-html': noDangerousHtml,
    'no-prisma-outside-db': noPrismaOutsideDb,
    'no-market-literals': noMarketLiterals,
  },
};

module.exports = plugin;
