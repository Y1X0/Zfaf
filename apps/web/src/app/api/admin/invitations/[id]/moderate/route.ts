import { type ModerationAction, moderateInvitation } from '@zfaf/core';

import { adminNotFound, adminSession, withAdminHeaders } from '../../../../../../server/admin.js';
import { container } from '../../../../../../server/container.js';
import { clientIpHash } from '../../../../../../server/request-context.js';
import { badRequest, conflict, ok, readJsonBody } from '../../../../../../server/responses.js';
import { requireSameOrigin } from '../../../../../../server/origin.js';

/**
 * `POST /api/admin/invitations/{id}/moderate` — the kill switch (D8.5).
 *
 * The specification lists `/suspend` and `/unsuspend` as separate paths. They
 * are one endpoint here with an `action` field, because the two are the same
 * operation in opposite directions and splitting them would mean two copies of
 * the authorise-write-purge-audit sequence — which is exactly the sequence
 * where a divergence would be a security bug rather than an inconsistency.
 *
 * Three things this route will not do:
 *
 *   • **It will not accept an unexplained suspension.** A reason is required,
 *     because a moderation action nobody can justify six months later is one
 *     the platform cannot defend.
 *   • **It will not report a purge that did not happen.** If the CDN is
 *     unconfigured or the call fails, the invitation is still suspended and
 *     the response says `purged: false` with the reason. Claiming otherwise
 *     would leave an operator believing a page was pulled when it is still
 *     being served from the edge.
 *   • **It will not let an owner lift a block on themselves.** That is
 *     enforced two layers down, in the transition table and the permission
 *     table both.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const gate = await adminSession();
  if (!gate.ok) return gate.response;

  const body = await readJsonBody(request, 4 * 1024);
  if (!body.ok) return withAdminHeaders(body.response);

  const parsed = parseCommand(body.body);
  if (!parsed) {
    return withAdminHeaders(
      badRequest(
        'INVALID_MODERATION',
        'Provide an action of "suspend" or "unsuspend" and a reason',
      ),
    );
  }

  const { id } = await context.params;
  const deps = container();
  const ipHash = await clientIpHash();

  const result = await moderateInvitation(
    {
      actor: gate.session.actor,
      invitationId: id,
      action: parsed.action,
      reason: parsed.reason,
    },
    {
      admin: deps.admin,
      invitations: deps.invitations,
      cdn: deps.cdn,
      clock: deps.clock,
      recordModeration: async (entry) => {
        await deps.audit.record(
          {
            actorId: entry.actorId,
            actorType: 'staff',
            action: `invitation.${entry.action}`,
            resourceType: 'invitation',
            resourceId: entry.invitationId,
            /**
             * The purge outcome is part of the record.
             *
             * "We suspended it at 14:02 but the edge kept serving it for four
             * minutes" is precisely the fact an incident review needs and
             * precisely the one that disappears if only the status change is
             * written down.
             */
            metadata: {
              reason: entry.reason,
              previousStatus: entry.previousStatus,
              nextStatus: entry.nextStatus,
              cdn: entry.cdn,
              purged: entry.purged,
              purgeError: entry.purgeError ?? '',
            },
            ipHash: hexToBytes(ipHash),
          },
          entry.at,
        );
      },
    },
  );

  if (!result.ok) {
    switch (result.code) {
      case 'ILLEGAL_TRANSITION':
        return withAdminHeaders(conflict('ILLEGAL_TRANSITION', result.message));
      case 'INVALID':
        return withAdminHeaders(badRequest('INVALID_MODERATION', result.message));
      // A missing invitation and an operator without the role are the same
      // answer, for the same reason the console answers 404 at its front door.
      case 'NOT_FOUND':
      case 'FORBIDDEN':
        return withAdminHeaders(adminNotFound());
    }
  }

  return withAdminHeaders(
    ok({ status: result.status, purged: result.purged, purgeError: result.purgeError }),
  );
}

function parseCommand(body: unknown): { action: ModerationAction; reason: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = body as Record<string, unknown>;

  const action = value['action'];
  if (action !== 'suspend' && action !== 'unsuspend') return null;

  const reason = value['reason'];
  if (typeof reason !== 'string') return null;

  return { action, reason };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
