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

// ── billing (ADR-0008, ADR-0014) ────────────────────────────────────────────
export * from './billing/domain/money.js';
export * from './billing/domain/entitlements.js';
export * from './billing/domain/null-payment-provider.js';
export * from './billing/ports/payment-provider.js';

// ── media (ADR-0007) ────────────────────────────────────────────────────────
export * from './media/ports/storage-provider.js';
