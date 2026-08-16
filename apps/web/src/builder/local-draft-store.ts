import type { LocalDraft } from './autosave-engine.js';

/**
 * The local draft (D5.6).
 *
 * The scenario this exists for is specific and common: on iOS, opening the
 * photo picker frequently causes Safari to evict the page from memory. The
 * user comes back and the tab reloads. Anything that lived only in React state
 * is gone, and anything that had not yet been sent is gone with it.
 *
 * So every edit is written to IndexedDB **before** any network attempt.
 * IndexedDB rather than `localStorage` because the write is asynchronous and
 * does not block the main thread on a keystroke, and because a document with
 * a gallery comfortably exceeds the 5 MB `localStorage` ceiling.
 *
 * The port is separated from the IndexedDB implementation so the restore logic
 * — which is the part with the interesting decisions — can be tested without a
 * browser, and so a private-mode browser that refuses IndexedDB degrades to a
 * no-op rather than an error.
 */

export interface LocalDraftStore {
  read(invitationId: string): Promise<LocalDraft | null>;
  write(invitationId: string, draft: LocalDraft): Promise<void>;
  clear(invitationId: string): Promise<void>;
}

export const DRAFT_DATABASE_NAME = 'zfaf-builder';
export const DRAFT_STORE_NAME = 'drafts';

/**
 * What to do with a local draft found at startup.
 *
 * The decision is deliberately conservative in one direction: **we never
 * silently discard unsent work**. Offering to restore something the user does
 * not want costs them one click; dropping it costs them an evening.
 */
export type RestoreDecision =
  | { readonly action: 'use-server'; readonly reason: string }
  | { readonly action: 'use-local'; readonly reason: string }
  | { readonly action: 'ask'; readonly localUpdatedAt: string; readonly pendingCount: number };

export function decideRestore(
  local: LocalDraft | null,
  server: { readonly version: number },
): RestoreDecision {
  if (!local) return { action: 'use-server', reason: 'no local draft' };

  if (local.pending.length === 0 && local.version <= server.version) {
    // Everything local was already acknowledged. The server is at least as
    // fresh, so there is nothing to restore and nothing to ask about.
    return { action: 'use-server', reason: 'local draft fully saved' };
  }

  if (local.version < server.version) {
    // The server moved on — another device saved — *and* we hold unsent work.
    // Neither side is simply right, so the user decides.
    return {
      action: 'ask',
      localUpdatedAt: local.updatedAt,
      pendingCount: local.pending.length,
    };
  }

  if (local.pending.length > 0) {
    // We hold unsent edits built on the version the server still reports.
    // Restoring is unambiguously correct: replaying them loses nothing.
    return { action: 'use-local', reason: 'unsent edits on the current version' };
  }

  return { action: 'use-server', reason: 'server is current' };
}

/**
 * IndexedDB-backed store.
 *
 * Every method resolves rather than rejects on failure. A browser in private
 * mode, a full disk, or a user who blocked storage must not break the builder
 * — the local draft is a safety net, and a safety net that throws is worse
 * than none.
 */
export class IndexedDbDraftStore implements LocalDraftStore {
  private open(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DRAFT_DATABASE_NAME, 1);
      } catch {
        resolve(null);
        return;
      }

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
          database.createObjectStore(DRAFT_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  async read(invitationId: string): Promise<LocalDraft | null> {
    const database = await this.open();
    if (!database) return null;

    return new Promise((resolve) => {
      try {
        const request = database
          .transaction(DRAFT_STORE_NAME, 'readonly')
          .objectStore(DRAFT_STORE_NAME)
          .get(invitationId);
        request.onsuccess = () => resolve((request.result as LocalDraft | undefined) ?? null);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      } finally {
        // Closed after the transaction is queued; the request still completes.
        database.close();
      }
    });
  }

  async write(invitationId: string, draft: LocalDraft): Promise<void> {
    const database = await this.open();
    if (!database) return;

    return new Promise((resolve) => {
      try {
        const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
        transaction.objectStore(DRAFT_STORE_NAME).put(draft, invitationId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      } catch {
        resolve();
      } finally {
        database.close();
      }
    });
  }

  async clear(invitationId: string): Promise<void> {
    const database = await this.open();
    if (!database) return;

    return new Promise((resolve) => {
      try {
        const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
        transaction.objectStore(DRAFT_STORE_NAME).delete(invitationId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
      } catch {
        resolve();
      } finally {
        database.close();
      }
    });
  }
}

/** Used when storage is unavailable, so callers need no branch. */
export class NoopDraftStore implements LocalDraftStore {
  async read(): Promise<LocalDraft | null> {
    return null;
  }
  async write(): Promise<void> {
    return undefined;
  }
  async clear(): Promise<void> {
    return undefined;
  }
}
