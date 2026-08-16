import type { Clock } from '../../ports/clock.js';
import type { InvitationRepository } from '../../invitation/ports/invitation-repository.js';
import { resolvePublicAccess } from '../../invitation/domain/public-access.js';

import {
  type AnalyticsBeacon,
  AnalyticsBeaconSchema,
  type PendingAnalyticsEvent,
} from '../domain/analytics-event.js';
import { type AnalyticsBuffer, type DailySaltStore } from '../ports/analytics-ports.js';
import { deviceClassOf, visitorHash } from '../domain/visitor-hash.js';

/**
 * Counting one view (D8.1, D8.2).
 *
 * The rule that shapes everything below: **this can fail in any way it likes
 * and the visitor must never find out.** A guest opening a wedding invitation
 * is not our user, has not asked to be counted, and their page must not show a
 * console error, a failed request badge, or a delay because our Redis was
 * briefly unreachable. The route answers `204` unconditionally; this function
 * returns an outcome for our own logs and metrics, not for them.
 *
 * The other rule is that **nothing identifying survives the call**. The IP
 * address arrives as an argument, is mixed into a hash with a salt that will
 * not exist tomorrow, and is never returned, stored or logged.
 */

export type RecordViewOutcome =
  | { readonly recorded: true }
  | {
      readonly recorded: false;
      readonly reason: 'INVALID' | 'UNKNOWN_SLUG' | 'NOT_PUBLIC' | 'BUFFER_UNAVAILABLE';
    };

export interface RecordViewDeps {
  readonly invitations: InvitationRepository;
  readonly salt: DailySaltStore;
  readonly buffer: AnalyticsBuffer;
  readonly clock: Clock;
}

export interface RecordViewInput {
  readonly beacon: unknown;
  /** Used to derive the hash, then discarded. Never stored, never logged. */
  readonly ip: string;
  readonly userAgent: string | null;
}

export async function recordView(
  input: RecordViewInput,
  deps: RecordViewDeps,
): Promise<RecordViewOutcome> {
  const parsed = AnalyticsBeaconSchema.safeParse(input.beacon);
  if (!parsed.success) return { recorded: false, reason: 'INVALID' };
  const beacon: AnalyticsBeacon = parsed.data;

  const identity = await deps.invitations.resolvePublicSlug(beacon.slug);
  if (!identity) return { recorded: false, reason: 'UNKNOWN_SLUG' };

  const now = deps.clock.now();

  /**
   * A view only counts if the page was actually servable.
   *
   * Without this, a suspended invitation would keep accruing views from a
   * scanner replaying the beacon, and the couple's numbers would disagree with
   * what anybody could actually see. It also means the same decision function
   * governs both the page and its counter, so the two cannot drift.
   */
  const access = resolvePublicAccess({
    status: identity.status,
    expiresAt: identity.expiresAt,
    now,
  });
  if (access.kind !== 'VISIBLE') return { recorded: false, reason: 'NOT_PUBLIC' };

  try {
    const salt = await deps.salt.currentSalt(now);
    const event: PendingAnalyticsEvent = {
      invitationId: identity.invitationId,
      type: beacon.type,
      visitorHash: visitorHash({
        salt,
        ip: input.ip,
        userAgent: input.userAgent,
        invitationId: identity.invitationId,
      }),
      deviceClass: deviceClassOf(input.userAgent),
      occurredAt: now,
    };

    await deps.buffer.push(event);
    return { recorded: true };
  } catch {
    // Redis is down, or the salt could not be minted. A missing view is a
    // rounding error in a chart; a failed request on somebody's wedding
    // invitation is not.
    return { recorded: false, reason: 'BUFFER_UNAVAILABLE' };
  }
}
