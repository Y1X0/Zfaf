import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { type PublishedSnapshot, type Theme } from '@zfaf/core';

import { InvitationRenderer, renderSections } from './InvitationRenderer.js';
import { defaultRegistry } from '../registry/default-registry.js';
import { SectionRegistry } from '../registry/registry.js';
import { defineProps } from '../registry/schema.js';
import type { SectionRenderProps, SectionVariantDefinition } from '../registry/types.js';
import { themeToStyleSheet } from '../theme/to-css-variables.js';
import { safeMapUrl, safeMediaUrl } from '../sections/shared.js';
import { validateManifest } from '../validate/validate-manifest.js';
import { manifestFor, render, snapshotFrom } from '../testing/snapshot-fixture.js';

/**
 * Security properties of the template engine.
 *
 * The threat these tests describe is specific: a **manifest, theme or snapshot
 * that an attacker controls**. That is not hypothetical — the marketplace in
 * docs/05-template-engine.md §9 accepts manifests from third-party designers,
 * and content fields are typed by couples.
 *
 * So the tests are written against the two boundaries that matter:
 *
 *   • Content and theme reach the guest's browser as *markup*. The assertions
 *     are therefore on the rendered HTML string, not on React elements — an
 *     element tree cannot tell you whether escaping happened.
 *   • A manifest names capability, it never supplies it. Several tests
 *     deliberately bypass the schemas (`as unknown as`) to simulate a snapshot
 *     altered outside the application, because a defence that only holds while
 *     the schema holds is one layer, not defence in depth.
 */

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Builds a snapshot the schemas would have refused.
 *
 * Casting is the point: it models a row edited in the database, a snapshot
 * restored from an old backup, or a schema that was looser when the row was
 * written. Every assertion downstream is about what the renderer does on its
 * own, without the schema's help.
 */
function hostileSnapshot(
  templateKey: string,
  mutate: (draft: Record<string, unknown>) => void,
): PublishedSnapshot {
  const draft = JSON.parse(JSON.stringify(snapshotFrom(templateKey))) as Record<string, unknown>;
  mutate(draft);
  return draft as unknown as PublishedSnapshot;
}

/**
 * Asserts that nothing in the markup is an element or attribute a section did
 * not author.
 *
 * Written structurally rather than as `not.toContain('onerror')`, because
 * escaped payload text legitimately contains those characters — an assertion
 * on the substring would fail on *correctly* escaped output and pass on some
 * broken output. What matters is whether a token sits inside a tag.
 */
function expectNoInjectedMarkup(markup: string): void {
  for (const tag of ['script', 'iframe', 'object', 'embed', 'base', 'meta']) {
    expect(markup).not.toMatch(new RegExp(`<${tag}[\\s/>]`, 'i'));
  }
  // An `on…=` inside a tag is an event handler; inside a text node it is text.
  expect(markup).not.toMatch(/<[a-zA-Z][^>]*\son[a-z]+\s*=/);
  // Likewise a scheme: dangerous as an attribute value, inert as prose. The
  // quote is unescaped here, which is precisely what distinguishes the two —
  // escaped output reads `href=&quot;javascript:` and does not match.
  expect(markup).not.toMatch(
    /\s(?:href|src|action|formaction|srcdoc|xlink:href)\s*=\s*["']?\s*(?:javascript|vbscript|data):/i,
  );
}

/** React's own escaping, so the tests assert against the real entity set. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

/** Payloads that have historically escaped naive template engines. */
const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror="alert(1)">',
  '"><script>alert(String.fromCharCode(88))</script>',
  "';alert(1);//",
  '<svg/onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '{{constructor.constructor("alert(1)")()}}',
  '${alert(1)}',
  '<style>@import url(//evil.test)</style>',
  '<a href="javascript:alert(1)">click</a>',
] as const;

// ── 1. script injection through content ────────────────────────────────────

