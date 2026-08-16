/**
 * Draft document patching (D5.5).
 *
 * Autosave sends RFC 6902 JSON Patch rather than the whole document: a
 * fifty-kilobyte payload every 1.5 seconds is wasteful, and — more usefully —
 * a patch says exactly *which fields* changed, which is what makes
 * field-level conflict detection possible at all.
 *
 * It also means the client is telling the server which paths to write, and
 * that is the security problem this module exists to solve. A patch is
 * untrusted input in the most literal sense: it is a list of instructions to
 * mutate our database. Without a path allowlist, `{"op":"replace",
 * "path":"/status","value":"PUBLISHED"}` publishes an invitation through the
 * autosave endpoint, and `/ownerId` hands it to someone else.
 *
 * So the allowlist is not a filter that drops unknown paths — it is a **hard
 * rejection**. A patch containing one forbidden path is refused in full and
 * recorded, because a client sending one is either broken or hostile and
 * neither should be quietly half-applied.
 */

export const PATCH_OPS = ['add', 'remove', 'replace'] as const;
export type PatchOp = (typeof PATCH_OPS)[number];

export interface PatchOperation {
  readonly op: PatchOp;
  readonly path: string;
  readonly value?: unknown;
}

/**
 * The document regions autosave may write.
 *
 * Everything a couple edits in the builder lives under one of these. Anything
 * that decides *authority* — who owns the invitation, whether it is published,
 * what its slug is — is absent by construction, and changing that requires
 * editing this list in a reviewed commit rather than crafting a request.
 *
 * Expressed as prefixes over the draft document, which is a different object
 * from the invitation row: `status`, `ownerId` and `slug` are columns, not
 * document fields. The allowlist is what keeps a patch from reaching them even
 * if the two are ever merged.
 */
export const ALLOWED_PATCH_PREFIXES: readonly string[] = [
  '/content/couple',
  '/content/wedding',
  '/content/location',
  '/content/events',
  '/content/cover',
  '/content/gallery',
  '/content/music',
  '/content/rsvp',
  '/content/story',
  '/theme',
  '/sections',
  '/locale',
  '/timezone',
];

/**
 * Paths that are refused even when a prefix would allow them.
 *
 * Belt and braces: if `/theme` is allowed and someone later nests an
 * authority field beneath it, this list still refuses. Cheap, and the failure
 * it guards against is one nobody would notice.
 */
export const DENIED_PATCH_SEGMENTS: readonly string[] = [
  'ownerId',
  'userId',
  'tenantId',
  'status',
  'slug',
  'publishedAt',
  'publishedVersionId',
  'draftVersion',
  'schemaVersion',
  'templateKey',
  'templateVersion',
  '__proto__',
  'constructor',
  'prototype',
];

/** How many operations one autosave may carry. */
export const MAX_PATCH_OPERATIONS = 200;
/** A single value larger than this is not a form field being edited. */
export const MAX_PATCH_VALUE_BYTES = 64 * 1024;

export type PatchRejection =
  | 'NOT_AN_ARRAY'
  | 'EMPTY'
  | 'TOO_MANY_OPERATIONS'
  | 'MALFORMED_OPERATION'
  | 'UNSUPPORTED_OP'
  | 'PATH_NOT_ALLOWED'
  | 'DENIED_SEGMENT'
  | 'VALUE_TOO_LARGE'
  | 'MISSING_VALUE';

export interface PatchViolation {
  readonly index: number;
  readonly path: string;
  readonly reason: PatchRejection;
  readonly detail: string;
}

export type PatchValidation =
  | { readonly ok: true; readonly operations: readonly PatchOperation[] }
  | { readonly ok: false; readonly violations: readonly PatchViolation[] };

/**
 * Splits a JSON Pointer into its decoded segments.
 *
 * RFC 6901 escaping matters here rather than being pedantry: `~1` decodes to
 * `/` and `~0` to `~`, so a naive `split('/')` lets `/theme/~1..~1status`
 * present itself as a single innocent segment.
 */
