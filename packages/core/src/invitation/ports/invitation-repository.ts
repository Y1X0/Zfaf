import type { TenantScope } from '../../authz/tenant-scope.js';
import type { InvitationStatus } from '../domain/invitation-status.js';
import type { PublishedSnapshot } from '../domain/published-snapshot.js';

/**
 * Invitation repository port.
 *
 * The shape of this interface is the tenant-isolation mechanism, not just a
 * data-access convenience:
 *
 *   • Every private read and write takes a `TenantScope`. There is no
 *     `findById(id)` to accidentally call from a route that forgot its check.
 *   • Public reads use `findPublishedBySlug`, which takes no scope and returns
 *     `PublicInvitationView` — a type that structurally cannot carry owner ids,
 *     draft content or guest data.
 *   • Snapshots are inserted, never updated. No method exists to mutate a
 *     published version (ADR-0005).
 */

export interface InvitationRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly slug: string | null;
  readonly title: string;
  readonly status: InvitationStatus;
  readonly templateKey: string;
  /**
   * The pinned template version row; frozen into every snapshot published.
   *
   * The version *number* is deliberately absent here: the draft document
   * carries it, that is what the projection reads, and a second copy on the
   * record could only ever disagree with the first.
   */
  readonly templateVersionId: string;
  readonly locale: 'ar' | 'en';
  readonly marketCode: string;
  readonly timezone: string;
  readonly eventDate: string;
  readonly eventStartTime: string | null;
  readonly draftDocument: unknown;
  readonly draftVersion: number;
  readonly publishedVersionId: string | null;
  readonly visibility: 'UNLISTED' | 'INDEXED' | 'PROTECTED';
  readonly expiresAt: Date | null;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface InvitationSummary {
  readonly id: string;
  readonly slug: string | null;
  readonly title: string;
  readonly status: InvitationStatus;
  readonly eventDate: string;
  readonly updatedAt: Date;
}

/**
 * What an anonymous visitor may receive.
 *
 * Contains no owner id, no draft, no counters and no guest data. Because the
 * public route can only obtain this type, a field cannot leak by being added to
 * a shared record type later.
 */
export interface PublicInvitationView {
  readonly invitationId: string;
  readonly status: InvitationStatus;
  readonly visibility: 'UNLISTED' | 'INDEXED' | 'PROTECTED';
  readonly snapshot: PublishedSnapshot;
  readonly versionNumber: number;
  readonly expiresAt: Date | null;
}

export interface CreateInvitationInput {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly templateKey: string;
  readonly templateVersion: number;
  /** The pinned template version row; frozen into every snapshot published. */
  readonly templateVersionId: string;
  readonly locale: 'ar' | 'en';
  readonly marketCode: string;
  readonly timezone: string;
  readonly eventDate: string;
  readonly draftDocument: unknown;
  readonly now: Date;
}

export interface PublishInput {
  readonly invitationId: string;
  readonly slug: string;
  readonly snapshot: PublishedSnapshot;
  readonly publishedBy: string;
  readonly expiresAt: Date | null;
  readonly now: Date;
}

export type PublishOutcome =
  | { readonly ok: true; readonly versionId: string; readonly versionNumber: number }
  | { readonly ok: false; readonly error: 'SLUG_TAKEN' | 'NOT_FOUND' | 'ILLEGAL_TRANSITION' };

export type RollbackOutcome =
  | { readonly ok: true; readonly versionId: string; readonly versionNumber: number }
  | { readonly ok: false; readonly error: 'NOT_FOUND' | 'NO_SUCH_VERSION' | 'NOT_PUBLISHED' };

export type UpdateDraftOutcome =
  | { readonly ok: true; readonly draftVersion: number }
  | {
      readonly ok: false;
      readonly error: 'NOT_FOUND' | 'VERSION_CONFLICT';
      readonly currentVersion?: number;
    };

export interface InvitationRepository {
  // ── Owner-scoped reads. A scope is required; there is no unscoped variant. ──
  findByIdInScope(id: string, scope: TenantScope): Promise<InvitationRecord | null>;
  listInScope(
    scope: TenantScope,
    filter?: { status?: InvitationStatus },
  ): Promise<readonly InvitationSummary[]>;
  countActiveInScope(scope: TenantScope): Promise<number>;

  // ── Public read. No scope, and a deliberately narrower return type. ──
  findPublishedBySlug(slug: string): Promise<PublicInvitationView | null>;
  /** Resolves a renamed slug so links already sent keep working (ADR-0013). */
  findSlugRedirect(oldSlug: string): Promise<string | null>;

  /**
   * Whether a slug could be claimed right now.
   *
   * Advisory only, for the publish dialog. It is never the thing that makes
   * publishing safe — a check here and a write a second later is a race, so
   * uniqueness is enforced by the database index and this only exists to spare
   * the owner a pointless round trip (ADR-0013).
   */
  isSlugAvailable(slug: string): Promise<boolean>;

  // ── Writes, all scoped. ──
  create(input: CreateInvitationInput): Promise<InvitationRecord>;

  /**
   * Optimistic-concurrency draft update.
   *
   * `expectedVersion` makes a lost update impossible: two tabs editing the same
   * invitation cannot silently overwrite one another.
   */
  updateDraft(
    id: string,
    scope: TenantScope,
    draftDocument: unknown,
    expectedVersion: number,
    now: Date,
  ): Promise<UpdateDraftOutcome>;

  /**
   * Publishes atomically: insert a new immutable version and move the pointer.
   *
   * Slug uniqueness is enforced by a database constraint, not a prior read, so
   * two simultaneous publishes of the same slug cannot both succeed.
   */
  publish(input: PublishInput, scope: TenantScope): Promise<PublishOutcome>;

  transitionStatus(
    id: string,
    scope: TenantScope,
    next: InvitationStatus,
    now: Date,
  ): Promise<boolean>;

  /**
   * Points the invitation back at an earlier version (D6.3).
   *
   * A pointer move and nothing else: the version being left is not deleted and
   * the version being returned to is not rewritten. Rolling back is itself
   * reversible, which is the property that makes it safe to offer at all.
   */
  rollbackToVersion(
    id: string,
    scope: TenantScope,
    versionNumber: number,
    now: Date,
  ): Promise<RollbackOutcome>;

  /**
   * Expires invitations whose date has passed. Returns the ids it changed.
   *
   * The one write on this port with no `TenantScope`, and the exception needs
   * its justification stated: it is a scheduled system task, it moves only
   * PUBLISHED to EXPIRED, and only for rows whose own `expiresAt` has already
   * passed. It reads no content and returns no content, so there is nothing
   * for a missing scope to leak. Anything broader belongs on a scoped method.
   */
  expireDueInvitations(now: Date, limit: number): Promise<readonly string[]>;

  /**
   * Changes who may find the invitation (ADR-0017).
   *
   * A column on the invitation rather than a field in the document, because it
   * is not part of what guests see — it decides how the response is served,
   * and it must be changeable without publishing a new version.
   */
  setVisibility(
    id: string,
    scope: TenantScope,
    visibility: 'UNLISTED' | 'INDEXED',
    now: Date,
  ): Promise<boolean>;

  softDelete(id: string, scope: TenantScope, now: Date): Promise<boolean>;

  /** Read-only access to history. There is no method to modify a version. */
  listVersions(
    id: string,
    scope: TenantScope,
  ): Promise<readonly { versionId: string; versionNumber: number; publishedAt: Date }[]>;

  getVersionSnapshot(
    id: string,
    versionNumber: number,
    scope: TenantScope,
  ): Promise<PublishedSnapshot | null>;
}
