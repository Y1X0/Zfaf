import { describe, expect, it } from 'vitest';

import { type PatchOperation, applyPatch } from '@zfaf/core';

import { EditHistory, MAX_HISTORY_ENTRIES, invert } from './history.js';
import { decideRestore } from './local-draft-store.js';
import type { LocalDraft } from './autosave-engine.js';

/**
 * Undo/redo and local-draft restoration.
 *
 * Both are places where an implementation that is *nearly* right silently
 * loses a user's work, so the tests are written around exactly those edges:
 * an undo that reconstructs the wrong previous value, and a restore that
 * decides the server is fresher when it is not.
 */

function doc(): Record<string, unknown> {
  return {
    theme: { colors: { primary: '#b8860b' } },
    content: {
      couple: { groomName: 'أحمد', brideName: 'سارة', message: null },
      gallery: [{ id: 'g1' }, { id: 'g2' }],
    },
  };
}

function replace(path: string, value: unknown): PatchOperation {
  return { op: 'replace', path, value };
}

/** Applies operations and returns the resulting document, failing loudly. */
function apply(document: unknown, operations: readonly PatchOperation[]): unknown {
  const result = applyPatch(document, operations);
  if (!result.ok) throw new Error(`${result.error} at ${result.path}`);
  return result.document;
}

// ── inverses ───────────────────────────────────────────────────────────────

describe('computing the inverse of an edit', () => {
  it('inverts a replace to the previous value', () => {
    const inverse = invert([replace('/theme/colors/primary', '#c9a227')], doc());
    expect(inverse).toEqual([replace('/theme/colors/primary', '#b8860b')]);
  });

  it('inverts an add of a new key to a remove', () => {
    const inverse = invert([{ op: 'add', path: '/content/couple/nickname', value: 'أ&س' }], doc());
    expect(inverse).toEqual([{ op: 'remove', path: '/content/couple/nickname' }]);
  });

  it('inverts an add over an existing key to a replace', () => {
    // `add` on a key that already exists behaves as a replace, so its inverse
    // depends on which of the two it actually was.
    const inverse = invert([{ op: 'add', path: '/content/couple/message', value: 'مرحبا' }], doc());
    expect(inverse).toEqual([replace('/content/couple/message', null)]);
  });

  it('inverts a remove to an add of what was there', () => {
    const inverse = invert([{ op: 'remove', path: '/content/gallery/0' }], doc());
    expect(inverse).toEqual([{ op: 'add', path: '/content/gallery/0', value: { id: 'g1' } }]);
  });

  it('reverses the order, because undo unwinds', () => {
    const forward = [
      replace('/content/couple/groomName', 'محمد'),
      replace('/content/couple/brideName', 'نورة'),
    ];
    const inverse = invert(forward, doc());
    expect(inverse.map((operation) => operation.path)).toEqual([
      '/content/couple/brideName',
      '/content/couple/groomName',
    ]);
  });

  it('tracks intermediate state across a batch touching one path twice', () => {
    // Naively reading the original document twice would record the same
    // "previous" value for both, and undo would land on the wrong string.
    const forward = [
      replace('/content/couple/groomName', 'محمد'),
      replace('/content/couple/groomName', 'خالد'),
    ];
    const inverse = invert(forward, doc());
    const restored = apply(apply(doc(), forward), inverse) as ReturnType<typeof doc>;

    expect(
      (restored['content'] as Record<string, Record<string, unknown>>)['couple']?.['groomName'],
    ).toBe('أحمد');
  });

  it('round-trips: applying an edit then its inverse restores the document', () => {
    const forward = [
      replace('/theme/colors/primary', '#000000'),
      { op: 'add' as const, path: '/content/gallery/-', value: { id: 'g3' } },
      { op: 'remove' as const, path: '/content/gallery/0' },
    ];
    const before = doc();
    const restored = apply(apply(before, forward), invert(forward, before));
    expect(restored).toEqual(before);
  });

  it('refuses the whole batch when one inverse cannot be determined', () => {
    // A partial undo leaves the document in a state the user never saw, which
    // is worse than no undo at all.
    const inverse = invert(
      [replace('/content/couple/groomName', 'محمد'), replace('/nowhere/at/all', 1)],
      doc(),
    );
    expect(inverse).toEqual([]);
  });
});

// ── the stack ──────────────────────────────────────────────────────────────

