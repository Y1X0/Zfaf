import { NextResponse } from 'next/server';

/**
 * The API's response envelope (docs/04-api-specification.md §2).
 *
 * Every route returns one of these, so a client never has to guess whether a
 * body is data or an error. Two properties are load-bearing:
 *
 *   • **Errors carry a stable machine code**, not only a human sentence. The
 *     sentence is for a person and may be reworded; the code is what a client
 *     branches on and must not change.
 *   • **The message never leaks what the caller could not otherwise learn.**
 *     `unauthorized()` says the same thing for an expired session, a revoked
 *     one and one that never existed, because the differences would tell an
 *     attacker which tokens were once real.
 */

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, { status: 200, ...init });
}

export function created<T>(data: T): NextResponse {
  return NextResponse.json({ data }, { status: 201 });
}

export function failure(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse {
  const body: ApiErrorBody = {
    error: details === undefined ? { code, message } : { code, message, details },
  };
  return NextResponse.json(body, { status });
}

/** Uniform for every session problem. See the note above. */
export function unauthorized(): NextResponse {
  return failure(401, 'UNAUTHENTICATED', 'Sign in to continue');
}

/**
 * Used for "not yours" as well as "does not exist".
 *
 * Answering 403 for a resource that belongs to somebody else confirms it
 * exists, which turns any id-taking endpoint into an enumeration oracle. 404
 * for both is the only answer that reveals nothing.
 */
export function notFound(what = 'Resource'): NextResponse {
  return failure(404, 'NOT_FOUND', `${what} not found`);
}

export function forbidden(message = 'Not permitted'): NextResponse {
  return failure(403, 'FORBIDDEN', message);
}

export function badRequest(code: string, message: string, details?: unknown): NextResponse {
  return failure(400, code, message, details);
}

export function conflict(code: string, message: string, details?: unknown): NextResponse {
  return failure(409, code, message, details);
}

export function rateLimited(retryAfterSeconds: number): NextResponse {
  const response = failure(429, 'RATE_LIMITED', 'Too many requests. Please slow down.');
  response.headers.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  return response;
}

/**
 * Reads and size-bounds a JSON body.
 *
 * An unbounded `request.json()` will happily buffer whatever arrives, so the
 * limit is applied before parsing rather than after.
 */
export async function readJsonBody(
  request: Request,
  maxBytes = 512 * 1024,
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      response: failure(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'),
    };
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: badRequest('MALFORMED_BODY', 'Could not read the request body') };
  }

  // The header is a claim; this is the fact.
  if (raw.length > maxBytes) {
    return { ok: false, response: failure(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large') };
  }

  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: badRequest('MALFORMED_BODY', 'Body is not valid JSON') };
  }
}
