'use strict';

const path = require('node:path');

/**
 * Keeps Prisma inside `packages/db` (ADR-0003, ADR-0001).
 *
 * The domain core must stay framework- and ORM-agnostic so it can be tested
 * without a database and later extracted without a rewrite. Data access is
 * reached through repository ports, never through a Prisma client directly.
 */
const BANNED_SOURCES = [/^@prisma\/client(\/.*)?$/, /^\.prisma(\/.*)?$/, /^prisma$/];

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow importing Prisma outside packages/db.',
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
      banned:
        'Import of "{{source}}" is only allowed inside {{allowed}}. Depend on a repository port instead (ADR-0003).',
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allow = options.allow ?? ['packages/db'];
    const filename = (context.filename ?? context.getFilename()).split(path.sep).join('/');

    if (
      allow.some((prefix) => filename.includes(`/${prefix}/`) || filename.startsWith(`${prefix}/`))
    ) {
      return {};
    }

    function check(node, source) {
      if (typeof source !== 'string') return;
      if (BANNED_SOURCES.some((re) => re.test(source))) {
        context.report({
          node,
          messageId: 'banned',
          data: { source, allowed: allow.join(', ') },
        });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node, node.source.value);
      },
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments[0] &&
          node.arguments[0].type === 'Literal'
        ) {
          check(node, node.arguments[0].value);
        }
      },
    };
  },
};
