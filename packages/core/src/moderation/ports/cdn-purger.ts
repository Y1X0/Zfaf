/**
 * Removing a page from the edge cache (D8.5).
 *
 * A kill switch that only changes a database row is not a kill switch. A
 * published invitation is served with `s-maxage=300`, so without this the
 * moderated page would keep being handed out by the CDN for up to five minutes
 * after the button was pressed — which, for the reason a kill switch gets
 * pressed at all, is four and a half minutes too long.
 *
 * Purging is by **cache tag**, not by URL. The public route stamps every
 * response with `cache-tag: invitation:{id}`, so one call clears the page and
 * its OG image together, and it keeps working after a slug rename when the old
 * addresses are still in circulation (ADR-0013).
 */

export type CdnPurgeOutcome =
  | { readonly purged: true }
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
  purgeTag(tag: string): Promise<CdnPurgeOutcome>;
}

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
  purgeTag: async () => ({ purged: false, reason: 'no CDN configured' }),
};
