import type { TwoFactorDependencies } from '@zfaf/core';

import { container } from './container.js';

/**
 * The dependency bundle the two-factor use cases take.
 *
 * Assembled in one place rather than at each route, so a future endpoint
 * cannot accidentally hand in a different rate limiter or — worse — a
 * different cipher, which would produce a credential nothing else can read.
 */
export function twoFactorDependencies(): TwoFactorDependencies {
  const deps = container();
  return {
    users: deps.users,
    sessions: deps.sessions,
    twoFactor: deps.twoFactor,
    audit: deps.audit,
    cipher: deps.cipher,
    tokens: deps.tokens,
    rateLimiter: deps.rateLimiter,
    clock: deps.clock,
    ids: deps.ids,
  };
}
