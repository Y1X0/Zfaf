import { getEnv } from '@zfaf/config';
import {
  PrismaAnalyticsRepository,
  PrismaInvitationRepository,
  PrismaMediaMaintenanceRepository,
  getPrismaClient,
} from '@zfaf/db';
import {
  expireDueInvitations,
  flushAnalytics,
  purgeOrphanedMedia,
  redriveStuckMedia,
  sweepMedia,
} from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { dispatchMediaProcessing } from '../../../../../server/media-dispatch.js';
import { requireSameOrigin } from '../../../../../server/origin.js';
import { failure, notFound, ok } from '../../../../../server/responses.js';

/**
 * The scheduled maintenance jobs, reachable over HTTP (ADR-0023).
 *
 * These four ran on a timer inside `apps/worker`, which is a process that
 * never exits — and no platform gives one away. So the timer moves outside:
 * a Cloudflare cron trigger, free, calls this endpoint, and the work still
 * happens in a runtime with a real CPU rather than at the edge.
 *
 * Cron is the right shape for these and only these. Media *processing* is
 * event-driven and stays with its event (the upload's `complete` call); what
 * lives here is genuinely periodic — sweeping, expiring, flushing, redriving.
 *
 * ## Guarded by a shared secret, not by a session
 *
 * There is no user here and no cookie, so the session machinery does not
 * apply. `CRON_SECRET` is compared in constant time, exactly as
 * `/api/health/deep` compares its token: a secret compared with `===` leaks
 * its own length and then its bytes to anyone willing to time the answers.
 *
 * **Unset means closed.** Every request is refused when no secret is
 * configured, which is the opposite of `/api/health/deep`'s choice and right
 * for the opposite reason: an unmonitored deployment is worse than a slightly
 * informative probe, but an unauthenticated endpoint that deletes storage
 * objects is worse than no maintenance at all.
 *
 * It answers `404` rather than `401` to anything unauthorised, including an
 * unknown job name — a `401` would confirm which job names exist, and the
 * caller has no business enumerating them.
 *
 * The CSRF guard runs first even so, and even though nothing here rides on a
 * cookie. Every mutating handler validates `Origin`, that rule is enforced
 * against the route tree rather than a list, and an endpoint that sweeps
 * storage is the last place to start carving exceptions into it. It costs a
 * legitimate caller nothing: a scheduler sends no `Origin` at all, and a
 * missing one is allowed by design (see `origin.ts`).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const JOBS = [
  'sweep-media',
  'expire-invitations',
  'flush-analytics',
  'redrive-media',
  'purge-orphaned-media',
] as const;
type Job = (typeof JOBS)[number];

function isJob(value: string): value is Job {
  return (JOBS as readonly string[]).includes(value);
}

/**
 * Constant-time bearer comparison.
 *
 * The length check leaks only the length, which the caller supplied anyway;
 * the loop below never short-circuits, so no byte of the secret is recoverable
 * from how long the answer took.
 */
function authorised(request: Request): boolean {
  const expected = getEnv().CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (presented.length !== expected.length) return false;

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return difference === 0;
}

async function run(job: Job): Promise<Record<string, unknown>> {
  const deps = container();
  const prisma = getPrismaClient();

  switch (job) {
    case 'sweep-media': {
      const report = await sweepMedia({
        repository: new PrismaMediaMaintenanceRepository(prisma),
        storage: deps.storage,
        clock: deps.clock,
      });
      return { ...report };
    }
    case 'redrive-media': {
      const report = await redriveStuckMedia({
        repository: new PrismaMediaMaintenanceRepository(prisma),
        clock: deps.clock,
        dispatch: dispatchMediaProcessing,
      });
      return { ...report };
    }
    case 'expire-invitations': {
      const report = await expireDueInvitations({
        repository: new PrismaInvitationRepository(prisma),
        clock: deps.clock,
        // The same audit entry the worker writes, and written the same way:
        // an invitation that stopped being visible with no record of why is a
        // support conversation nobody can answer.
        recordPublication: async (entry) => {
          await deps.audit.record(
            {
              actorId: null,
              actorType: 'system',
              action: 'invitation.expired',
              resourceType: 'invitation',
              resourceId: entry.invitationId,
              metadata: { job: 'expiry-sweep' },
              ipHash: null,
            },
            entry.at,
          );
        },
      });
      return { ...report };
    }
    case 'flush-analytics': {
      const report = await flushAnalytics({
        buffer: deps.analyticsBuffer,
        repository: new PrismaAnalyticsRepository(prisma),
      });
      return { ...report };
    }
    case 'purge-orphaned-media': {
      const report = await purgeOrphanedMedia({
        repository: new PrismaMediaMaintenanceRepository(prisma),
        storage: deps.storage,
        clock: deps.clock,
      });
      return { ...report };
    }
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ job: string }> },
): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5), same as every other mutating
  // route. Ahead of the token check because it is the invariant, not a
  // per-route judgement call.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const { job } = await context.params;

  // Both failures answer the same way on purpose: an unauthorised caller must
  // not be able to enumerate which job names exist.
  if (!authorised(request) || !isJob(job)) return notFound('Job');

  const deps = container();
  const started = Date.now();

  try {
    const report = await run(job);
    // Logged rather than only returned: the caller is a cron trigger, and a
    // trigger that swallowed the body would leave no record that the sweep
    // ran at all.
    deps.logger.info('cron.job_completed', {
      job,
      durationMs: Date.now() - started,
      report: JSON.stringify(report),
    });
    return ok({ job, ...report });
  } catch (error) {
    deps.logger.error('cron.job_failed', {
      job,
      error: error instanceof Error ? error.message : String(error),
    });
    deps.errors.capture({ error, event: 'cron.job_failed', fields: { job } });
    return failure(500, 'JOB_FAILED', 'The job did not complete');
  }
}
