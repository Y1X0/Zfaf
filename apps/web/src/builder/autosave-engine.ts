import { type PatchOperation, applyPatch } from '@zfaf/core';

/**
 * The autosave engine (D5.5, D5.7).
 *
 * There is no save button. That is a product decision with a real engineering
 * consequence: if saving is invisible, it has to be *reliable*, and the user
 * has to be able to tell at a glance whether their work is safe. Everything
 * here follows from those two obligations.
 *
 * Written framework-free — no React, no `window` — so the interesting
 * behaviour can be tested directly: coalescing, retry, offline, conflict
 * resolution. Those are the parts that lose a bride's work at midnight, and
 * they should not need a rendered component to exercise.
 *
 * The shape:
 *
 *   edit ──▶ local document updated immediately (preview is instant)
 *        └─▶ operation appended to a pending queue
 *                │ debounce 1.5s, reset on every keystroke
 *                │ or flushed at once on: step change, tab hide, explicit call
 *                ▼
 *            PATCH …/document { baseVersion, patch }
 *                ├─ 200 → saved, version advances
 *                ├─ 409 → disjoint paths rebase silently; overlapping ones ask
 *                └─ network failure → exponential backoff, queue preserved
 */

export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;

export type SaveStatus =
  | { readonly kind: 'clean'; readonly savedAt: Date | null }
  | { readonly kind: 'pending' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'offline'; readonly queuedOperations: number }
  | { readonly kind: 'failed'; readonly message: string; readonly queuedOperations: number }
  | { readonly kind: 'conflict'; readonly conflictingPaths: readonly string[] };

export interface SaveRequest {
  readonly baseVersion: number;
  readonly patch: readonly PatchOperation[];
}

export type SaveResponse =
  | { readonly kind: 'saved'; readonly version: number; readonly savedAt: Date }
  | {
      readonly kind: 'conflict';
      readonly currentVersion: number;
      readonly currentDocument: unknown;
      readonly conflictingPaths: readonly string[];
    }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'offline' };

export interface AutosaveTransport {
  save(request: SaveRequest): Promise<SaveResponse>;
}

/** What a caller needs in order to offer the user a choice. */
export interface PendingConflict {
  readonly serverDocument: unknown;
  readonly serverVersion: number;
  readonly conflictingPaths: readonly string[];
}

export interface AutosaveOptions {
  readonly transport: AutosaveTransport;
  readonly initialDocument: unknown;
  readonly initialVersion: number;
  /** Injected so tests advance time rather than wait for it. */
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly now: () => Date;
  readonly onStatusChange?: (status: SaveStatus) => void;
  readonly onDocumentChange?: (document: unknown) => void;
  /** Persisted after every edit, before any network attempt (D5.6). */
  readonly persistLocally?: (draft: LocalDraft) => void;
  readonly debounceMs?: number;
}

export interface LocalDraft {
  readonly document: unknown;
  readonly version: number;
  readonly pending: readonly PatchOperation[];
  readonly updatedAt: string;
}

export class AutosaveEngine {
  private document: unknown;
  private version: number;
  private pending: PatchOperation[] = [];
  /** Operations already sent but not yet acknowledged. */
  private inFlight: PatchOperation[] = [];
  private status: SaveStatus = { kind: 'clean', savedAt: null };
  /**
   * Two timer slots, not one.
   *
   * A single slot meant a keystroke cancelled a pending reconnect attempt — so
   * a user who kept typing while offline never retried, which is exactly the
   * person whose work most needs saving. The debounce and the retry are
   * different clocks and are now kept apart.
   */
  private debounceTimer: unknown = null;
  private retryTimer: unknown = null;
  private retryIndex = 0;
  private saving = false;
  /**
   * The server's side of an unresolved conflict.
   *
   * Held because resolving one needs the document the server actually has, and
   * the status alone carries only the contended paths — which is enough to
   * *show* a dialog and not enough to act on either answer.
   */
  private conflictDetail: PendingConflict | null = null;
  /**
   * The document as of the last version the server acknowledged.
   *
   * Held because it is the only way to tell a real conflict from an imagined
   * one. The server cannot: it knows the current document and the version the
   * client built on, but it does not keep per-version diffs, so asked "did
   * anyone change this field?" it can only answer "the field exists". That
   * answer makes every second device conflict, which defeats the whole point
   * of merging — so the decision is made here, where the base is known.
   */
  private baseDocument: unknown;

  constructor(private readonly options: AutosaveOptions) {
    this.document = options.initialDocument;
    this.baseDocument = options.initialDocument;
    this.version = options.initialVersion;
  }

  currentDocument(): unknown {
    return this.document;
  }

