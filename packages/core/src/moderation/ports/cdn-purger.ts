/**
 * Removing a page from the edge cache (D8.5).
 *
 * A kill switch that only changes a database row is not a kill switch. A
 * published invitation is served with `s-maxage=300`, so without this the
 * moderated page would keep being handed out by the CDN for up to five minutes
 * after the button was pressed — which, for the reason a kill switch gets
 * pressed at all, is four and a half minutes too long.
 *
 * ## Purging by URL, not by cache tag
 *
 * The M8 implementation purged by `cache-tag`, which is a single call clearing
 * the page and its preview image together. The owner's decision for Go-Live is
 * **purge by URL**, on the grounds that it is simpler, more precise, and does
 * not depend on how a provider resolves one tag across several resources.
 *
 * The cost is real and small: the caller must know which addresses an
 * invitation occupies, rather than stamping one label and forgetting. That
 * knowledge is domain knowledge — `/i/{slug}` and its OG image, plus every
 * address still in circulation after a rename (ADR-0013) — so it lives here,
 * in `invitationCachePaths`, and the adapter only resolves those paths against
 * the origin it was configured with.
 *
 * The `cache-tag` response header stays on the public page. It costs nothing,
 * it is useful for a provider dashboard, and removing it would be a change to
 * M6's response contract for no gain.
 */

export type CdnPurgeOutcome =
  | { readonly purged: true; readonly urls: number }
  /**
   * The purge did not happen, and the caller is expected to say so out loud.
   *
   * Deliberately not an exception. A failed purge must never roll back the
   * suspension: the row change is the part that protects everyone who has not
   * cached the page yet, and losing it because a third-party API was down
   * would be the worst of both outcomes.
   */
  | { readonly purged: false; readonly reason: string };

export interface CdnPurger {
  /** A stable name for logs and the audit entry, e.g. `cloudflare` or `none`. */
  readonly key: string;
  /**
   * Clears these paths from the edge.
   *
   * Paths, not absolute URLs: the origin is deployment configuration and the
   * domain has no business knowing it. The adapter joins the two.
   */
  purgePaths(paths: readonly string[]): Promise<CdnPurgeOutcome>;
}

/**
 * Every address a published invitation occupies.
 *
 * Three things are covered, and the third is the one that gets forgotten:
 *
 *   1. The page itself.
 *   2. Its preview image — the card WhatsApp renders. A suspended invitation
 *      whose image is still cached keeps showing the couple's photograph in
 *      every chat the link was shared to, which for an impersonation report is
 *      most of the harm.
 *   3. **Addresses from before a rename.** ADR-0013 keeps `slug_history` and
 *      answers 301 from the old address, and that redirect is cacheable. A
 *      printed QR code carries the old address forever.
 */
export function invitationCachePaths(
  slug: string | null,
  previousSlugs: readonly string[] = [],
): readonly string[] {
  const slugs = [slug, ...previousSlugs].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  // A draft has no slug and occupies no public address; purging nothing is the
  // correct answer, not an error.
  const unique = [...new Set(slugs)];
  return unique.flatMap((value) => [`/i/${value}`, `/i/${value}/og`]);
}

/** Kept for the `cache-tag` header the public route still stamps (M6). */
export function invitationCacheTag(invitationId: string): string {
  return `invitation:${invitationId}`;
}

/**
 * The purger used when no CDN is configured.
 *
 * Reports honestly that nothing was purged rather than claiming success. In
 * development and in tests there is no edge cache to clear, and a stub that
 * said `purged: true` would make the one test that matters — "the suspension
 * reached the edge" — pass everywhere and mean nothing.
 */
export const NO_CDN_PURGER: CdnPurger = {
  key: 'none',
  purgePaths: async () => ({ purged: false, reason: 'no CDN configured' }),
};
