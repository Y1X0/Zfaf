import type { Actor, AdminAuditMetadata } from '@zfaf/core';

import { container } from './container.js';
import { type AdminGate, requireAdmin } from './request-context.js';
import { notFound } from './responses.js';

/**
 * Shared plumbing for the admin console (D8.6, D8.7).
 *
 * Two things every admin surface needs, in one place so neither can be
 * forgotten on a new route.
 */

/**
 * The refusal an unauthorised caller receives.
 *
 * **404, not 403, and not 401.** A stranger, a signed-in customer and an
 * operator whose session has aged out all receive exactly this. The admin
 * console is not a thing whose existence needs confirming to anyone who is not
 * already inside it — a 403 here would tell a probe that `/api/admin/users` is
 * a real endpoint worth attacking, and a 401 would invite a credential-stuffing
 * attempt against a surface that can suspend other people's weddings.
 */
export function adminNotFound(): Response {
  return notFound('Resource');
}

/**
 * Headers every admin response carries (docs/09 §5).
 *
 * `no-store` because these pages list other people's accounts and must not sit
 * in a shared cache or a browser's back-forward cache on a support laptop.
 * `DENY` because there is no legitimate reason to frame the admin console, and
 * a framed kill switch is a clickjacking target with real consequences.
 */
export const ADMIN_HEADERS: Record<string, string> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/**
 * Records an admin access or action.
 *
 * Bound to the container here rather than passed through every route so a new
 * admin endpoint gets auditing by using the same helper, not by remembering
 * to. The IP hash goes in: an audit entry that cannot be correlated with the
 * rest of an incident's evidence is half an entry.
 */
export function adminAuditor(ipHash: string) {
  return async (entry: {
    actorId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: AdminAuditMetadata;
    at: Date;
  }): Promise<void> => {
    await container().audit.record(
      {
        actorId: entry.actorId,
        actorType: 'staff',
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        metadata: entry.metadata,
        ipHash: hashToBytes(ipHash),
      },
      entry.at,
    );
  };
}

/** `clientIpHash` returns hex; the column holds bytes. */
function hashToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export type AdminSession = { readonly actor: Actor; readonly ipHash: string };

/**
 * Resolves the operator, or the single refusal.
 *
 * Returns a discriminated result rather than throwing, so a route that ignores
 * the failure branch does not compile — the same reasoning as `requireActor`.
 */
export async function adminSession(): Promise<
  { ok: true; session: AdminSession } | { ok: false; response: Response }
> {
  const gate: AdminGate = await requireAdmin();
  if (!gate.ok) {
    // The reason is deliberately not in the response. It is worth logging,
    // because a run of SESSION_TOO_OLD is an operator being annoyed and a run
    // of NOT_STAFF is somebody probing.
    console.warn(`[admin] refused: ${gate.reason}`);
    return { ok: false, response: withAdminHeaders(adminNotFound()) };
  }
  return { ok: true, session: { actor: gate.actor, ipHash: gate.ipHash } };
}

export function withAdminHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