export function pointerSegments(pointer: string): readonly string[] {
  if (pointer === '') return [];
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function approximateByteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    // Circular or otherwise unserialisable. Not something a form field
    // produces, so refusing on size is the right answer.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Validates a patch against the allowlist.
 *
 * Collects every violation rather than stopping at the first. A client that is
 * merely wrong deserves a complete answer, and an attempt that is hostile is
 * more useful in the audit log described whole.
 */
export function validatePatch(input: unknown): PatchValidation {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      violations: [
        { index: -1, path: '', reason: 'NOT_AN_ARRAY', detail: 'Patch must be an array' },
      ],
    };
  }
  if (input.length === 0) {
    return {
      ok: false,
      violations: [{ index: -1, path: '', reason: 'EMPTY', detail: 'Patch is empty' }],
    };
  }
  if (input.length > MAX_PATCH_OPERATIONS) {
    return {
      ok: false,
      violations: [
        {
          index: -1,
          path: '',
          reason: 'TOO_MANY_OPERATIONS',
          detail: `Patch carries ${input.length} operations; the limit is ${MAX_PATCH_OPERATIONS}`,
        },
      ],
    };
  }

  const violations: PatchViolation[] = [];
  const operations: PatchOperation[] = [];

  for (const [index, raw] of input.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      violations.push({
        index,
        path: '',
        reason: 'MALFORMED_OPERATION',
        detail: 'Operation is not an object',
      });
      continue;
    }

    const candidate = raw as Record<string, unknown>;
    const op = candidate['op'];
    const path = candidate['path'];

    if (typeof op !== 'string' || !PATCH_OPS.includes(op as PatchOp)) {
      violations.push({
        index,
        path: typeof path === 'string' ? path : '',
        reason: 'UNSUPPORTED_OP',
        // `move` and `copy` are excluded deliberately: both name a second path,
        // which would need the same allowlist check applied twice, and neither
        // is anything the builder produces.
        detail: `"${String(op)}" is not one of: ${PATCH_OPS.join(', ')}`,
      });
      continue;
    }

    if (typeof path !== 'string' || !path.startsWith('/')) {
      violations.push({
        index,
        path: '',
        reason: 'MALFORMED_OPERATION',
        detail: 'Path must be a JSON Pointer beginning with "/"',
      });
      continue;
    }

    const segments = pointerSegments(path);
    const denied = segments.find((segment) => DENIED_PATCH_SEGMENTS.includes(segment));
    if (denied) {
      violations.push({
        index,
        path,
        reason: 'DENIED_SEGMENT',
        detail: `"${denied}" may never be written by autosave`,
      });
      continue;
    }

    const allowed = ALLOWED_PATCH_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
    if (!allowed) {
      violations.push({
        index,
        path,
        reason: 'PATH_NOT_ALLOWED',
        detail: 'Path is outside the region autosave may write',
      });
      continue;
    }

    if ((op === 'add' || op === 'replace') && !Object.hasOwn(candidate, 'value')) {
      violations.push({
        index,
        path,
        reason: 'MISSING_VALUE',
        detail: `"${op}" requires a value`,
      });
      continue;
    }

    if (approximateByteLength(candidate['value']) > MAX_PATCH_VALUE_BYTES) {
      violations.push({
        index,
        path,
        reason: 'VALUE_TOO_LARGE',
        detail: `Value exceeds ${MAX_PATCH_VALUE_BYTES} bytes`,
      });
      continue;
    }

    operations.push(
      Object.hasOwn(candidate, 'value')
        ? { op: op as PatchOp, path, value: candidate['value'] }
        : { op: op as PatchOp, path },
    );
  }

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, operations };
}

// ── application ────────────────────────────────────────────────────────────

export type PatchApplicationError =
  'PATH_NOT_FOUND' | 'PARENT_NOT_FOUND' | 'INDEX_OUT_OF_RANGE' | 'TYPE_MISMATCH';