describe('the undo stack', () => {
  it('starts empty', () => {
    const history = new EditHistory();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.undo()).toBeNull();
  });

  it('undoes and redoes an edit', () => {
    const history = new EditHistory();
    const before = doc();
    const forward = [replace('/theme/colors/primary', '#c9a227')];

    history.record('colour', forward, before);
    const after = apply(before, forward);

    const undone = history.undo();
    expect(undone).not.toBeNull();
    expect(apply(after, undone?.operations ?? [])).toEqual(before);

    const redone = history.redo();
    expect(apply(before, redone?.operations ?? [])).toEqual(after);
  });

  it('discards the redo stack once a new edit arrives', () => {
    // A new edit forks the timeline: what was redoable no longer applies to
    // the document that now exists.
    const history = new EditHistory();
    history.record('one', [replace('/theme/colors/primary', '#111111')], doc());
    history.undo();
    expect(history.canRedo()).toBe(true);

    history.record('two', [replace('/content/couple/groomName', 'محمد')], doc());
    expect(history.canRedo()).toBe(false);
  });

  it('does not record an edit it cannot invert', () => {
    const history = new EditHistory();
    history.record('impossible', [replace('/nowhere', 1)], doc());
    expect(history.canUndo()).toBe(false);
  });

  it('bounds its own memory', () => {
    // Snapshots would be megabytes on a phone; even inverse operations need a
    // ceiling.
    const history = new EditHistory();
    for (let index = 0; index < MAX_HISTORY_ENTRIES + 20; index += 1) {
      history.record(
        `edit ${index}`,
        [replace('/theme/colors/primary', `#00000${index % 10}`)],
        doc(),
      );
    }
    expect(history.depth().undo).toBe(MAX_HISTORY_ENTRIES);
  });

  it('names what undo would reverse', () => {
    const history = new EditHistory();
    history.record('colour change', [replace('/theme/colors/primary', '#c9a227')], doc());
    expect(history.nextUndoLabel()).toBe('colour change');
  });

  it('walks back through several edits in order', () => {
    const history = new EditHistory();
    let state: unknown = doc();

    for (const name of ['محمد', 'خالد', 'سعد']) {
      const forward = [replace('/content/couple/groomName', name)];
      history.record(name, forward, state);
      state = apply(state, forward);
    }

    for (const expected of ['خالد', 'محمد', 'أحمد']) {
      const undone = history.undo();
      state = apply(state, undone?.operations ?? []);
      expect(
        (state as Record<string, Record<string, Record<string, unknown>>>)['content']?.['couple']?.[
          'groomName'
        ],
      ).toBe(expected);
    }
  });
});

// ── restoring a local draft ────────────────────────────────────────────────

describe('deciding what to do with a local draft', () => {
  const draft = (overrides: Partial<LocalDraft> = {}): LocalDraft => ({
    document: doc(),
    version: 5,
    pending: [],
    updatedAt: '2026-08-16T12:00:00.000Z',
    ...overrides,
  });

  it('uses the server when there is no local draft', () => {
    expect(decideRestore(null, { version: 5 }).action).toBe('use-server');
  });

  it('uses the server when everything local was already saved', () => {
    expect(decideRestore(draft(), { version: 5 }).action).toBe('use-server');
  });

  it('restores unsent edits built on the current version', () => {
    // Unambiguous: replaying them loses nothing, so there is nothing to ask.
    const decision = decideRestore(
      draft({ pending: [replace('/content/couple/groomName', 'محمد')] }),
      { version: 5 },
    );
    expect(decision.action).toBe('use-local');
  });

  it('asks when another device saved and we still hold unsent work', () => {
    // Neither side is simply right.
    const decision = decideRestore(
      draft({ version: 4, pending: [replace('/content/couple/groomName', 'محمد')] }),
      { version: 7 },
    );

    expect(decision.action).toBe('ask');
    if (decision.action !== 'ask') return;
    expect(decision.pendingCount).toBe(1);
    expect(decision.localUpdatedAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('never silently discards unsent work', () => {
    // The property that matters most: for every combination of versions, a
    // draft holding pending operations is either restored or raised — never
    // dropped without the user hearing about it.
    for (const localVersion of [1, 5, 9]) {
      for (const serverVersion of [1, 5, 9]) {
        const decision = decideRestore(
          draft({ version: localVersion, pending: [replace('/theme/colors/primary', '#000000')] }),
          { version: serverVersion },
        );
        expect(decision.action, `local ${localVersion} server ${serverVersion}`).not.toBe(
          'use-server',
        );
      }
    }
  });
});
