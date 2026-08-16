'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type DraftDocument, type PatchOperation, parseDraftDocument } from '@zfaf/core';

import {
  AutosaveEngine,
  type AutosaveTransport,
  type LocalDraft,
  type SaveResponse,
  type SaveStatus,
} from './autosave-engine.js';
import { EditHistory } from './history.js';
import {
  IndexedDbDraftStore,
  type LocalDraftStore,
  NoopDraftStore,
  decideRestore,
} from './local-draft-store.js';

/**
 * Binds the autosave engine to React (D5.1).
 *
 * The engine, the history stack and the draft store were built framework-free
 * and are already tested on their own. This hook is the thin layer that owns
 * their lifetime and mirrors their state into a render — deliberately thin,
 * so none of the logic that can lose a user's work lives somewhere it needs a
 * browser to exercise.
 */

export interface UseBuilderOptions {
  readonly invitationId: string;
  readonly initialDocument: unknown;
  readonly initialVersion: number;
  /** Overridden in tests; production talks to the autosave route. */
  readonly transport?: AutosaveTransport;
  readonly draftStore?: LocalDraftStore;
}

export interface RestorePrompt {
  readonly localUpdatedAt: string;
  readonly pendingCount: number;
}

export interface ConflictPrompt {
  readonly conflictingPaths: readonly string[];
  readonly serverDocument: unknown;
  readonly serverVersion: number;
}

export interface BuilderApi {
  readonly document: DraftDocument | null;
  readonly status: SaveStatus;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly restorePrompt: RestorePrompt | null;
  readonly conflict: ConflictPrompt | null;
  edit(label: string, operations: readonly PatchOperation[]): void;
  undo(): void;
  redo(): void;
  flush(): Promise<void>;
  acceptRestore(): void;
  declineRestore(): void;
  resolveConflict(choice: 'mine' | 'theirs'): void;
}

/** Talks to `PATCH /api/v1/invitations/{id}/document`. */
export function httpTransport(invitationId: string): AutosaveTransport {
  return {
    async save(request): Promise<SaveResponse> {
      const response = await fetch(`/api/v1/invitations/${invitationId}/document`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: request.baseVersion, patch: request.patch }),
      });

      if (response.ok) {
        const body = (await response.json()) as { data: { version: number; savedAt: string } };
        return { kind: 'saved', version: body.data.version, savedAt: new Date(body.data.savedAt) };
      }

      if (response.status === 409) {
        const body = (await response.json()) as {
          error: {
            details: {
              currentVersion: number;
              currentDocument: unknown;
              conflictingPaths: string[];
            };
          };
        };
        return {
          kind: 'conflict',
          currentVersion: body.error.details.currentVersion,
          currentDocument: body.error.details.currentDocument,
          conflictingPaths: body.error.details.conflictingPaths,
        };
      }

      // 5xx and network-level problems are worth retrying; a 4xx means the
      // server will refuse this patch every time, so retrying is a loop.
      if (response.status >= 500) return { kind: 'offline' };

      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      return { kind: 'rejected', message: body?.error?.message ?? 'Save was refused' };
    },
  };
}

