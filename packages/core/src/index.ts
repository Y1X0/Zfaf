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
export * from './invitation/domain/document-patch.js';
export * from './invitation/domain/draft-document.js';
export * from './invitation/domain/snapshot-checksum.js';
export * from './invitation/domain/resolve-document.js';
export * from './invitation/domain/public-access.js';
export * from './invitation/usecases/create-invitation.js';
export * from './invitation/usecases/update-draft.js';
export * from './invitation/usecases/publish-invitation.js';
export * from './invitation/usecases/manage-publication.js';
export * from './invitation/usecases/delete-invitation.js';
export * from './invitation/ports/invitation-repository.js';

// ── rsvp (M7) ───────────────────────────────────────────────────────────────
export * from './rsvp/domain/rsvp-submission.js';
export * from './rsvp/domain/rsvp-csv.js';
export * from './rsvp/ports/rsvp-repository.js';
export * from './rsvp/usecases/submit-rsvp.js';

// ── analytics (M8, ADR-0009) ────────────────────────────────────────────────
export * from './analytics/domain/visitor-hash.js';
export * from './analytics/domain/analytics-event.js';
export * from './analytics/ports/analytics-ports.js';
export * from './analytics/usecases/record-view.js';
export * from './analytics/usecases/flush-analytics.js';
export * from './analytics/usecases/read-analytics.js';

// ── moderation and admin (M8) ───────────────────────────────────────────────
export * from './moderation/ports/cdn-purger.js';
export * from './moderation/ports/admin-repository.js';
export * from './moderation/usecases/moderate-invitation.js';
export * from './moderation/usecases/admin-console.js';

// ── template domain (ADR-0004) ──────────────────────────────────────────────
export * from './template/domain/theme.js';
export * from './template/domain/section.js';
export * from './template/domain/template-manifest.js';
export * from './template/domain/manifest-migrations.js';
export * from './template/ports/template-catalog.js';

// ── billing (ADR-0008, ADR-0014) ────────────────────────────────────────────
export * from './billing/domain/money.js';
export * from './billing/domain/entitlements.js';
export * from './billing/domain/null-payment-provider.js';
export * from './billing/ports/payment-provider.js';

// ── media (ADR-0007) ────────────────────────────────────────────────────────
export * from './media/ports/storage-provider.js';
export * from './media/ports/image-processor.js';
export * from './media/ports/media-repository.js';
export * from './media/domain/image-format.js';
export * from './media/domain/original-filename.js';
export * from './media/domain/upload-policy.js';
export * from './media/domain/media-status.js';
export * from './media/domain/media-deletion.js';
export * from './media/domain/queue-contract.js';
export * from './media/usecases/upload-media.js';
export * from './media/usecases/manage-media.js';
export * from './media/usecases/purge-orphaned-media.js';

// ── identity (ADR-0006, ADR-0018) ───────────────────────────────────────────
export * from './identity/domain/email.js';
export * from './identity/domain/password-policy.js';
export * from './identity/domain/account-status.js';
export * from './identity/domain/session.js';
export * from './identity/domain/totp.js';
export * from './identity/ports/password-hasher.js';
export * from './identity/ports/token-generator.js';
export * from './identity/ports/rate-limiter.js';
export * from './identity/ports/identity-repositories.js';
export * from './identity/ports/two-factor-repository.js';
export * from './identity/ports/mail-service.js';
export * from './identity/usecases/authenticate.js';
export * from './identity/usecases/session-lifecycle.js';
export * from './identity/usecases/credentials.js';
export * from './identity/usecases/two-factor.js';

// ── observability (docs/15) ─────────────────────────────────────────────────
export * from './observability/domain/redaction.js';
export * from './observability/ports/logger.js';
export * from './authz/tenant-context.js';
