'use strict';

/**
 * Enforces CSS Logical Properties (ADR-0011).
 *
 * Arabic is the product's primary language and RTL is the default direction.
 * Physical properties (`margin-left`, `pl-4`, `text-align: left`) silently break
 * RTL and accumulate into permanent technical debt, so they are rejected in
 * shared UI and in the invitation renderer.
 */

/** camelCase style-object keys → logical replacement */
const STYLE_OBJECT_PROPS = {
  marginLeft: 'marginInlineStart',
  marginRight: 'marginInlineEnd',
  paddingLeft: 'paddingInlineStart',
  paddingRight: 'paddingInlineEnd',
  borderLeft: 'borderInlineStart',
  borderRight: 'borderInlineEnd',
  borderLeftWidth: 'borderInlineStartWidth',
  borderRightWidth: 'borderInlineEndWidth',
  borderLeftColor: 'borderInlineStartColor',
  borderRightColor: 'borderInlineEndColor',
  borderLeftStyle: 'borderInlineStartStyle',
  borderRightStyle: 'borderInlineEndStyle',
  borderTopLeftRadius: 'borderStartStartRadius',
  borderTopRightRadius: 'borderStartEndRadius',
  borderBottomLeftRadius: 'borderEndStartRadius',
  borderBottomRightRadius: 'borderEndEndRadius',
  left: 'insetInlineStart',
  right: 'insetInlineEnd',
};

/** kebab-case declarations inside CSS strings/templates */
const CSS_DECLARATION_RE = /(?:^|[;{\s])(margin|padding|border)-(left|right)\s*:/i;
const CSS_INSET_RE = /(?:^|[;{\s])(left|right)\s*:/i;
const CSS_TEXT_ALIGN_RE = /text-align\s*:\s*(left|right)\b/i;
const CSS_FLOAT_RE = /(?:^|[;{\s])float\s*:\s*(left|right)\b/i;

/** Tailwind physical utilities → logical replacement */
const TAILWIND_CLASSES = [
  [/(?:^|\s)-?ml-/, 'ms-*'],
  [/(?:^|\s)-?mr-/, 'me-*'],
  [/(?:^|\s)-?pl-/, 'ps-*'],
  [/(?:^|\s)-?pr-/, 'pe-*'],
  [/(?:^|\s)-?left-/, 'start-*'],
  [/(?:^|\s)-?right-/, 'end-*'],
  [/(?:^|\s)text-left(?:\s|$)/, 'text-start'],
  [/(?:^|\s)text-right(?:\s|$)/, 'text-end'],
  [/(?:^|\s)border-l(?:-|\s|$)/, 'border-s-*'],
  [/(?:^|\s)border-r(?:-|\s|$)/, 'border-e-*'],
  [/(?:^|\s)rounded-l(?:-|\s|$)/, 'rounded-s-*'],
  [/(?:^|\s)rounded-r(?:-|\s|$)/, 'rounded-e-*'],
  [/(?:^|\s)float-left(?:\s|$)/, 'float-start'],
  [/(?:^|\s)float-right(?:\s|$)/, 'float-end'],
];

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow physical CSS properties and Tailwind utilities; require logical equivalents (ADR-0011).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          checkTailwind: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      styleObject:
        'Physical CSS property "{{found}}" breaks RTL. Use "{{suggestion}}" instead (ADR-0011).',
      cssText:
        'Physical CSS declaration "{{found}}" breaks RTL. Use the logical equivalent (ADR-0011).',
      tailwind:
        'Physical Tailwind utility "{{found}}" breaks RTL. Use "{{suggestion}}" instead (ADR-0011).',
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const checkTailwind = options.checkTailwind !== false;

    function checkStringValue(node, raw) {
      if (typeof raw !== 'string' || raw.length === 0) return;

      const declaration =
        CSS_DECLARATION_RE.exec(raw) ||
        CSS_TEXT_ALIGN_RE.exec(raw) ||
        CSS_FLOAT_RE.exec(raw) ||
        CSS_INSET_RE.exec(raw);

      if (declaration) {
        context.report({
          node,
          messageId: 'cssText',
          data: { found: declaration[0].trim() },
        });
        return;
      }

      if (!checkTailwind) return;

      for (const [pattern, suggestion] of TAILWIND_CLASSES) {
        const match = pattern.exec(raw);
        if (match) {
          context.report({
            node,
            messageId: 'tailwind',
            data: { found: match[0].trim(), suggestion },
          });
          return;
        }
      }
    }

    return {
      Property(node) {
        const key = node.key;
        const name =
          key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : null;
        if (name && Object.hasOwn(STYLE_OBJECT_PROPS, name)) {
          context.report({
            node: key,
            messageId: 'styleObject',
            data: { found: name, suggestion: STYLE_OBJECT_PROPS[name] },
          });
        }
      },

      Literal(node) {
        if (typeof node.value === 'string') checkStringValue(node, node.value);
      },

      TemplateElement(node) {
        checkStringValue(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
