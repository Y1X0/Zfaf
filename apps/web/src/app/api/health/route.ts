import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Shallow liveness probe for load balancers and deploy gates.
 *
 * Deliberately checks nothing downstream: a dependency check here would let a
 * transient database blip take the whole app out of rotation. The deep check
 * (`/api/health/deep`) arrives in M10 and is rate-limited and protected, since
 * exposing infrastructure state publicly is useful to an attacker.
 */
export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'web',
    uptimeSeconds: Math.round(process.uptime()),
  });
}
