import { getEnv } from '@zfaf/config';
import type { HumanCheck } from '@zfaf/core';

/**
 * Cloudflare Turnstile, behind the domain's `HumanCheck` port (D7.3).
 *
 * Only consulted once an invitation is already under unusual load — see
 * `needsHumanCheck` below. Putting a challenge in front of every guest would
 * cost replies from exactly the people least likely to persist: an aunt on a
 * slow phone, invited to a wedding, who did not ask to prove anything.
 *
 * Three failure modes, and each has a deliberate answer:
 *
 *   • **Not configured.** Verification passes. The threshold that summoned it
 *     is a suspicion, not a finding, and refusing every reply because we have
 *     not set a key would turn a missing secret into an outage.
 *   • **Configured, token missing or rejected.** Verification fails. This is
 *     the case the feature exists for.
 *   • **Configured, Cloudflare unreachable.** Verification passes, and the
 *     failure is logged. A third party being down must not stop guests
 *     replying to a wedding tomorrow; the rate limits are still in force.
 */

const VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 4000;

export class TurnstileHumanCheck implements HumanCheck {
  async verify(token: string | null): Promise<boolean> {
    const secret = secretKey();
    if (!secret) return true;
    if (!token) return false;

    try {
      const response = await fetch(VERIFY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token }),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      const body = (await response.json()) as { success?: boolean };
      return body.success === true;
    } catch (error) {
      console.error('[turnstile] verification unreachable; allowing the reply', error);
      return true;
    }
  }
}

function secretKey(): string | undefined {
  try {
    return getEnv().TURNSTILE_SECRET_KEY || undefined;
  } catch {
    return undefined;
  }
}

/**
 * When an invitation is busy enough to warrant a challenge.
 *
 * Measured per invitation rather than per visitor, because the thing worth
 * detecting is one invitation being hammered — a guest replying once looks
 * identical to a bot replying once, and only the aggregate distinguishes them.
 *
 * The threshold is deliberately well above a real wedding's traffic. Guests
 * reply in bursts after the link goes out, and a limit tuned to catch that
 * would challenge the honest rush and nothing else.
 */
export const HUMAN_CHECK_THRESHOLD = { limit: 30, windowMs: 10 * 60 * 1000 } as const;