describe('content cannot introduce script', () => {
  it.each(XSS_PAYLOADS)('escapes %s in the couple names', (payload) => {
    const markup = render(
      snapshotFrom('classic-luxury', {
        // `shortName` is capped at 40 characters by the content schema, so it
        // is left alone here — this test is about escaping, and a rejected
        // snapshot would prove nothing about it.
        content: { couple: { groomName: payload, brideName: payload } },
      }),
    );

    expectNoInjectedMarkup(markup);
    // The payload is still *shown* — escaped, as the text a couple typed.
    expect(markup).toContain(escapeHtml(payload));
  });

  it.each(XSS_PAYLOADS)('escapes %s in the couple message', (payload) => {
    const markup = render(
      snapshotFrom('classic-luxury', { content: { couple: { message: payload } } }),
    );
    expectNoInjectedMarkup(markup);
    expect(markup).toContain(escapeHtml(payload));
  });

  it('escapes markup in event titles, descriptions and venue names', () => {
    const markup = render(
      snapshotFrom('classic-luxury', {
        content: {
          events: [
            {
              id: 'e1',
              type: 'wedding',
              title: '<script>alert("title")</script>',
              description: '<img src=x onerror=alert(1)>',
              date: '2026-09-20',
              startTime: '20:00',
              endTime: null,
              timezone: 'Asia/Riyadh',
              venueName: '</section><script>alert(2)</script>',
              venueAddress: null,
              mapsUrl: null,
              sortOrder: 1,
            },
          ],
        },
      }),
    );

    expectNoInjectedMarkup(markup);
    expect(markup).toContain('&lt;script&gt;');
  });

  it('escapes markup in the venue name and address', () => {
    const markup = render(
      snapshotFrom('classic-luxury', {
        content: {
          location: {
            venueName: '<script>alert(1)</script>',
            address: '"><img src=x onerror=alert(1)>',
          },
        },
      }),
    );
    expectNoInjectedMarkup(markup);
  });

  it('cannot break out of an attribute through image alt text', () => {
    // `alt` is one of the few places content lands inside an attribute rather
    // than in a text node, so it gets its own test.
    const markup = render(
      snapshotFrom('classic-luxury', {
        content: {
          couple: {
            photo: {
              id: 'm1',
              url: 'https://cdn.zfaf.app/couple.avif',
              width: 100,
              height: 100,
              blurhash: null,
              alt: '" onload="alert(1)" data-x="',
            },
          },
        },
      }),
    );

    expect(markup).not.toContain('onload="alert(1)"');
    expect(markup).toContain('&quot;');
  });

  it('renders no element the sections did not author, for any payload', () => {
    // A whole-document check rather than a per-field one: it holds even if a
    // later section starts rendering a field the tests above do not name.
    const markup = render(
      snapshotFrom('royal-gold', {
        content: {
          couple: {
            groomName: XSS_PAYLOADS[0],
            brideName: XSS_PAYLOADS[4],
            message: XSS_PAYLOADS[1],
          },
          location: { venueName: XSS_PAYLOADS[2], address: XSS_PAYLOADS[5] },
          music: { attribution: XSS_PAYLOADS[8], title: XSS_PAYLOADS[9] },
        },
      }),
    );

    // `form` and `link` are absent from this list on purpose: the RSVP section
    // authors a form, and React emits preload links for above-the-fold images.
    // Both are ours, so listing them would be asserting a falsehood.
    const tags = new Set([...markup.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]));
    for (const forbidden of ['script', 'iframe', 'object', 'embed', 'base', 'meta']) {
      expect(tags.has(forbidden)).toBe(false);
    }
    expectNoInjectedMarkup(markup);
  });
});

// ── 2. the renderer emits no unescaped-HTML sink ───────────────────────────

