import { NextResponse } from 'next/server';

import { getEnv } from '@zfaf/config';

import { container } from '../../../../server/container.js';

/**
 * Deep readiness probe (docs/14 §11, D10.5).
 *
 * Separate from `/api/health` on purpose, and the split is the point:
 *
 *   • `/api/health` is **liveness**. It checks nothing downstream, because a
 *     transient database blip must not pull every instance out of rotation at
 *     once — that turns a five-second hiccup into an outage.
 *   • This is **readiness**. It touches each dependency and says which one is
 *     unhappy, which is what an on-call engineer needs at 3am and what the P0
 *     "database unreachable" alert watches.
 *
 * ## Why it is guarded
 *
 * Infrastructure state is useful to an attacker: "the database is down" is an
 * invitation to try things while nobody is watching. With `HEALTH_CHECK_TOKEN`
 * configured, component detail requires it. Without it, the endpoint still
 * answers — an unmonitored deployment is worse than a slightly informative one
 * — but only with an overall verdict and no component names.
 *
 * Nothing here reveals a hostname, a version or a connection string, whichever
 * way it is called.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A slow dependency is a failing dependency, for a probe's purposes. */
const CHECK_TIMEOUT_MS = 2_000;

interface ComponentHealth {
  readonly name: string;
  readonly status: 'ok' | 'degraded' | 'down';
  readonly durationMs: number;
  /** A short reason, never an error message from a driver. */
  readonly detail?: string;
}

export async function GET(request: Request): Promise<Response> {
  const components = await Promise.all([checkDatabase(), checkRedis(), checkErrorTracking()]);

  const down = components.filter((component) => component.status === 'down');
  const degraded = components.filter((component) => component.status === 'degraded');
  const status = down.length > 0 ? 'down' : degraded.length > 0 ? 'degraded' : 'ok';

  // 503 only for `down`. A degraded component — error reporting unconfigured,
  // say — is worth a dashboard, not worth removing an instance that is serving
  // invitations perfectly well.
  const httpStatus = status === 'down' ? 503 : 200;

  const body = authorised(request)
    ? { status, components, uptimeSeconds: Math.round(process.uptime()) }
    : { status };

  return NextResponse.json(body, {
    status: httpStatus,
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * Whether the caller may see component detail.
 *
 * Compared in constant time. A probe token is a credential, and a token
 * compared with `===` is a token that can be recovered a byte at a time.
 */
function authorised(request: Request): boolean {
  const expected = getEnv().HEALTH_CHECK_TOKEN;
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

async function timed(name: string, probe: () => Promise<void>): Promise<ComponentHealth> {
  const started = Date.now();
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)),
    ]);
    return { name, status: 'ok', durationMs: Date.now() - started };
  } catch (error) {
    return {
      name,
      status: 'down',
      durationMs: Date.now() - started,
      // Our own word for what happened, never the driver's — a connection
      // error message routinely contains a host, a port and a username.
      detail: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'unreachable',
    };
  }
}

/** `SELECT 1`: proves the pool can hand out a connection that answers. */
function checkDatabase(): Promise<ComponentHealth> {
  return timed('database', async () => {
    await container().prisma.$queryRaw`SELECT 1`;
  });
}

/**
 * Redis carries rate limits and the analytics buffer.
 *
 * Reported as `degraded` rather than `down` when it fails: losing Redis costs
 * analytics and softens rate limiting, but an invitation still renders and a
 * guest can still reply. Taking the instance out of rotation for it would
 * convert a partial loss into a total one.
 */
async function checkRedis(): Promise<ComponentHealth> {
  const result = await timed('redis', async () => {
    await container().analyticsBuffer.size();
  });
  return result.status === 'down' ? { ...result, status: 'degraded' } : result;
}

/**
 * Whether errors have anywhere to go.
 *
 * `degraded`, not `down` — the application works — but visible, because a
 * silent Sentry dashboard normally gets discovered during the incident it was
 * supposed to reveal.
 */
async function checkErrorTracking(): Promise<ComponentHealth> {
  const configured = Boolean(getEnv().SENTRY_DSN);
  return {
    name: 'error_tracking',
    status: configured ? 'ok' : 'degraded',
    durationMs: 0,
    ...(configured ? {} : { detail: 'no DSN configured' }),
  };
}