export type PatchResult =
  | { readonly ok: true; readonly document: unknown }
  | {
      readonly ok: false;
      readonly index: number;
      readonly path: string;
      readonly error: PatchApplicationError;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Applies a validated patch to a document.
 *
 * Works on a structural clone, so a failure halfway through leaves the caller's
 * document untouched — a half-applied autosave is worse than a rejected one,
 * because nobody would know to retry it.
 *
 * Implemented here rather than pulled in as a dependency: the subset we accept
 * is three operations, the allowlist has already constrained the paths, and a
 * general-purpose library would bring `move`, `copy` and `test` semantics we
 * deliberately refuse.
 */
export function applyPatch(document: unknown, operations: readonly PatchOperation[]): PatchResult {
  let working: unknown;
  try {
    working = structuredClone(document);
  } catch {
    working = JSON.parse(JSON.stringify(document));
  }

  for (const [index, operation] of operations.entries()) {
    const segments = pointerSegments(operation.path);
    if (segments.length === 0) {
      return { ok: false, index, path: operation.path, error: 'PATH_NOT_FOUND' };
    }

    const parentSegments = segments.slice(0, -1);
    const key = segments[segments.length - 1] as string;

    let parent: unknown = working;
    for (const segment of parentSegments) {
      if (Array.isArray(parent)) {
        const position = Number(segment);
        if (!Number.isInteger(position) || position < 0 || position >= parent.length) {
          return { ok: false, index, path: operation.path, error: 'PARENT_NOT_FOUND' };
        }
        parent = parent[position];
      } else if (isRecord(parent)) {
        if (!Object.hasOwn(parent, segment)) {
          return { ok: false, index, path: operation.path, error: 'PARENT_NOT_FOUND' };
        }
        parent = parent[segment];
      } else {
        return { ok: false, index, path: operation.path, error: 'PARENT_NOT_FOUND' };
      }
    }

    const applied = applyOne(parent, key, operation);
    if (!applied.ok) {
      return { ok: false, index, path: operation.path, error: applied.error };
    }
  }

  return { ok: true, document: working };
}

function applyOne(
  parent: unknown,
  key: string,
  operation: PatchOperation,
): { ok: true } | { ok: false; error: PatchApplicationError } {
  if (Array.isArray(parent)) {
    // `-` appends, per RFC 6902.
    const position = key === '-' ? parent.length : Number(key);
    if (!Number.isInteger(position) || position < 0) {
      return { ok: false, error: 'TYPE_MISMATCH' };
    }

    switch (operation.op) {
      case 'add':
        if (position > parent.length) return { ok: false, error: 'INDEX_OUT_OF_RANGE' };
        parent.splice(position, 0, operation.value);
        return { ok: true };
      case 'remove':
        if (position >= parent.length) return { ok: false, error: 'INDEX_OUT_OF_RANGE' };
        parent.splice(position, 1);
        return { ok: true };
      case 'replace':
        if (position >= parent.length) return { ok: false, error: 'INDEX_OUT_OF_RANGE' };
        parent[position] = operation.value;
        return { ok: true };
    }
  }

  if (isRecord(parent)) {
    switch (operation.op) {
      case 'add':
        // `add` on an object is an upsert, per RFC 6902.
        parent[key] = operation.value;
        return { ok: true };
      case 'remove':
        if (!Object.hasOwn(parent, key)) return { ok: false, error: 'PATH_NOT_FOUND' };
        delete parent[key];
        return { ok: true };
      case 'replace':
        // Strict, unlike `add`: replacing something that is not there means the
        // client's idea of the document has diverged from ours, which is a
        // conflict to surface rather than a write to guess at.
        if (!Object.hasOwn(parent, key)) return { ok: false, error: 'PATH_NOT_FOUND' };
        parent[key] = operation.value;
        return { ok: true };
    }
  }

  return { ok: false, error: 'TYPE_MISMATCH' };
}

// ── conflict detection ─────────────────────────────────────────────────────

/**
 * Whether two sets of paths touch the same part of the document.
 *
 * Two edits conflict when one path is a prefix of the other, not only when
 * they are equal: writing `/content/couple` and `/content/couple/groomName`
 * concurrently is a genuine conflict even though the strings differ.
 *
 * This is what lets a 409 be resolved silently in the common case — two
 * devices editing different fields — and escalated to the user only when they
 * really did edit the same thing (docs/06 §4.3).
 */
export function pathsIntersect(a: readonly string[], b: readonly string[]): boolean {
  return a.some((left) =>
    b.some(
      (right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`),
    ),
  );
}

export function conflictingPaths(
  mine: readonly string[],
  theirs: readonly string[],
): readonly string[] {
  return mine.filter((left) =>
    theirs.some(
      (right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`),
    ),
  );
}
