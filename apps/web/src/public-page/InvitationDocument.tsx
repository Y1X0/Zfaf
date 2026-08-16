import type { ReactElement } from 'react';

import type { PublishedSnapshot } from '@zfaf/core';
import { renderInvitationHtml } from '@zfaf/invitation-renderer/html';

/**
 * The published document (ADR-0020, D6.4, D6.6).
 *
 * Assembled as a string rather than as one React tree, because the tree that
 * would produce it cannot exist: the invitation's sections are pre-rendered
 * with their own error containment (see `@zfaf/invitation-renderer/html`), and
 * splicing pre-rendered HTML into a React tree would need
 * `dangerouslySetInnerHTML`, which is banned outright in this codebase and
 * rightly so.
 *
 * So the pieces are concatenated instead — but **every piece that contains
 * data comes out of `renderToStaticMarkup`**. The couple's names, the venue,
 * the title and the description are all escaped by React exactly as they are
 * in the builder preview. The only strings this module writes by hand are its
 * own literals and values from closed sets (`ar`/`en`, `rtl`/`ltr`) or
 * machine-generated (an ISO instant, a hex nonce).
 *
 * The `<head>` is written here rather than through `generateMetadata` because
 * a Route Handler serves this page. That is a cost of ADR-0020, and it buys
 * exact control over the nonce, the robots directive and the link preview.
 */

export interface InvitationDocumentInput {
  readonly snapshot: PublishedSnapshot;
  readonly canonicalUrl: string;
  readonly ogImageUrl: string;
  readonly robots: string;
  readonly nonce: string;
  /**
   * The instant this response was generated.
   *
   * The countdown corrects the visitor's device clock against it. Phone clocks
   * are wrong often enough that an uncorrected countdown is a real source of
   * "your site says the wedding was yesterday" (D6.9).
   */
  readonly serverNow: string;
  readonly title: string;
  readonly description: string;
  /** Where the RSVP form posts (M7). */
  readonly rsvpAction: string;
  /**
   * The invitation's public name, for the view beacon (M8).
   *
   * The slug and not the invitation id, deliberately. The visitor already has
   * the slug — it is the address they typed or tapped — so putting it in the
   * document tells them nothing new, whereas embedding an internal UUID would
   * hand every reader a durable handle on a database row and hand a scanner an
   * enumeration surface.
   */
  readonly slug: string;
  /**
   * The outcome of a reply the guest was just redirected back from.
   *
   * Rendered on the server because the public page has no client framework to
   * hold it (ADR-0020) — which is also why a guest with JavaScript disabled
   * still learns whether their reply was recorded.
   */
  readonly rsvpStatus?: 'ok' | 'invalid' | 'closed' | 'rate' | 'check' | undefined;
}

export async function renderInvitationDocument(input: InvitationDocumentInput): Promise<{
  html: string;
  failedSections: readonly string[];
}> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { snapshot } = input;

  const body = await renderInvitationHtml(snapshot, {
    styleNonce: input.nonce,
    formAction: input.rsvpAction,
    formStatus: input.rsvpStatus,
  });
  const head = renderToStaticMarkup(<Head {...input} />);
  const share = renderToStaticMarkup(
    <ShareButton title={input.title} url={input.canonicalUrl} locale={snapshot.locale} />,
  );
  const documentStyle = renderToStaticMarkup(
    <style nonce={input.nonce}>{DOCUMENT_STYLESHEET}</style>,
  );

  const dir = snapshot.locale === 'ar' ? 'rtl' : 'ltr';
  /**
   * The slug is escaped here rather than trusted.
   *
   * It is the one value on this line that is neither a literal nor
   * machine-generated, and it is written into an attribute by string
   * concatenation because the `<html>` element is not part of any React tree
   * (see the note at the top of this file). A slug is validated on the way in
   * (ADR-0013) and cannot contain a quote today — which is exactly the kind of
   * fact that changes without anyone remembering this line.
   */
  const slugAttribute = input.slug.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const html =
    `<!DOCTYPE html><html lang="${snapshot.locale}" dir="${dir}" data-server-now="${input.serverNow}" data-invitation-slug="${slugAttribute}">` +
    `<head>${documentStyle}${head}</head>` +
    `<body>${body.html}${share}</body></html>`;

  return { html, failedSections: body.failedSections };
}

