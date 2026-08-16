import type { CdnPurger, CdnPurgeOutcome } from '@zfaf/core';

/**
 * Purging the edge by cache tag (D8.5).
 *
 * Cloudflare's purge-by-tag endpoint. The public route stamps every invitation
 * response with `cache-tag: invitation:{id}`, so one call clears the page, its
 * OG image and any old slug still in circulation — which purging by URL could
 * not do, because we do not know every URL the page has ever been reachable at
 * (ADR-0013).
 *
 * Everything here is written on the assumption that **this call can fail and
 * the suspension must stand anyway**. It never throws: a network error, a
 * rejected token and a 500 from Cloudflare all come back as
 * `{ purged: false, reason }`, and the caller records that in the audit entry
 * rather than treating the moderation action as failed. The row change already
 * protects every visitor whose request reaches our origin; a failed purge
 * means some cached copies linger for up to the TTL, and the honest thing is
 * to say so in the audit log instead of pretending either way.
 */

export interface CloudflarePurgerConfig {
  readonly zoneId: string;
  readonly apiToken: string;
  /** Overridable so a test can point at a local server instead of the internet. */
  readonly endpoint?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class CloudflareCdnPurger implements CdnPurger {
  readonly key = 'cloudflare';

  constructor(private readonly config: CloudflarePurgerConfig) {}

  async purgeTag(tag: string): Promise<CdnPurgeOutcome> {
    const url =
      this.config.endpoint ??
      `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(this.config.zoneId)}/purge_cache`;

    // A moderation action must not hang on a third party. Five seconds, then
    // the purge is reported as failed and the suspension proceeds regardless.
    const abort = AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tags: [tag] }),
        signal: abort,
      });

      if (!response.ok) {
        // The status only — not the body. A provider error body can contain
        // account identifiers, and this string is written into the audit log.
        return { purged: false, reason: `cloudflare responded ${response.status}` };
      }

      return { purged: true };
    } catch (error) {
      return {
        purged: false,
        reason: error instanceof Error ? `purge failed: ${error.message}` : 'purge failed',
      };
    }
  }
}