describe('the renderer has no raw-HTML sink', () => {
  it('never calls dangerouslySetInnerHTML outside the theme stylesheet', () => {
    // Enforced statically by the `zfaf/no-dangerous-html` ESLint rule; asserted
    // here too so the property survives a lint config change.
    const markup = render(snapshotFrom('classic-luxury'));
    const styleBlocks = markup.match(/<style[^>]*>([\s\S]*?)<\/style>/g) ?? [];
    expect(styleBlocks).toHaveLength(1);
    // Nothing outside that one style element may contain a `<` that came from
    // data: everything else is escaped.
    expect(markup.replace(styleBlocks[0] as string, '')).not.toContain('<script');
  });

  it('emits a nonce on the style element when one is supplied', () => {
    // The public page runs under a strict CSP; the inline theme must carry the
    // page's nonce rather than force `unsafe-inline`.
    const markup = render(snapshotFrom('classic-luxury'), 'published', { styleNonce: 'n0nce' });
    expect(markup).toContain('nonce="n0nce"');
  });
});

// ── 3. malicious URLs ──────────────────────────────────────────────────────

describe('malicious URLs never reach an attribute', () => {
  const HOSTILE_URLS = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'http://maps.google.com/?q=1',
    'https://evil.test/maps?q=1',
    'https://maps.google.com.evil.test/?q=1',
    'https://evil.test/#maps.google.com',
    'file:///etc/passwd',
    'not a url at all',
  ] as const;

  it.each(HOSTILE_URLS)('safeMapUrl rejects %s', (candidate) => {
    expect(safeMapUrl(candidate)).toBeNull();
  });

  it('safeMapUrl accepts an allowlisted https host', () => {
    expect(safeMapUrl('https://maps.google.com/?q=24.7,46.6')).toBe(
      'https://maps.google.com/?q=24.7,46.6',
    );
  });

  it.each(HOSTILE_URLS)('safeMediaUrl rejects %s', (candidate) => {
    if (candidate === 'https://evil.test/maps?q=1') return; // media is not host-restricted
    if (candidate === 'https://maps.google.com.evil.test/?q=1') return;
    if (candidate === 'https://evil.test/#maps.google.com') return;
    expect(safeMediaUrl(candidate)).toBeNull();
  });

  it('a javascript: maps URL produces no link at all', () => {
    const markup = render(
      hostileSnapshot('classic-luxury', (draft) => {
        const content = draft['content'] as Record<string, Record<string, unknown>>;
        (content['location'] as Record<string, unknown>)['mapsUrl'] = 'javascript:alert(1)';
      }),
    );

    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('href="javascript');
  });

  it('a non-allowlisted map host produces no link at all', () => {
    const markup = render(
      hostileSnapshot('classic-luxury', (draft) => {
        const content = draft['content'] as Record<string, Record<string, unknown>>;
        (content['location'] as Record<string, unknown>)['mapsUrl'] = 'https://evil.test/?q=1';
      }),
    );
    expect(markup).not.toContain('evil.test');
  });

  it('every emitted href is https and every rel is safe', () => {
    const markup = render(snapshotFrom('classic-luxury'));
    const hrefs = [...markup.matchAll(/href="([^"]*)"/g)].map((match) => match[1] as string);

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith('https://') || href.startsWith('#')).toBe(true);
    }
    // Every external link opens in a new tab, so every one needs noopener.
    const targeted = markup.match(/target="_blank"/g)?.length ?? 0;
    const opener = markup.match(/rel="noopener noreferrer"/g)?.length ?? 0;
    expect(opener).toBe(targeted);
  });

  it('a javascript: image URL renders no image element', () => {
    const markup = render(
      hostileSnapshot('classic-luxury', (draft) => {
        const content = draft['content'] as Record<string, unknown>;
        (content['cover'] as Record<string, unknown>)['url'] = 'javascript:alert(1)';
        ((content['couple'] as Record<string, unknown>)['photo'] as Record<string, unknown>)[
          'url'
        ] = 'javascript:alert(1)';
        content['gallery'] = [
          { id: 'g1', url: 'javascript:alert(1)', width: 1, height: 1, blurhash: null, alt: null },
        ];
      }),
    );
    expect(markup).not.toContain('javascript:');
  });

  it('a data: audio URL renders no audio element', () => {
    const markup = render(
      hostileSnapshot('classic-luxury', (draft) => {
        const content = draft['content'] as Record<string, Record<string, unknown>>;
        (content['music'] as Record<string, unknown>)['url'] = 'data:text/html,<script>alert(1)';
      }),
    );
    expect(markup).not.toContain('<audio');
    expect(markup).not.toContain('data:text/html');
  });
});