  currentVersion(): number {
    return this.version;
  }

  currentStatus(): SaveStatus {
    return this.status;
  }

  /** The server's side of an unresolved conflict, or null when there is none. */
  pendingConflict(): PendingConflict | null {
    return this.conflictDetail;
  }

  pendingCount(): number {
    return this.pending.length + this.inFlight.length;
  }

  /**
   * Records an edit.
   *
   * The local document moves first and synchronously: the preview must react
   * within a frame, and waiting on a network round trip to show a typed
   * character would make the builder feel broken.
   */
  edit(operations: readonly PatchOperation[]): { ok: true } | { ok: false; reason: string } {
    if (operations.length === 0) return { ok: true };

    const applied = applyPatch(this.document, operations);
    if (!applied.ok) {
      // The local document and the operation disagree. Queuing it anyway would
      // send the server something we could not apply ourselves.
      return { ok: false, reason: `${applied.error} at ${applied.path}` };
    }

    this.document = applied.document;
    this.pending = coalesce([...this.pending, ...operations]);

    this.options.onDocumentChange?.(this.document);
    this.persist();
    this.setStatus({ kind: 'pending' });
    this.scheduleFlush();
    return { ok: true };
  }

  /**
   * Sends whatever is queued, now.
   *
   * Called on step changes, when the tab is hidden, and before publishing —
   * the moments when waiting out a debounce risks losing the work.
   */
  async flush(): Promise<void> {
    this.cancelDebounce();
    this.cancelRetry();
    if (this.saving) return;
    if (this.pending.length === 0 && this.inFlight.length === 0) return;

    this.saving = true;
    // Moved rather than copied: an edit arriving mid-request queues behind
    // this batch instead of being sent twice.
    const batch = [...this.inFlight, ...this.pending];
    this.inFlight = batch;
    this.pending = [];

    this.setStatus({ kind: 'saving' });

    let response: SaveResponse;
    try {
      response = await this.options.transport.save({ baseVersion: this.version, patch: batch });
    } catch {
      response = { kind: 'offline' };
    } finally {
      this.saving = false;
    }

    await this.handle(response, batch);
  }

