import { describe, expect, it } from 'vitest';

import {
  FREE_BETA_PLAN,
  type PlanSnapshot,
  UNLIMITED,
  hasRemaining,
  resolveEntitlements,
} from './entitlements.js';

const NOW = new Date('2026-08-16T00:00:00.000Z');

const premium: PlanSnapshot = {
  key: 'premium',
  level: 2,
  limits: {
    features: ['invitation.custom_slug', 'analytics.advanced', 'export.csv'],
    limits: { 'invitation.active': -1, 'media.gallery_images': 60 },
  },
};

describe('resolveEntitlements', () => {
  it('grants the features the plan lists', () => {
    const ent = resolveEntitlements(premium, [], NOW);
    expect(ent.can('invitation.custom_slug')).toBe(true);
    expect(ent.can('analytics.advanced')).toBe(true);
  });

  it('denies features the plan does not list', () => {
    const ent = resolveEntitlements(premium, [], NOW);
    expect(ent.can('domain.custom')).toBe(false);
    expect(ent.can('guest.management')).toBe(false);
  });

  it('reads limits from the plan', () => {
    const ent = resolveEntitlements(premium, [], NOW);
    expect(ent.limit('media.gallery_images')).toBe(60);
  });

  it('treats -1 as unlimited', () => {
    const ent = resolveEntitlements(premium, [], NOW);
    expect(ent.limit('invitation.active')).toBe(UNLIMITED);
  });

  it('denies an unknown limit rather than defaulting to permissive', () => {
    const ent = resolveEntitlements(premium, [], NOW);
    expect(ent.limit('team.member_count')).toBe(0);
  });
});

describe('overrides', () => {
  it('can grant a feature the plan withholds', () => {
    const ent = resolveEntitlements(
      FREE_BETA_PLAN,
      [{ feature: 'domain.custom', value: true, expiresAt: null }],
      NOW,
    );
    expect(ent.can('domain.custom')).toBe(true);
  });

  it('can revoke a feature the plan grants', () => {
    const ent = resolveEntitlements(
      premium,
      [{ feature: 'analytics.advanced', value: false, expiresAt: null }],
      NOW,
    );
    expect(ent.can('analytics.advanced')).toBe(false);
  });

  it('can raise a limit', () => {
    const ent = resolveEntitlements(
      FREE_BETA_PLAN,
      [{ limitKey: 'media.gallery_images', value: 100, expiresAt: null }],
      NOW,
    );
    expect(ent.limit('media.gallery_images')).toBe(100);
  });

  it('ignores an expired override', () => {
    const ent = resolveEntitlements(
      FREE_BETA_PLAN,
      [
        {
          feature: 'domain.custom',
          value: true,
          expiresAt: new Date('2026-08-15T00:00:00.000Z'),
        },
      ],
      NOW,
    );
    expect(ent.can('domain.custom')).toBe(false);
  });

  it('honours an override that has not yet expired', () => {
    const ent = resolveEntitlements(
      FREE_BETA_PLAN,
      [
        {
          feature: 'domain.custom',
          value: true,
          expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      ],
      NOW,
    );
    expect(ent.can('domain.custom')).toBe(true);
  });
});

describe('hasRemaining', () => {
  it('allows another unit below the limit and refuses at it', () => {
    const ent = resolveEntitlements(FREE_BETA_PLAN, [], NOW);
    expect(ent.limit('invitation.active')).toBe(3);
    expect(hasRemaining(ent, 'invitation.active', 2)).toBe(true);
    expect(hasRemaining(ent, 'invitation.active', 3)).toBe(false);
    expect(hasRemaining(ent, 'invitation.active', 9)).toBe(false);
  });

  it('always has room under an unlimited limit', () => {
    const ent = resolveEntitlements(premium, [], NOW);
    expect(hasRemaining(ent, 'invitation.active', 10_000)).toBe(true);
  });
});

describe('the MVP plan', () => {
  it('enforces real limits rather than shipping everything unlimited', () => {
    // Shipping with Infinity everywhere would leave the enforcement paths
    // untested right up until the moment they start mattering.
    const ent = resolveEntitlements(FREE_BETA_PLAN, [], NOW);
    expect(ent.limit('invitation.active')).toBeLessThan(UNLIMITED);
    expect(ent.limit('media.gallery_images')).toBeGreaterThan(0);
    expect(ent.planKey()).toBe('free_beta');
    expect(ent.planLevel()).toBe(0);
  });

  it('withholds the features that are meant to be paid later', () => {
    const ent = resolveEntitlements(FREE_BETA_PLAN, [], NOW);
    expect(ent.can('domain.custom')).toBe(false);
    expect(ent.can('guest.management')).toBe(false);
    expect(ent.can('media.custom_music')).toBe(false);
  });
});
