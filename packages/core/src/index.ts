// ── ports ───────────────────────────────────────────────────────────────────
export * from './ports/clock.js';
export * from './ports/id-generator.js';

// ── market (ADR-0015) ───────────────────────────────────────────────────────
export * from './market/market-config.js';
export * from './market/markets.js';

// ── authorization (docs/09-auth-and-rbac.md) ────────────────────────────────
export * from './authz/actor.js';
export * from './authz/tenant-scope.js';
export * from './authz/can.js';

// ── invitation domain ───────────────────────────────────────────────────────
export * from './invitation/domain/slug.js';
export * from './invitation/domain/invitation-status.js';
export * from './invitation/domain/event-date-time.js';
export * from './invitation/domain/published-snapshot.js';
export * from './invitation/ports/invitation-repository.js';

// ── template domain (ADR-0004) ──────────────────────────────────────────────
export * from './template/domain/theme.js';
export * from './template/domain/section.js';
export * from './template/domain/template-manifest.js';
export * from './template/domain/manifest-migrations.js';

// ── billing (ADR-0008, ADR-0014) ────────────────────────────────────────────
export * from './billing/domain/money.js';
export * from './billing/domain/entitlements.js';
export * from './billing/domain/null-payment-provider.js';
export * from './billing/ports/payment-provider.js';

// ── media (ADR-0007) ────────────────────────────────────────────────────────
export * from './media/ports/storage-provider.js';

// ── identity (ADR-0006, ADR-0018) ───────────────────────────────────────────
export * from './identity/domain/email.js';
export * from './identity/domain/password-policy.js';
export * from './identity/domain/account-status.js';
export * from './identity/domain/session.js';
export * from './identity/ports/password-hasher.js';
export * from './identity/ports/token-generator.js';
export * from './identity/ports/rate-limiter.js';
export * from './identity/ports/identity-repositories.js';
export * from './identity/ports/mail-service.js';
export * from './identity/usecases/authenticate.js';
export * from './identity/usecases/session-lifecycle.js';
export * from './identity/usecases/credentials.js';
export * from './authz/tenant-context.js';
