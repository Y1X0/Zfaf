import { z } from 'zod';

/**
 * Entitlements (ADR-0014).
 *
 * Feature access is answered by one service, never by comparing a plan name.
 * Scattered `plan === 'premium'` checks are how a customer who paid ends up
 * locked out of what they bought, and how adding a plan becomes a forty-file
 * change. The `no-restricted-syntax` lint rule rejects that pattern outright.
 *
 * Built in M1 even though payments arrive in Phase 2: everyone is on
 * `free_beta` today, so when billing is switched on the only thing that changes
 * is where the plan comes from.
 */

export const FEATURES = [
  'invitation.custom_slug',
  'invitation.remove_branding',
  'invitation.password',
  'template.premium',
  'media.custom_music',
  'guest.management',
  'analytics.advanced',
  'domain.custom',
  'team.members',
  'export.csv',
] as const;

export type Feature = (typeof FEATURES)[number];

export const LIMIT_KEYS = [
  'invitation.active',
  'media.gallery_images',
  'media.storage_mb',
  'invitation.active_days_after_event',
  'team.member_count',
] as const;

export type LimitKey = (typeof LIMIT_KEYS)[number];

/** Plan limits are data, not code — a new plan is a row (ADR-0014). */
export const PlanLimitsSchema = z
  .object({
    features: z.array(z.enum(FEATURES)).default([]),
    /** -1 means unlimited; the value is normalised to Infinity on read. */
    limits: z.record(z.enum(LIMIT_KEYS), z.number().int().min(-1)).default({}),
  })
  .strict();

export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

export interface PlanSnapshot {
  readonly key: string;
  readonly level: number;
  readonly limits: PlanLimits;
}

/** A per-user grant that overrides the plan: trials, goodwill, partnerships. */
export interface EntitlementOverride {
  readonly feature?: Feature;
  readonly limitKey?: LimitKey;
  readonly value: number | boolean;
  readonly expiresAt: Date | null;
}

export const UNLIMITED = Number.POSITIVE_INFINITY;

export interface Entitlements {
  can(feature: Feature): boolean;
  limit(key: LimitKey): number;
  planKey(): string;
  planLevel(): number;
}

/**
 * Resolves plan and overrides into an answer.
 *
 * Precedence: active overrides, then the plan, then deny. Expired overrides are
 * ignored rather than removed, so a grant's history stays visible.
 */
export function resolveEntitlements(
  plan: PlanSnapshot,
  overrides: readonly EntitlementOverride[],
  now: Date,
): Entitlements {
  const active = overrides.filter(
    (o) => o.expiresAt === null || o.expiresAt.getTime() > now.getTime(),
  );

  const featureOverrides = new Map<Feature, boolean>();
  const limitOverrides = new Map<LimitKey, number>();

  for (const override of active) {
    if (override.feature !== undefined && typeof override.value === 'boolean') {
      featureOverrides.set(override.feature, override.value);
    }
    if (override.limitKey !== undefined && typeof override.value === 'number') {
      limitOverrides.set(override.limitKey, override.value);
    }
  }

  const planFeatures = new Set<Feature>(plan.limits.features);

  return {
    can(feature) {
      const overridden = featureOverrides.get(feature);
      if (overridden !== undefined) return overridden;
      return planFeatures.has(feature);
    },
    limit(key) {
      const overridden = limitOverrides.get(key);
      const raw = overridden ?? plan.limits.limits[key];
      if (raw === undefined) return 0;
      return raw === -1 ? UNLIMITED : raw;
    },
    planKey: () => plan.key,
    planLevel: () => plan.level,
  };
}

/**
 * Whether one more unit fits within a limit.
 *
 * Takes current usage as an argument rather than querying: the domain stays
 * free of I/O, and the caller already had to load the count anyway.
 */
export function hasRemaining(
  entitlements: Entitlements,
  key: LimitKey,
  currentUsage: number,
): boolean {
  return currentUsage < entitlements.limit(key);
}

/**
 * The MVP plan.
 *
 * Everyone sits here while payments are off. The limits are deliberately real
 * rather than unlimited — shipping with `Infinity` everywhere would leave the
 * enforcement paths untested right up until the moment they start mattering.
 */
export const FREE_BETA_PLAN: PlanSnapshot = {
  key: 'free_beta',
  level: 0,
  limits: PlanLimitsSchema.parse({
    features: ['export.csv', 'invitation.remove_branding'],
    limits: {
      'invitation.active': 3,
      'media.gallery_images': 20,
      'media.storage_mb': 200,
      'invitation.active_days_after_event': 30,
      'team.member_count': 1,
    },
  }),
};
