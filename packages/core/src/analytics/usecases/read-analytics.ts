import type { Actor } from '../../authz/actor.js';
import { can } from '../../authz/can.js';
import { tenantScopeFor } from '../../authz/tenant-scope.js';
import type { InvitationRepository } from '../../invitation/ports/invitation-repository.js';
import type { RsvpRepository } from '../../rsvp/ports/rsvp-repository.js';

import type { AnalyticsRepository, InvitationAnalytics } from '../ports/analytics-ports.js';

/**
 * The couple's stats panel (D8.4).
 *
 * Four numbers — views, unique visitors, replies, and which kind of device
 * people opened it on — and that list is a decision, not a starting point. The
 * owner cut this to the minimum for the MVP (ADR-0009 amendment): no map of
 * countries, no referrer breakdown, no time series, no per-section events. A
 * panel that shows less than it could is a panel nobody has to be reassured
 * about.
 *
 * Authorization is `analytics:read`, which platform staff *do* hold — these
 * are aggregate counts about an invitation, not the guest list. `rsvp:read` is
 * the one staff are refused, and the reply figures below come through the same
 * scoped repository the dashboard uses, so a staff member who somehow reached
 * this code path still gets no names.
 */

export interface InvitationStatsPanel {
  readonly views: number;
  readonly uniqueVisitors: number;
  readonly devices: InvitationAnalytics['devices'];
  readonly firstSeenAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly rsvp: {
    readonly responses: number;
    readonly attending: number;
    readonly declined: number;
    readonly guests: number;
  };
}

export type ReadAnalyticsResult =
  | { readonly ok: true; readonly panel: InvitationStatsPanel }
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'NOT_FOUND' };

export interface ReadAnalyticsDeps {
  readonly invitations: InvitationRepository;
  readonly analytics: AnalyticsRepository;
  readonly rsvps: RsvpRepository;
}

export async function invitationStatsPanel(
  input: { readonly actor: Actor; readonly invitationId: string },
  deps: ReadAnalyticsDeps,
): Promise<ReadAnalyticsResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) return { ok: false, code: 'FORBIDDEN' };

  const invitation = await deps.invitations.findByIdInScope(input.invitationId, scope);
  // 404 rather than 403 for somebody else's invitation: a 403 would confirm it
  // exists, which is all an enumeration attempt needs.
  if (!invitation) return { ok: false, code: 'NOT_FOUND' };

  const decision = can(input.actor, 'analytics:read', {
    kind: 'invitation',
    id: invitation.id,
    ownerId: invitation.ownerId,
  });
  if (!decision.allowed) return { ok: false, code: 'FORBIDDEN' };

  const [analytics, rsvpStats] = await Promise.all([
    deps.analytics.statsFor(invitation.id),
    deps.rsvps.statsInScope(invitation.id, scope),
  ]);

  return {
    ok: true,
    panel: {
      views: analytics.views,
      uniqueVisitors: analytics.uniqueVisitors,
      devices: analytics.devices,
      firstSeenAt: analytics.firstSeenAt,
      lastSeenAt: analytics.lastSeenAt,
      rsvp: {
        responses: rsvpStats?.responses ?? 0,
        attending: rsvpStats?.attending ?? 0,
        declined: rsvpStats?.declined ?? 0,
        guests: rsvpStats?.guests ?? 0,
      },
    },
  };
}
