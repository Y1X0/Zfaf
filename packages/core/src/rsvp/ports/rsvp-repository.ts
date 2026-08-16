import type { TenantScope } from '../../authz/tenant-scope.js';

/**
 * RSVP repository port (D7.2, D7.5).
 *
 * Shaped by the same rule as the invitation port: the *type* is the isolation
 * mechanism. Guest data is the most sensitive thing this product holds — real
 * names and phone numbers of people who never agreed to be our users — so
 * there is no unscoped read of it anywhere on this interface.
 *
 * The one method without a scope is `submit`, and it is unscoped because a
 * guest has no account by design (D7.1: "RSVP works without an account"). It
 * takes an invitation id the caller has already resolved from a public slug
 * and verified as published, and it returns nothing about the invitation.
 */

export interface RsvpRecord {
  readonly id: string;
  readonly invitationId: string;
  readonly name: string;
  readonly attending: boolean;
  readonly partySize: number;
  readonly phone: string | null;
  readonly note: string | null;
  readonly source: string;
  readonly submittedAt: Date;
  readonly updatedAt: Date;
}

export interface RsvpStats {
  readonly responses: number;
  readonly attending: number;
  readonly declined: number;
  /** Total people expected, counting each attending guest's party. */
  readonly guests: number;
}

export interface SubmitRsvpCommand {
  readonly id: string;
  readonly invitationId: string;
  readonly name: string;
  readonly attending: boolean;
  readonly partySize: number;
  readonly phone: string | null;
  readonly note: string | null;
  readonly dedupeHash: Uint8Array;
  readonly editTokenHash: Uint8Array;
  readonly source: string;
  readonly now: Date;
}

export type SubmitRsvpOutcome =
  | {
      readonly ok: true;
      readonly rsvpId: string;
      /** False when an earlier response by the same guest was updated. */
      readonly created: boolean;
    }
  | { readonly ok: false; readonly error: 'INVITATION_NOT_ACCEPTING' };

export interface EditRsvpCommand {
  readonly rsvpId: string;
  readonly editTokenHash: Uint8Array;
  readonly attending: boolean;
  readonly partySize: number;
  readonly note: string | null;
  readonly now: Date;
  /** Responses may only be corrected inside this window (D7.4). */
  readonly editableUntil: Date;
}

export type EditRsvpOutcome =
  | { readonly ok: true; readonly rsvpId: string }
  | { readonly ok: false; readonly error: 'NOT_FOUND' | 'WINDOW_CLOSED' | 'BAD_TOKEN' };

export interface RsvpListFilter {
  readonly attending?: boolean;
  /** Matched against name and phone. */
  readonly query?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface RsvpRepository {
  /**
   * Records a response, or updates the one this guest already gave.
   *
   * The insert and the counter update happen in one transaction, and the
   * counters move by a delta rather than being recounted — a recount needs a
   * read, and a read between two concurrent submissions is how a counter ends
   * up wrong.
   */
  submit(input: SubmitRsvpCommand): Promise<SubmitRsvpOutcome>;

  /** Corrects a response, authorised by the guest's own token (D7.4). */
  edit(input: EditRsvpCommand): Promise<EditRsvpOutcome>;

  // ── owner-scoped reads. Guest data never leaves here without a scope. ──
  listInScope(
    invitationId: string,
    scope: TenantScope,
    filter: RsvpListFilter,
  ): Promise<{ readonly rows: readonly RsvpRecord[]; readonly total: number }>;

  statsInScope(invitationId: string, scope: TenantScope): Promise<RsvpStats | null>;

  /** Every response, for export. Bounded, because a browser has to hold it. */
  allInScope(
    invitationId: string,
    scope: TenantScope,
    limit: number,
  ): Promise<readonly RsvpRecord[]>;

  deleteInScope(
    rsvpId: string,
    invitationId: string,
    scope: TenantScope,
    now: Date,
  ): Promise<boolean>;
}
