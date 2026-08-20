import {
  adminNotFound,
  adminSession,
  withAdminHeaders,
} from '../../../../../../server/admin.js';
import { container } from '../../../../../../server/container.js';
import { failure, ok } from '../../../../../../server/responses.js';
import { requireSameOrigin } from '../../../../../../server/origin.js';

/**
 * `POST /api/admin/users/{id}/verify-email` — mark an account as email-verified.
 *
 * Used in pilot mode when PILOT_NO_EMAIL=true disables the actual email
 * provider but EMAIL_NOT_VERIFIED authorization check still blocks publishing.
 * This creates a manual verification path for admin to enable pilot accounts.
 *
 * Design note: This endpoint has NO PILOT_NO_EMAIL guard and stays live in
 * production. An admin can mark any account verified without proving mailbox
 * ownership. This is defensible trade-off: (1) gated by adminSession() auth,
 * (2) fully audited (actorId, timestamp, email recorded), and (3) useful in
 * production for recovery if email verification fails or to bypass verification
 * for legacy migrated accounts. The audit trail enables accountability.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const gate = await adminSession();
  if (!gate.ok) return gate.response;

  const { id } = await context.params;
  const deps = container();

  try {
    const user = await deps.users.findById(id);
    if (!user) return withAdminHeaders(adminNotFound());

    const now = deps.clock.now();

    await deps.users.markEmailVerified(id, now);

    const adminActor = gate.session.actor;
    const adminUserId =
      adminActor.kind === 'user' ? adminActor.userId : (null as never);

    await deps.audit.record(
      {
        actorId: adminUserId,
        actorType: 'user',
        action: 'admin.user.email_verified',
        resourceType: 'user',
        resourceId: id,
        metadata: {
          email: user.email,
        },
        ipHash: new TextEncoder().encode(gate.session.ipHash),
      },
      now,
    );

    return withAdminHeaders(ok({ userId: id, verified: true }));
  } catch (error) {
    deps.logger.error('admin.verify_email_failed', {
      userId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    deps.errors.capture({ error, event: 'admin.verify_email_failed', fields: { userId: id } });
    return withAdminHeaders(
      failure(500, 'VERIFICATION_FAILED', 'Could not verify email address'),
    );
  }
}
