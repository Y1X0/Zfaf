import { type PatchOperation, applyPatch } from '@zfaf/core';

/**
 * Undo and redo (D5.11).
 *
 * Kept as a stack of **inverse operations** rather than a stack of document
 * snapshots. A builder document with a gallery is tens of kilobytes; fifty
 * snapshots is megabytes held live while somebody edits on a phone. An inverse
 * operation is a few dozen bytes.
 *
 * The inverse is computed at the moment of the edit, when the previous value
 * is still in hand — reconstructing it afterwards would mean keeping the very
 * snapshots this design avoids.
 *
 * Undo is a *local* concept: it produces a new edit, which autosaves like any
 * other. There is deliberately no "undo the save" — the server has no idea
 * this stack exists, and it should not.
 */

export const MAX_HISTORY_ENTRIES = 50;

export interface HistoryEntry {
  /** What the user did, for a future "Undo: colour change" label. */
  readonly label: string;
  readonly forward: readonly PatchOperation[];
  readonly backward: readonly PatchOperation[];
}

export class EditHistory {
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  /**
   * Records an edit and its inverse.
   *
   * `documentBefore` is required because the inverse of
   * `replace /a/b → "new"` is `replace /a/b → "<the old value>"`, and the old
   * value exists only before the edit is applied.
   */
  record(label: string, forward: readonly PatchOperation[], documentBefore: unknown): void {
    const backward = invert(forward, documentBefore);
    if (backward.length === 0) return;

    this.undoStack.push({ label, forward, backward });
    if (this.undoStack.length > MAX_HISTORY_ENTRIES) this.undoStack.shift();

    // A new edit forks the timeline: what was redoable no longer applies to
    // the document that now exists.
    this.redoStack.length = 0;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Returns the operations to apply, or null when there is nothing to undo. */
  undo(): { readonly label: string; readonly operations: readonly PatchOperation[] } | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return { label: entry.label, operations: entry.backward };
  }

  redo(): { readonly label: string; readonly operations: readonly PatchOperation[] } | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return { label: entry.label, operations: entry.forward };
  }

  /** Peeks at what undo would reverse, for the button's tooltip. */
  nextUndoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  depth(): { readonly undo: number; readonly redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
}

/**
 * Computes the inverse of a batch.
 *
 * Reversed, because undoing a sequence means undoing its last step first.
 * An operation whose inverse cannot be determined is dropped along with the
 * whole batch — a partial undo would leave the document in a state the user
 * never saw, which is worse than no undo at all.
 */
export function invert(
  operations: readonly PatchOperation[],
  documentBefore: unknown,
): PatchOperation[] {
  const inverse: PatchOperation[] = [];
  let state = documentBefore;

  for (const operation of operations) {
    const existing = readPointer(state, operation.path);

    switch (operation.op) {
      case 'replace':
        if (!existing.found) return [];
        inverse.push({ op: 'replace', path: operation.path, value: existing.value });
        break;

      case 'add': {
        if (operation.path.endsWith('/-')) {
          // Appending to an array. `-` addresses "after the last element",
          // which is not a position anything can be removed from — the inverse
          // has to name the index the new element will actually occupy.
          const parentPath = operation.path.slice(0, -2);
          const parent = readPointer(state, parentPath);
          if (!parent.found || !Array.isArray(parent.value)) return [];
          inverse.push({ op: 'remove', path: `${parentPath}/${parent.value.length}` });
          break;
        }
        // `add` on an object key that already existed behaves as a replace, so
        // its inverse depends on which of the two it was.
        inverse.push(
          existing.found
            ? { op: 'replace', path: operation.path, value: existing.value }
            : { op: 'remove', path: operation.path },
        );
        break;
      }

      case 'remove':
        if (!existing.found) return [];
        inverse.push({ op: 'add', path: operation.path, value: existing.value });
        break;
    }

    // Applied step by step so a later operation sees what the earlier one did
    // — otherwise two edits to the same path produce the same inverse twice.
    const applied = applyPatch(state, [operation]);
    if (!applied.ok) return [];
    state = applied.document;
  }

  return inverse.reverse();
}

function readPointer(
  document: unknown,
  pointer: string,
): { found: true; value: unknown } | { found: false } {
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

  let current: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      // `-` addresses the position after the last element, which never exists.
      if (segment === '-') return { found: false };
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.hasOwn(current as Record<string, unknown>, segment)) return { found: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }

  return { found: true, value: current };
}
