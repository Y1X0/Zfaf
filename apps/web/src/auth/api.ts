/**
 * Talking to the auth endpoints from the browser (docs/23 §7).
 *
 * One place, because every form needs the same three things and getting any of
 * them wrong is silent:
 *
 *   • **`credentials: 'same-origin'`.** The session arrives as a `Set-Cookie`
 *     and every subsequent request has to carry it back.
 *   • **A JSON `Content-Type`.** `readAuthBody` refuses anything else, and the
 *     refusal reads as a validation error rather than as a malformed request.
 *   • **The envelope unwrapped once.** Every route answers `{data}` or
 *     `{error:{code,message}}` (docs/04 §2). Each form parsing that shape for
 *     itself is how one of them ends up rendering `[object Object]`.
 *
 * The **code** is what a caller branches on, never the message: the sentence is
 * written for a person and may be reworded, the code is the contract.
 */

export interface ApiFailure {
  readonly code: string;
  readonly message: string;
  readonly details?: readonly { readonly field?: string; readonly rule?: string }[];
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: ApiFailure };

export async function apiSend<T>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      // Spread rather than `body: undefined`: under `exactOptionalPropertyTypes`
      // an explicit undefined is not the same as an absent property, and a
      // `PUT` with no body is a real case here (resend verification).
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // A dropped connection is not a validation failure, and telling somebody
    // to "check the submitted values" when their train went into a tunnel is
    // how a form makes a person doubt what they typed.
    return { ok: false, status: 0, error: { code: 'NETWORK', message: 'network' } };
  }

  return unwrap<T>(response);
}

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK', message: 'network' } };
  }
  return unwrap<T>(response);
}

async function unwrap<T>(response: Response): Promise<ApiResult<T>> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A 204, or an error page from something in front of the app. Either way
    // the status is the only fact available.
    payload = null;
  }

  const envelope = (payload ?? {}) as { data?: T; error?: ApiFailure };

  if (response.ok && envelope.data !== undefined) {
    return { ok: true, data: envelope.data };
  }
  if (response.ok) {
    // A success with no `data` — nothing to hand back, and not an error.
    return { ok: true, data: undefined as T };
  }

  return {
    ok: false,
    status: response.status,
    error: envelope.error ?? { code: 'UNKNOWN', message: `HTTP ${response.status}` },
  };
}
