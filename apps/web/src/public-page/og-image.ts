import { Resvg } from '@resvg/resvg-js';
import { join } from 'node:path';

/**
 * The link preview image (D6.6).
 *
 * Most recipients meet the invitation as a WhatsApp card before they meet the
 * page, so this image is the product's first impression far more often than
 * the invitation itself is.
 *
 * ## Why an SVG rasteriser rather than Satori
 *
 * The obvious tool is `next/og`, which is Satori plus resvg. It was tried
 * first and **it renders Arabic wrongly**: the glyphs are shaped but each
 * word's letters come out in reverse order, so "أحمد و سارة" reads as
 * "دمحأ و ةراس". Satori's own bidi pass reorders text that its shaper has
 * already reordered. For a product whose first market writes right-to-left,
 * a preview card with mangled names is not a cosmetic defect — it is the
 * feature failing.
 *
 * Some Naskh fonts fail earlier still: Amiri and Noto Naskh Arabic both throw
 * `lookupType: 5 - substFormat: 3 is not yet supported` from Satori's OpenType
 * reader, because their substitution tables are richer than it implements.
 *
 * Composing the SVG ourselves and rasterising with resvg avoids both. resvg
 * shapes text through rustybuzz, which handles Arabic joining, bidi and mixed
 * Arabic/Latin runs correctly — verified by rendering and looking, not by
 * reading a compatibility table.
 *
 * ## Why the layout is deliberately plain
 *
 * No photograph, no template theming. A preview card is seen at thumbnail size
 * in a chat list; names and a date at high contrast survive that, and a
 * cropped photograph does not. It also means generation touches no remote
 * media and cannot be made slow by a large upload.
 */

const FONT_PATH = join(process.cwd(), 'assets', 'fonts', 'Amiri-Regular.ttf');

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

export interface OgImageInput {
  readonly title: string;
  readonly subtitle: string;
  readonly locale: 'ar' | 'en';
  readonly colors: {
    readonly background: string;
    readonly primary: string;
    readonly text: string;
    readonly muted: string;
  };
}

/**
 * Escapes text for an XML text node.
 *
 * The couple's names are user input on their way into a document we compose by
 * string concatenation, which is precisely the shape of an injection bug. The
 * names are already validated and length-capped by the snapshot schema; this
 * is the second line, and the one that matters here.
 */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Long names shrink rather than overflow the card. */
function titleFontSize(title: string): number {
  if (title.length <= 24) return 84;
  if (title.length <= 40) return 64;
  return 48;
}

export function ogSvg(input: OgImageInput): string {
  const direction = input.locale === 'ar' ? 'rtl' : 'ltr';
  const size = titleFontSize(input.title);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${escapeXml(input.colors.background)}"/>
  <rect x="0" y="0" width="${OG_WIDTH}" height="10" fill="${escapeXml(input.colors.primary)}"/>
  <rect x="0" y="${OG_HEIGHT - 10}" width="${OG_WIDTH}" height="10" fill="${escapeXml(input.colors.primary)}"/>
  <text x="${OG_WIDTH / 2}" y="${OG_HEIGHT / 2 - 10}" font-family="Amiri" font-size="${size}" fill="${escapeXml(input.colors.text)}" text-anchor="middle" direction="${direction}">${escapeXml(input.title)}</text>
  <text x="${OG_WIDTH / 2}" y="${OG_HEIGHT / 2 + 70}" font-family="Amiri" font-size="34" fill="${escapeXml(input.colors.muted)}" text-anchor="middle" direction="${direction}">${escapeXml(input.subtitle)}</text>
</svg>`;
}

export function renderOgImage(input: OgImageInput): Buffer {
  const resvg = new Resvg(ogSvg(input), {
    font: {
      // The one font the card uses, named by path rather than loaded here:
      // resvg keeps its own font database and re-reading the file on every
      // render would be the only thing this route did twice.
      fontFiles: [FONT_PATH],
      defaultFontFamily: 'Amiri',
      // System fonts would make the output depend on what happens to be
      // installed on the host, so the same invitation could produce different
      // cards from two servers.
      loadSystemFonts: false,
    },
  });
  return Buffer.from(resvg.render().asPng());
}

/**
 * The fallback card (D6.6, "احتياطي فوري").
 *
 * Rendered with the same code path but no couple, so it cannot fail for a
 * reason the real one would not. It exists because a preview that fails to
 * generate produces a *link with no card at all* in WhatsApp, which reads as a
 * broken link — worse than a plain one.
 */
export function renderFallbackOgImage(locale: 'ar' | 'en' = 'ar'): Buffer {
  return renderOgImage({
    title: locale === 'ar' ? 'دعوة زفاف' : 'Wedding Invitation',
    subtitle: locale === 'ar' ? 'اضغط لفتح الدعوة' : 'Tap to open the invitation',
    locale,
    colors: FALLBACK_COLORS,
  });
}

const FALLBACK_COLORS = {
  background: '#fffdf8',
  primary: '#8a6d24',
  text: '#241f1a',
  muted: '#5c5348',
} as const;