function Head({
  snapshot,
  canonicalUrl,
  ogImageUrl,
  robots,
  nonce,
  title,
  description,
}: InvitationDocumentInput): ReactElement {
  return (
    <>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{title}</title>
      <meta name="description" content={description} />
      {/* Default is noindex; an owner has to choose to be listed (ADR-0017). */}
      <meta name="robots" content={robots} />
      <link rel="canonical" href={canonicalUrl} />

      {/* The link preview, which is most of what a WhatsApp recipient sees
          before deciding whether to open anything. */}
      <meta property="og:type" content="website" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:image" content={ogImageUrl} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:locale" content={snapshot.locale === 'ar' ? 'ar_SA' : 'en_US'} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImageUrl} />

      {/* The cover is the largest element above the fold, so it is almost
          always the LCP candidate. Preloading it starts the download during
          head parsing rather than after layout. */}
      {snapshot.content.cover ? (
        <link rel="preload" as="image" href={snapshot.content.cover.url} fetchPriority="high" />
      ) : null}

      {/* `defer` rather than `async`: the document is parsed first, so the
          script never blocks the render and never runs against a half-built
          page. */}
      <script src="/invitation.js" defer nonce={nonce} />
    </>
  );
}

/**
 * The share control (D6.8).
 *
 * Rendered `hidden` and revealed by the script. Showing a button that needs
 * `navigator.share` to a visitor whose script did not load would be offering
 * something that cannot work.
 */
function ShareButton({
  title,
  url,
  locale,
}: {
  title: string;
  url: string;
  locale: 'ar' | 'en';
}): ReactElement {
  return (
    <button
      type="button"
      className="zf-share"
      hidden
      data-share
      data-share-url={url}
      data-share-title={title}
    >
      {locale === 'ar' ? 'مشاركة الدعوة' : 'Share invitation'}
    </button>
  );
}

/**
 * Styles the renderer does not own.
 *
 * Small on purpose. The invitation's own appearance comes from the renderer's
 * theme sheet; this covers only the document frame and the two controls this
 * page adds around it.
 */
const DOCUMENT_STYLESHEET = `
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--zf-color-bg,#fff)}
.zf-share{position:fixed;inset-block-end:1rem;inset-inline-end:1rem;z-index:10;
min-block-size:44px;min-inline-size:44px;padding:.7rem 1.1rem;border:0;border-radius:999px;
background:var(--zf-color-primary,#333);color:var(--zf-color-bg,#fff);font:inherit;font-size:.95rem;
cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.18)}
.zf-share[data-copied]::after{content:' ✓'}
.zf-rsvp__status:empty{display:none}
.zf-rsvp__status{margin-block:0 1rem;padding:.75rem 1rem;border-radius:var(--zf-radius);
background:var(--zf-color-surface);color:var(--zf-color-text);font-size:.95rem;line-height:1.7}
.zf-rsvp__status[data-rsvp-status='ok']{border-inline-start:3px solid var(--zf-color-primary)}
.zf-rsvp__form fieldset{border:0;padding:0;margin:0}
/* A native radio renders about 13px across, which is not a tappable target.
   Sizing the control itself — not only the label around it — is what keeps the
   44px rule true for the thing a thumb actually has to hit. */
.zf-rsvp__option input[type='radio']{inline-size:1.5rem;block-size:1.5rem;
min-inline-size:44px;min-block-size:44px;accent-color:var(--zf-color-primary)}
.zf-lightbox{border:0;padding:0;background:transparent;max-inline-size:96vw;max-block-size:96vh}
.zf-lightbox::backdrop{background:rgba(0,0,0,.86)}
.zf-lightbox__image{display:block;max-inline-size:96vw;max-block-size:90vh;object-fit:contain}
.zf-lightbox__close{position:absolute;inset-block-start:.5rem;inset-inline-end:.5rem;
min-block-size:44px;min-inline-size:44px;border:0;border-radius:999px;background:rgba(0,0,0,.6);
color:#fff;font-size:1.1rem;cursor:pointer}
[data-reveal]{opacity:0;transform:translateY(12px);transition:opacity .5s ease,transform .5s ease}
[data-reveal][data-revealed]{opacity:1;transform:none}
@media (prefers-reduced-motion: reduce){
[data-reveal]{opacity:1;transform:none;transition:none}
}
`.trim();