// ── 4. CSS injection through the theme ─────────────────────────────────────

describe('a theme cannot inject CSS', () => {
  const HOSTILE_COLORS = [
    'red; } body { display: none } .x {',
    '#fff; background: url(//evil.test/log)',
    'expression(alert(1))',
    'var(--x)',
    'url(javascript:alert(1))',
    '</style><script>alert(1)</script>',
    '#ffffff}@import"//evil.test"',
  ] as const;

  it.each(HOSTILE_COLORS)('substitutes a safe default for %s', (value) => {
    const theme = {
      ...(snapshotFrom('classic-luxury').theme as Theme),
      colors: {
        primary: value,
        secondary: value,
        accent: value,
        background: value,
        surface: value,
        textPrimary: value,
        textSecondary: value,
        overlay: value,
      },
    } as unknown as Theme;

    const css = themeToStyleSheet(theme);

    // Structure first: the sheet has exactly the two rules and one media query
    // we author. A value that escaped its declaration would add a brace.
    expect((css.match(/{/g) ?? []).length).toBe(3);
    expect((css.match(/}/g) ?? []).length).toBe(3);
    // Then the payload itself: none of it survives anywhere.
    expect(css).not.toContain('@import');
    expect(css).not.toContain('expression');
    expect(css).not.toContain('evil.test');
    expect(css).not.toContain('</style');
    expect(css).not.toContain('display: none');
    // Every colour fell back to a known-safe default.
    expect(css).toContain('--zf-color-primary:#b8860b');
  });

  it('substitutes a known font stack for an unknown font key', () => {
    const base = snapshotFrom('classic-luxury').theme as Theme;
    const theme = {
      ...base,
      typography: { ...base.typography, displayFont: 'evil"; }', bodyFont: '__proto__' },
    } as unknown as Theme;

    const css = themeToStyleSheet(theme);
    expect(css).not.toContain('evil');
    expect(css).toContain('--zf-font-display:"Inter"');
  });

  it('the emitted stylesheet has exactly the braces it authored', () => {
    // A structural check rather than a value check: if any value escaped its
    // declaration, the brace count would not match the two rules we write.
    const css = themeToStyleSheet(snapshotFrom('royal-gold').theme as Theme);
    expect((css.match(/{/g) ?? []).length).toBe(3);
    expect((css.match(/}/g) ?? []).length).toBe(3);
  });

  it('a hostile theme still renders the invitation', () => {
    // Fail-soft: an unreadable palette is a bad wedding page; a blank one is an
    // unrecoverable night.
    const markup = render(
      hostileSnapshot('classic-luxury', (draft) => {
        const theme = draft['theme'] as Record<string, Record<string, unknown>>;
        (theme['colors'] as Record<string, unknown>)['primary'] = 'red;}body{display:none}';
      }),
    );
    expect(markup).toContain('data-section="hero"');
    expect(markup).not.toContain('display:none');
  });
});

// ── 5. registry bypass ─────────────────────────────────────────────────────

