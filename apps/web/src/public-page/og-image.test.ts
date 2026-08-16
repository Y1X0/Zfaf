import { describe, expect, it } from 'vitest';

import { OG_HEIGHT, OG_WIDTH, ogSvg, renderFallbackOgImage, renderOgImage } from './og-image.js';

/**
 * The link preview card (D6.6).
 *
 * What these tests can prove is that the card is a real image of the right
 * size, that user input cannot break out of the SVG, and that the fallback
 * works. What they cannot prove is that the Arabic is *shaped correctly* —
 * that was established by rendering a card and looking at it, and it is why
 * this module uses resvg rather than Satori at all (see the module comment).
 * The standing check on shaping is the WhatsApp verification gate.
 */

const COLORS = {
  background: '#fffdf8',
  primary: '#8a6d24',
  text: '#241f1a',
  muted: '#5c5348',
};

describe('ogSvg', () => {
  it('escapes a name that would otherwise close the text element', () => {
    // The couple's names are user input on their way into a document built by
    // string concatenation, which is exactly the shape of an injection bug.
    const svg = ogSvg({
      title: '</text><script>alert(1)</script>',
      subtitle: 'x',
      locale: 'en',
      colors: COLORS,
    });

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/text&gt;');
  });

  it('escapes a colour that tries to close its attribute', () => {
    const svg = ogSvg({
      title: 'x',
      subtitle: 'y',
      locale: 'en',
      colors: { ...COLORS, background: '"/><script>alert(1)</script><rect fill="' },
    });
    expect(svg).not.toContain('<script>');
  });

  it('takes its text direction from the invitation’s own language', () => {
    expect(ogSvg({ title: 'أحمد', subtitle: 'س', locale: 'ar', colors: COLORS })).toContain(
      'direction="rtl"',
    );
    expect(ogSvg({ title: 'A', subtitle: 'B', locale: 'en', colors: COLORS })).toContain(
      'direction="ltr"',
    );
  });

  it('shrinks a long title rather than letting it overflow the card', () => {
    const short = ogSvg({ title: 'أ و س', subtitle: '', locale: 'ar', colors: COLORS });
    const long = ogSvg({ title: 'ا'.repeat(60), subtitle: '', locale: 'ar', colors: COLORS });
    const size = (svg: string) => Number(/font-size="(\d+)"/.exec(svg)?.[1] ?? 0);
    expect(size(long)).toBeLessThan(size(short));
  });

  it('is the size every chat app expects', () => {
    const svg = ogSvg({ title: 'x', subtitle: 'y', locale: 'en', colors: COLORS });
    expect(svg).toContain(`width="${OG_WIDTH}"`);
    expect(svg).toContain(`height="${OG_HEIGHT}"`);
    expect(OG_WIDTH / OG_HEIGHT).toBeCloseTo(1.91, 1);
  });
});

describe('renderOgImage', () => {
  it('produces a PNG', () => {
    const png = renderOgImage({
      title: 'دعوة زفاف أحمد و سارة',
      subtitle: '20 سبتمبر 2026 · قاعة النخيل',
      locale: 'ar',
      colors: COLORS,
    });
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // A card whose font failed to load still rasterises, but nearly empty.
    expect(png.byteLength).toBeGreaterThan(4000);
  });

  it('is deterministic, so a re-scrape gets the same card', () => {
    const input = { title: 'أحمد و سارة', subtitle: 'س', locale: 'ar' as const, colors: COLORS };
    expect(renderOgImage(input).equals(renderOgImage(input))).toBe(true);
  });

  it('renders a fallback that says nothing about any couple', () => {
    // WhatsApp does not retry: a failed card means the link is shared with no
    // preview at all, forever, for everyone who received that message.
    const png = renderFallbackOgImage();
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.byteLength).toBeGreaterThan(2000);
  });
});
