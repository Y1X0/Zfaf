'use strict';

/**
 * Bans `dangerouslySetInnerHTML` (ADR-0004, threat model §3-I).
 *
 * Invitation content is user data rendered to third parties. React escapes by
 * default; this attribute is the one documented way to defeat that, so it is
 * rejected outright rather than reviewed case by case.
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow dangerouslySetInnerHTML — user content must never be injected as raw HTML.',
    },
    schema: [],
    messages: {
      banned:
        'dangerouslySetInnerHTML is banned: invitation content is user data shown to third parties (ADR-0004). Render it as text.',
    },
  },

  create(context) {
    return {
      JSXAttribute(node) {
        if (
          node.name &&
          node.name.type === 'JSXIdentifier' &&
          node.name.name === 'dangerouslySetInnerHTML'
        ) {
          context.report({ node, messageId: 'banned' });
        }
      },
      Property(node) {
        const key = node.key;
        const name =
          key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : null;
        if (name === 'dangerouslySetInnerHTML') {
          context.report({ node: key, messageId: 'banned' });
        }
      },
    };
  },
};