describe('a manifest cannot bypass the section registry', () => {
  it('rejects a manifest naming a variant that is not registered', () => {
    const manifest = manifestFor('classic-luxury');
    const sections = manifest['sections'] as Record<string, unknown>[];
    (sections[0] as Record<string, unknown>)['variant'] = 'hero.attackerSupplied';

    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.issues.some((issue) => issue.message.includes('Unknown variant'))).toBe(true);
  });

  it('rejects a variant borrowed from a different section type', () => {
    const manifest = manifestFor('classic-luxury');
    const sections = manifest['sections'] as Record<string, unknown>[];
    (sections[0] as Record<string, unknown>)['variant'] = 'rsvp.compactForm';

    expect(validateManifest(manifest).ok).toBe(false);
  });

  it('renders a fallback — never the named variant — for an unknown variant', () => {
    const snapshot = hostileSnapshot('classic-luxury', (draft) => {
      const sections = draft['sections'] as Record<string, unknown>[];
      (sections[0] as Record<string, unknown>)['variant'] = 'hero.notAThing';
    });

    const { diagnostics } = renderSections(snapshot);
    expect(diagnostics.some((d) => d.reason === 'UNKNOWN_VARIANT')).toBe(true);
    expect(renderToStaticMarkup(<InvitationRenderer snapshot={snapshot} />)).not.toContain(
      'notAThing',
    );
  });

  it('refuses to register a variant whose id is not namespaced under its type', () => {
    const registry = new SectionRegistry();
    expect(() =>
      registry.register({
        id: 'evil.hero',
        type: 'hero',
        propsSchema: defineProps({}),
        Component: () => null,
        editor: [],
        capabilities: {},
        a11y: {},
      } as unknown as SectionVariantDefinition<Record<string, unknown>>),
    ).toThrow(/namespaced/);
  });

  it('refuses to overwrite a registered variant', () => {
    // Overwriting would change how already published invitations render — the
    // one thing a published snapshot promises will not happen.
    const definition = defaultRegistry.get('hero.centeredArch');
    expect(definition).toBeDefined();
    const registry = new SectionRegistry();
    registry.register(definition as SectionVariantDefinition<Record<string, unknown>>);
    expect(() =>
      registry.register(definition as SectionVariantDefinition<Record<string, unknown>>),
    ).toThrow(/already registered/);
  });

  it('a manifest cannot supply a component', () => {
    // The schema is `.strict()`, so an extra key is a hard failure rather than
    // a silently ignored field.
    const manifest = manifestFor('classic-luxury');
    const sections = manifest['sections'] as Record<string, unknown>[];
    (sections[0] as Record<string, unknown>)['component'] = 'function(){return 1}';

    expect(validateManifest(manifest).ok).toBe(false);
  });

  it('a props value that looks like code is rendered as text, never evaluated', () => {
    const snapshot = hostileSnapshot('classic-luxury', (draft) => {
      const sections = draft['sections'] as Record<string, unknown>[];
      (sections[0] as Record<string, unknown>)['props'] = {
        eyebrow: 'alert(1)',
        onClick: 'alert(2)',
        __html: '<script>alert(3)</script>',
      };
    });

    const markup = render(snapshot);
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('onClick');
    expect(markup).not.toContain('alert(2)');
  });
});

// ── 6. prototype pollution ─────────────────────────────────────────────────

