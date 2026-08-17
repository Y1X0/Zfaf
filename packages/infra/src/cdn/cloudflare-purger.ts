import type { CdnPurger, CdnPurgeOutcome } from '@zfaf/core';

/**
 * Purging the edge by URL (D8.5, Go-Live gate 2).
 *
 * Cloudflare's `purge_cache` endpoint, given an explicit list of files. The
 * M8 implementation purged by `cache-tag` instead; the owner's Go-Live
 * decision is single-file purge, as simpler and more precise, and the domain
 * now hands over the exact paths — the page, its preview image, and every
 * address the invitation used to answer on (ADR-0013).
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
  /**
   * The public origin the paths hang off.
   *
   * Configuration, not domain knowledge — which is why the port takes paths
   * and this joins them. A mismatch here purges nothing while reporting
   * success, so it is required rather than inferred from anything.
   */
  readonly publicBaseUrl: string;
  /** Overridable so a test can point at a local server instead of the internet. */
  readonly endpoint?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Cloudflare accepts at most 30 files per call.
 *
 * An invitation renamed a dozen times would exceed it, which is unlikely and
 * not a reason to silently drop the tail.
 */
const MAX_FILES_PER_CALL = 30;

export class CloudflareCdnPurger implements CdnPurger {
  readonly key = 'cloudflare';

  constructor(private readonly config: CloudflarePurgerConfig) {}

  async purgePaths(paths: readonly string[]): Promise<CdnPurgeOutcome> {
    if (paths.length === 0) {
      // A draft occupies no public address. Nothing to clear is a correct
      // outcome, not a failure — but it is not a success either, and saying
      // `purged: true` would put a claim in the audit log that means nothing.
      return { purged: false, reason: 'no cached addresses to purge' };
    }

    const files: string[] = [];
    for (const path of paths) {
      try {
        files.push(new URL(path, this.config.publicBaseUrl).toString());
      } catch {
        return { purged: false, reason: 'public base URL is not a valid origin' };
      }
    }

    let purged = 0;
    for (let index = 0; index < files.length; index += MAX_FILES_PER_CALL) {
      const batch = files.slice(index, index + MAX_FILES_PER_CALL);
      const outcome = await this.call(batch);
      if (!outcome.purged) {
        // Partial success is reported as failure with the count, because
        // "we cleared four of six" is what an incident review needs to read.
        return purged === 0
          ? outcome
          : { purged: false, reason: `${outcome.reason} (after ${purged} cleared)` };
      }
      purged += batch.length;
    }

    return { purged: true, urls: purged };
  }

  private async call(files: readonly string[]): Promise<CdnPurgeOutcome> {
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
        body: JSON.stringify({ files }),
        signal: abort,
      });

      if (!response.ok) {
        // The status only — not the body. A provider error body can contain
        // account identifiers, and this string is written into the audit log.
        return { purged: false, reason: `cloudflare responded ${response.status}` };
      }

      return { purged: true, urls: files.length };
    } catch (error) {
      return {
        purged: false,
        reason: error instanceof Error ? `purge failed: ${error.message}` : 'purge failed',
      };
    }
  }
}
