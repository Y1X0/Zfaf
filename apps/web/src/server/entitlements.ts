import {
  type Entitlements,
  type EntitlementOverride,
  FEATURES,
  FREE_BETA_PLAN,
  type Feature,
  LIMIT_KEYS,
  type LimitKey,
  resolveEntitlements,
} from '@zfaf/core';

import { container } from './container.js';

/**
 * What this account is allowed to do (ADR-0014).
 *
 * Two sources, and deliberately only two:
 *
 *   • **The plan.** Everyone is on `free_beta` while payments are off. This is
 *     the one place that decides that, so switching billing on later is a
 *     change here and nowhere else — the shape ADR-0014 asked for, and the
 *     reason no caller ever learns a plan *name*.
 *   • **Per-user overrides.** Read rather than assumed absent. Nothing in the
 *     product writes an `entitlement_overrides` row today — they are granted by
 *     hand, for a trial or a partnership — and a grant that the application
 *     ignores is worse than one that cannot be made: somebody would promise a
 *     customer something the code silently refuses.
 *
 * Resolved per request rather than cached. An override has an expiry, and a
 * process-lifetime cache would keep honouring one for as long as the container
 * stays warm.
 */

const FEATURE_SET = new Set<string>(FEATURES);
const LIMIT_SET = new Set<string>(LIMIT_KEYS);

export async function entitlementsFor(userId: string): Promise<Entitlements> {
  const deps = container();
  const now = deps.clock.now();

  const rows = await deps.prisma.entitlementOverride.findMany({
    where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { feature: true, limitKey: true, numericValue: true, boolValue: true, expiresAt: true },
  });

  const overrides: EntitlementOverride[] = [];
  for (const row of rows) {
    /**
     * A row is trusted for its *values*, not for its *vocabulary*.
     *
     * `feature` and `limit_key` are free-text columns filled in by a human with
     * database access. A typo produces a grant that resolves to nothing, and
     * `resolveEntitlements` would take the misspelling as a `Feature` because
     * TypeScript is not there at runtime. Narrowing here keeps a malformed row
     * out of the resolver rather than into it.
     */
    if (row.feature !== null && FEATURE_SET.has(row.feature) && row.boolValue !== null) {
      overrides.push({
        feature: row.feature as Feature,
        value: row.boolValue,
        expiresAt: row.expiresAt,
      });
      continue;
    }
    if (row.limitKey !== null && LIMIT_SET.has(row.limitKey) && row.numericValue !== null) {
      overrides.push({
        limitKey: row.limitKey as LimitKey,
        value: row.numericValue,
        expiresAt: row.expiresAt,
      });
      continue;
    }
    deps.logger.warn('entitlement.override_unrecognised', {
      userId,
      feature: row.feature ?? '',
      limitKey: row.limitKey ?? '',
    });
  }

  return resolveEntitlements(FREE_BETA_PLAN, overrides, now);
}