export function useBuilder(options: UseBuilderOptions): BuilderApi {
  const [document, setDocument] = useState<DraftDocument | null>(() => {
    const parsed = parseDraftDocument(options.initialDocument);
    return parsed.ok ? parsed.document : null;
  });
  const [status, setStatus] = useState<SaveStatus>({ kind: 'clean', savedAt: null });
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  const [restorePrompt, setRestorePrompt] = useState<RestorePrompt | null>(null);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);

  const history = useRef(new EditHistory());
  const pendingRestore = useRef<LocalDraft | null>(null);

  const store = useMemo<LocalDraftStore>(
    () =>
      options.draftStore ??
      (typeof indexedDB === 'undefined' ? new NoopDraftStore() : new IndexedDbDraftStore()),
    [options.draftStore],
  );

  /**
   * Created once, in a ref rather than a memo.
   *
   * A memo may be discarded and recomputed at React's discretion, and
   * rebuilding the engine would drop whatever is queued but unsent — which is
   * precisely the work this whole mechanism exists to protect.
   */
  const engineRef = useRef<AutosaveEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new AutosaveEngine({
      transport: options.transport ?? httpTransport(options.invitationId),
      initialDocument: options.initialDocument,
      initialVersion: options.initialVersion,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => new Date(),
      onStatusChange: setStatus,
      onDocumentChange: (next) => {
        const parsed = parseDraftDocument(next);
        if (parsed.ok) setDocument(parsed.document);
      },
      persistLocally: (draft) => {
        // Fire and forget: a keystroke must not wait on storage, and a failure
        // to persist is already handled by the store returning rather than
        // throwing.
        void store.write(options.invitationId, draft);
      },
    });
  }
  const engine = engineRef.current;

  /** Offers to restore a local draft, if one is worth restoring (D5.6). */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const local = await store.read(options.invitationId);
      if (cancelled) return;

      const decision = decideRestore(local, { version: options.initialVersion });
      if (decision.action === 'use-local' && local) {
        engine.restore(local);
        return;
      }
      if (decision.action === 'ask' && local) {
        pendingRestore.current = local;
        setRestorePrompt({
          localUpdatedAt: decision.localUpdatedAt,
          pendingCount: decision.pendingCount,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engine, options.initialVersion, options.invitationId, store]);

  /** Surfaces a conflict the engine could not merge on its own (D5.7). */
  useEffect(() => {
    if (status.kind !== 'conflict') {
      setConflict(null);
      return;
    }
    const detail = engine.pendingConflict();
    if (!detail) return;
    setConflict({
      conflictingPaths: detail.conflictingPaths,
      serverDocument: detail.serverDocument,
      serverVersion: detail.serverVersion,
    });
  }, [engine, status]);

  /**
   * Saves whatever is queued when the tab goes away.
   *
   * `visibilitychange` rather than only `beforeunload`: on iOS a backgrounded
   * tab is frequently discarded without ever firing an unload, which is the
   * exact case D5.6 exists for.
   */
  useEffect(() => {
    const onHide = () => {
      if (window.document.visibilityState === 'hidden') void engine.flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!engine.hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [engine]);

  const edit = useCallback(
    (label: string, operations: readonly PatchOperation[]) => {
      const before = engine.currentDocument();
      const result = engine.edit(operations);
      if (!result.ok) return;
      history.current.record(label, operations, before);
      setHistoryDepth(history.current.depth());
    },
    [engine],
  );

  const undo = useCallback(() => {
    const step = history.current.undo();
    if (!step) return;
    // Applied as an ordinary edit so it autosaves like any other change —
    // there is no such thing as "undoing a save".
    engine.edit(step.operations);
    setHistoryDepth(history.current.depth());
  }, [engine]);

  const redo = useCallback(() => {
    const step = history.current.redo();
    if (!step) return;
    engine.edit(step.operations);
    setHistoryDepth(history.current.depth());
  }, [engine]);

  const acceptRestore = useCallback(() => {
    const draft = pendingRestore.current;
    if (draft) engine.restore(draft);
    pendingRestore.current = null;
    setRestorePrompt(null);
  }, [engine]);

  const declineRestore = useCallback(() => {
    pendingRestore.current = null;
    setRestorePrompt(null);
    void store.clear(options.invitationId);
  }, [options.invitationId, store]);

  const resolveConflict = useCallback(
    (choice: 'mine' | 'theirs') => {
      if (!conflict) return;
      engine.resolveConflict(choice, conflict.serverDocument, conflict.serverVersion);
      setConflict(null);
    },
    [conflict, engine],
  );

  return {
    document,
    status,
    canUndo: historyDepth.undo > 0,
    canRedo: historyDepth.redo > 0,
    restorePrompt,
    conflict,
    edit,
    undo,
    redo,
    flush: () => engine.flush(),
    acceptRestore,
    declineRestore,
    resolveConflict,
  };
}