describe('prototype pollution is refused', () => {
  it.each(['__proto__', 'constructor', 'prototype'])(
    'parseManifest rejects a manifest containing "%s"',
    (key) => {
      const manifest = manifestFor('classic-luxury');
      const sections = manifest['sections'] as Record<string, unknown>[];
      // Assigned through defineProperty so `__proto__` becomes an own key
      // rather than a setter call — which is exactly how it arrives from
      // JSON.parse.
      Object.defineProperty(sections[0] as object, key, {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'a props object containing "%s" falls back to the defaults',
    (key) => {
      const schema = defineProps<{ eyebrow: string }>({
        eyebrow: { kind: 'text', default: 'safe', maxLength: 40 },
      });

      const input: Record<string, unknown> = { eyebrow: 'hello' };
      Object.defineProperty(input, key, {
        value: { isAdmin: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });

      const parsed = schema.parse(input);
      expect(parsed.ok).toBe(false);
    },
  );

  it('rendering a hostile snapshot does not pollute Object.prototype', () => {
    const snapshot = hostileSnapshot('classic-luxury', (draft) => {
      const sections = draft['sections'] as Record<string, unknown>[];
      const props: Record<string, unknown> = {};
      Object.defineProperty(props, '__proto__', {
        value: { polluted: 'yes' },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      (sections[0] as Record<string, unknown>)['props'] = props;
    });

    render(snapshot);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

// ── 7. what a section can reach ────────────────────────────────────────────

describe('a section cannot reach beyond its props', () => {
  it('receives exactly the declared contract and nothing else', () => {
    // The strongest statement this suite makes: a section rendered from an
    // attacker-authored manifest is handed no repository, no request context
    // and no tenant identifier, so there is nothing for it to reach.
    const seen: string[][] = [];
    const values: unknown[] = [];

    const registry = new SectionRegistry();
    registry.register({
      id: 'hero.spy',
      type: 'hero',
      propsSchema: defineProps({}),
      editor: [],
      capabilities: {},
      a11y: {},
      Component: (props: SectionRenderProps<Record<string, unknown>>) => {
        seen.push(Object.keys(props).sort());
        values.push(...Object.values(props));
        return null;
      },
    } as unknown as SectionVariantDefinition<Record<string, unknown>>);

    const snapshot = hostileSnapshot('classic-luxury', (draft) => {
      const sections = draft['sections'] as Record<string, unknown>[];
      draft['sections'] = [{ ...(sections[0] as object), variant: 'hero.spy', type: 'hero' }];
    });

    renderToStaticMarkup(<InvitationRenderer snapshot={snapshot} registry={registry} />);

    expect(seen).toHaveLength(1);
    /**
     * The contract in full, and it is deliberately an exact list.
     *
     * `formAction` and `formStatus` joined it in M7 so the RSVP form can post
     * without a section constructing a URL. Both are inert data — a string the
     * *caller* decided, and a value from a closed set — and neither is a
     * capability: a section still cannot fetch, query or learn who is asking.
     * Any future addition should have to pass the same bar, which is why this
     * assertion names every key rather than checking for absences.
     */
    expect(seen[0]).toEqual([
      'content',
      'dir',
      'formAction',
      'formStatus',
      'index',
      'locale',
      'mode',
      'props',
      'sectionId',
      'theme',
    ]);
    // No callable arrived with the props: a function is how a capability would
    // be smuggled in.
    expect(values.some((value) => typeof value === 'function')).toBe(false);
    // And nothing arrived that a section could call into or walk: the two
    // additions are a string and a string, or absent.
    expect(values.every((value) => value === undefined || typeof value !== 'symbol')).toBe(true);
  });

  it('is handed no tenant, account, invitation or repository identifier', () => {
    let received: SectionRenderProps<Record<string, unknown>> | null = null;

    const registry = new SectionRegistry();
    registry.register({
      id: 'hero.spy',
      type: 'hero',
      propsSchema: defineProps({}),
      editor: [],
      capabilities: {},
      a11y: {},
      Component: (props: SectionRenderProps<Record<string, unknown>>) => {
        received = props;
        return null;
      },
    } as unknown as SectionVariantDefinition<Record<string, unknown>>);

    const snapshot = hostileSnapshot('classic-luxury', (draft) => {
      const sections = draft['sections'] as Record<string, unknown>[];
      draft['sections'] = [{ ...(sections[0] as object), variant: 'hero.spy', type: 'hero' }];
    });

    renderToStaticMarkup(<InvitationRenderer snapshot={snapshot} registry={registry} />);

    const serialised = JSON.stringify(received);
    for (const forbidden of ['tenantId', 'accountId', 'userId', 'invitationId', 'ownerId']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

// ── 8. no I/O from the render path ─────────────────────────────────────────

describe('rendering performs no I/O', () => {
  it('makes no network request', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('the render path must not perform network I/O');
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      for (const templateKey of ['classic-luxury', 'royal-gold', 'minimal-white']) {
        expect(render(snapshotFrom(templateKey))).toContain('zf-invitation');
      }
    } finally {
      globalThis.fetch = original;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders a hostile snapshot without reading the filesystem or the network', () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const markup = render(
        hostileSnapshot('classic-luxury', (draft) => {
          const content = draft['content'] as Record<string, Record<string, unknown>>;
          (content['location'] as Record<string, unknown>)['mapsUrl'] = 'file:///etc/passwd';
          (content['music'] as Record<string, unknown>)['url'] = 'file:///etc/shadow';
          (content['cover'] as Record<string, unknown>)['url'] = 'file:///etc/hosts';
        }),
      );
      expect(markup).not.toContain('/etc/');
      expect(markup).not.toContain('file:');
    } finally {
      globalThis.fetch = original;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── 9. malformed payloads ──────────────────────────────────────────────────

describe('malformed payloads degrade rather than break', () => {
  it.each([
    ['a section with no props at all', (s: Record<string, unknown>) => delete s['props']],
    ['props as a string', (s: Record<string, unknown>) => (s['props'] = 'not an object')],
    ['props as an array', (s: Record<string, unknown>) => (s['props'] = [1, 2, 3])],
    ['props as null', (s: Record<string, unknown>) => (s['props'] = null)],
    [
      'a prop of the wrong type',
      (s: Record<string, unknown>) => (s['props'] = { eyebrow: { nested: true } }),
    ],
    [
      'a wildly out-of-range number',
      (s: Record<string, unknown>) => (s['props'] = { columns: Number.MAX_SAFE_INTEGER }),
    ],
    ['NaN as a number prop', (s: Record<string, unknown>) => (s['props'] = { columns: NaN })],
  ])('still renders the invitation with %s', (_label, mutate) => {
    const snapshot = hostileSnapshot('classic-luxury', (draft) => {
      for (const section of draft['sections'] as Record<string, unknown>[]) {
        mutate(section);
      }
    });

    const markup = render(snapshot);
    expect(markup).toContain('zf-invitation');
    expect(markup).toContain('data-section="hero"');
  });

  it('a section whose component throws does not take the page down', () => {
    const registry = new SectionRegistry();
    registry.register({
      id: 'hero.explodes',
      type: 'hero',
      propsSchema: defineProps({}),
      editor: [],
      capabilities: {},
      a11y: {},
      Component: () => {
        throw new Error('boom');
      },
    } as unknown as SectionVariantDefinition<Record<string, unknown>>);
    for (const definition of ['couple.stacked', 'footer.minimal']) {
      const shipped = defaultRegistry.get(definition);
      if (shipped) registry.register(shipped as SectionVariantDefinition<Record<string, unknown>>);
    }

    const snapshot = hostileSnapshot('classic-luxury', (draft) => {
      draft['sections'] = [
        { id: 'hero', type: 'hero', variant: 'hero.explodes', enabled: true, order: 0, props: {} },
        {
          id: 'footer',
          type: 'footer',
          variant: 'footer.minimal',
          enabled: true,
          order: 1,
          props: {},
        },
      ];
    });

    const markup = renderToStaticMarkup(
      <InvitationRenderer snapshot={snapshot} registry={registry} />,
    );
    expect(markup).toContain('zf-invitation');
    expect(markup).not.toContain('boom');
  });

  it('an oversized manifest is rejected before it is parsed', () => {
    const oversized = JSON.stringify(manifestFor('classic-luxury')).padEnd(200_000, ' ');
    const result = validateManifest(oversized);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/size limit/);
  });

  it.each([
    ['not JSON at all', '{ this is not json'],
    ['a bare string', '"hello"'],
    ['a number', 42],
    ['null', null],
    ['an array', []],
    ['an empty object', {}],
  ])('rejects %s as a manifest', (_label, input) => {
    expect(validateManifest(input as unknown).ok).toBe(false);
  });
});