  private async handle(response: SaveResponse, batch: PatchOperation[]): Promise<void> {
    switch (response.kind) {
      case 'saved': {
        this.inFlight = [];
        this.version = response.version;
        this.retryIndex = 0;
        // Everything sent is now the server's truth, so it becomes the base
        // the next conflict is measured against.
        this.baseDocument = applyPatchOrKeep(this.baseDocument, batch);
        if (this.pending.length > 0) {
          // Edits arrived while this batch was in flight.
          this.setStatus({ kind: 'pending' });
          this.scheduleFlush();
        } else {
          this.setStatus({ kind: 'clean', savedAt: response.savedAt });
        }
        this.persist();
        return;
      }

      case 'conflict': {
        this.retryIndex = 0;
        // Contention decided here, against our own base — see `baseDocument`.
        // A path is contended only when the server's value differs from what
        // we last saw, not merely because the path exists.
        const contended = batch
          .map((operation) => operation.path)
          .filter((path) => !sameValueAt(this.baseDocument, response.currentDocument, path));

        if (contended.length === 0) {
          // The common case: two devices, different fields. Rebase our
          // operations onto the server's document and try again — silently,
          // because there is nothing for the user to decide.
          const rebased = applyPatch(response.currentDocument, batch);
          if (rebased.ok) {
            this.document = rebased.document;
            this.baseDocument = response.currentDocument;
            this.version = response.currentVersion;
            this.inFlight = [];
            this.pending = coalesce([...batch, ...this.pending]);
            this.options.onDocumentChange?.(this.document);
            this.persist();
            this.setStatus({ kind: 'pending' });
            this.scheduleFlush();
            return;
          }
        }

        // Genuinely the same field. The user decides; nothing is discarded
        // until they do.
        this.conflictDetail = {
          serverDocument: response.currentDocument,
          serverVersion: response.currentVersion,
          conflictingPaths: contended,
        };
        this.setStatus({ kind: 'conflict', conflictingPaths: contended });
        return;
      }

      case 'rejected': {
        // The server refused the patch itself. Retrying would refuse again, so
        // the queue is dropped rather than looped — and the operator hears
        // about it through the audit log the server wrote.
        this.inFlight = [];
        this.retryIndex = 0;
        this.setStatus({
          kind: 'failed',
          message: response.message,
          queuedOperations: this.pending.length,
        });
        return;
      }

      case 'offline': {
        // Nothing is lost: the batch stays in flight and the local draft is
        // already persisted. Retry with backoff.
        const delay = RETRY_DELAYS_MS[Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1)];
        this.retryIndex += 1;
        this.setStatus({ kind: 'offline', queuedOperations: this.pendingCount() });
        this.cancelRetry();
        this.retryTimer = this.options.setTimer(() => {
          void this.flush();
        }, delay as number);
        return;
      }
    }
  }

  /**
   * Resolves a conflict the user was asked about.
   *
   * `mine` replays our operations over the server's document; `theirs`
   * abandons them. Both are explicit — neither happens without a choice.
   */
  resolveConflict(choice: 'mine' | 'theirs', serverDocument: unknown, serverVersion: number): void {
    this.conflictDetail = null;
    // The contended batch is in flight, not pending — it was moved there when
    // the request went out. Replaying only `pending` would silently drop
    // exactly the edit the user just chose to keep.
    const unsaved = [...this.inFlight, ...this.pending];
    this.version = serverVersion;
    this.baseDocument = serverDocument;
    this.inFlight = [];

    if (choice === 'theirs') {
      this.document = serverDocument;
      this.pending = [];
      this.options.onDocumentChange?.(this.document);
      this.persist();
      this.setStatus({ kind: 'clean', savedAt: this.options.now() });
      return;
    }

    const replayed = applyPatch(serverDocument, unsaved);
    this.document = replayed.ok ? replayed.document : this.document;
    this.pending = coalesce(unsaved);
    this.options.onDocumentChange?.(this.document);
    this.persist();
    this.setStatus({ kind: 'pending' });
    this.scheduleFlush();
  }

  /** Restores from a local draft after the tab was closed or evicted (D5.6). */
  restore(draft: LocalDraft): void {
    this.document = draft.document;
    // The base is the document minus what is still queued, which we cannot
    // reconstruct — the restored document itself is the safest approximation:
    // it makes an unchanged field compare equal, which is the common case.
    this.baseDocument = draft.document;
    this.version = draft.version;
    this.pending = [...draft.pending];
    this.options.onDocumentChange?.(this.document);
    this.setStatus(
      this.pending.length > 0 ? { kind: 'pending' } : { kind: 'clean', savedAt: null },
    );
    if (this.pending.length > 0) this.scheduleFlush();
  }

  /** True when closing the tab would lose work — drives `beforeunload`. */
  hasUnsavedWork(): boolean {
    return this.pendingCount() > 0;
  }

  private scheduleFlush(): void {
    // Only the debounce is rescheduled. A retry already in the diary keeps its
    // place, so typing cannot postpone reconnection.
    this.cancelDebounce();
    this.debounceTimer = this.options.setTimer(() => {
      void this.flush();
    }, this.options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS);
  }

  private cancelDebounce(): void {
    if (this.debounceTimer !== null) {
      this.options.clearTimer(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      this.options.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private persist(): void {
    this.options.persistLocally?.({
      document: this.document,
      version: this.version,
      pending: [...this.inFlight, ...this.pending],
      updatedAt: this.options.now().toISOString(),
    });
  }

  private setStatus(status: SaveStatus): void {
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}

/**
 * Collapses repeated writes to the same path.
 *
 * Typing a name produces one operation per keystroke; only the last value
 * matters. Without this a minute of typing sends sixty operations describing
 * one field, which is the payload the debounce was supposed to avoid.
 *
 * Only `replace` collapses. `add` and `remove` change list *structure*, and
 * dropping an earlier one would change what the later index refers to.
 */
export function coalesce(operations: readonly PatchOperation[]): PatchOperation[] {
  const result: PatchOperation[] = [];
  const lastReplaceAt = new Map<string, number>();

  for (const operation of operations) {
    if (operation.op !== 'replace') {
      result.push(operation);
      // A structural change invalidates every earlier assumption about
      // indexes, so nothing before it may be collapsed into anything after.
      lastReplaceAt.clear();
      continue;
    }

    const existing = lastReplaceAt.get(operation.path);
    if (existing !== undefined) {
      result[existing] = operation;
      continue;
    }

    lastReplaceAt.set(operation.path, result.length);
    result.push(operation);
  }

  return result;
}

/** Applies operations, keeping the original when they do not fit. */
function applyPatchOrKeep(document: unknown, operations: readonly PatchOperation[]): unknown {
  const applied = applyPatch(document, operations);
  return applied.ok ? applied.document : document;
}

/** Whether two documents hold the same value at a pointer. */
function sameValueAt(left: unknown, right: unknown, pointer: string): boolean {
  return JSON.stringify(readPointer(left, pointer)) === JSON.stringify(readPointer(right, pointer));
}

function readPointer(document: unknown, pointer: string): unknown {
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

  let current: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (segment === '-') return undefined;
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.hasOwn(current as Record<string, unknown>, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}
