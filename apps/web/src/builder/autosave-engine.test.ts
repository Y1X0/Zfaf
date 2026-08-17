import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PatchOperation } from '@zfaf/core';

import {
  AUTOSAVE_DEBOUNCE_MS,
  AutosaveEngine,
  type AutosaveTransport,
  type AutosaveOptions,
  type LocalDraft,
  type SaveRequest,
  type SaveResponse,
  type SaveStatus,
  coalesce,
} from './autosave-engine.js';

/**
 * The autosave engine.
 *
 * There is no save button, so these tests are the guarantee that the promise
 * holds: that typing is coalesced rather than flooded, that a dropped
 * connection loses nothing, that two devices editing different fields merge
 * without asking, and that closing a tab mid-edit is recoverable.
 *
 * Timers are injected, so "wait 1.5 seconds" is a function call rather than a
 * sleep and the suite stays fast and deterministic.
 */

const DOCUMENT = {
  locale: 'ar',
  theme: { colors: { primary: '#b8860b', accent: '#e8d9a0' } },
  sections: [{ id: 'hero', enabled: true }],
  content: {
    couple: { groomName: '', brideName: '', message: null },
    wedding: { date: '2026-09-20', startTime: '20:00' },
    gallery: [{ id: 'g1' }, { id: 'g2' }],
  },
};

const NOW = new Date('2026-08-16T12:00:00Z');

/** A controllable clock and timer queue. */
function harness() {
  const timers = new Map<number, { fn: () => void; dueAt: number }>();
  let handle = 0;
  let elapsed = 0;

  return {
    setTimer: (fn: () => void, ms: number) => {
      handle += 1;
      timers.set(handle, { fn, dueAt: elapsed + ms });
      return handle;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    now: () => new Date(NOW.getTime() + elapsed),
    /** Fires every timer whose deadline has passed. */
    advance: async (ms: number) => {
      elapsed += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.dueAt <= elapsed) {
          timers.delete(id);
          timer.fn();
        }
      }
      // Let the promise chain the timer started settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    pendingTimers: () => timers.size,
  };
}

function replace(path: string, value: unknown): PatchOperation {
  return { op: 'replace', path, value };
}

interface Recorder {
  readonly transport: AutosaveTransport;
  readonly requests: SaveRequest[];
  respondWith(response: SaveResponse | ((request: SaveRequest) => SaveResponse)): void;
}

function recordingTransport(initial: SaveResponse = { kind: 'saved', version: 2, savedAt: NOW }) {
  const requests: SaveRequest[] = [];
  let responder: SaveResponse | ((request: SaveRequest) => SaveResponse) = initial;

  const recorder: Recorder = {
    requests,
    respondWith(response) {
      responder = response;
    },
    transport: {
      save: async (request) => {
        requests.push(request);
        return typeof responder === 'function' ? responder(request) : responder;
      },
    },
  };
  return recorder;
}

function build(overrides: Partial<AutosaveOptions> = {}) {
  const clock = harness();
  const recorder = recordingTransport();
  const statuses: SaveStatus[] = [];
  const drafts: LocalDraft[] = [];

  const engine = new AutosaveEngine({
    transport: recorder.transport,
    initialDocument: structuredClone(DOCUMENT),
    initialVersion: 1,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    onStatusChange: (status) => statuses.push(status),
    persistLocally: (draft) => drafts.push(draft),
    ...overrides,
  });

  return { engine, clock, recorder, statuses, drafts };
}

// ── coalescing ─────────────────────────────────────────────────────────────

describe('coalescing repeated edits', () => {
  it('keeps only the last value written to a path', () => {
    // Typing "أحمد" produces one operation per keystroke; only the last one
    // matters. Without this, a minute of typing sends sixty operations
    // describing one field.
    const collapsed = coalesce([
      replace('/content/couple/groomName', 'أ'),
      replace('/content/couple/groomName', 'أح'),
      replace('/content/couple/groomName', 'أحمد'),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.value).toBe('أحمد');
  });

  it('keeps edits to different paths', () => {
    const collapsed = coalesce([
      replace('/content/couple/groomName', 'أحمد'),
      replace('/content/couple/brideName', 'سارة'),
    ]);
    expect(collapsed).toHaveLength(2);
  });

  it('preserves order across paths', () => {
    const collapsed = coalesce([replace('/a', 1), replace('/b', 1), replace('/a', 2)]);
    expect(collapsed.map((operation) => operation.path)).toEqual(['/a', '/b']);
    expect(collapsed[0]?.value).toBe(2);
  });

  it('never collapses across a structural change', () => {
    // `remove` shifts every later index, so an earlier `replace` on the same
    // path is not the same field any more.
    const collapsed = coalesce([
      replace('/content/gallery/0', { id: 'x' }),
      { op: 'remove', path: '/content/gallery/0' },
      replace('/content/gallery/0', { id: 'y' }),
    ]);
    expect(collapsed).toHaveLength(3);
  });
});

// ── debounce ───────────────────────────────────────────────────────────────

describe('debouncing', () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
  });

  it('sends nothing until the user stops typing', async () => {
    context.engine.edit([replace('/content/couple/groomName', 'أ')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS - 100);
    expect(context.recorder.requests).toHaveLength(0);

    await context.clock.advance(200);
    expect(context.recorder.requests).toHaveLength(1);
  });

  it('resets the timer on every keystroke', async () => {
    for (const value of ['أ', 'أح', 'أحم', 'أحمد']) {
      context.engine.edit([replace('/content/couple/groomName', value)]);
      await context.clock.advance(1000);
    }
    // Four seconds of typing, nothing sent yet.
    expect(context.recorder.requests).toHaveLength(0);

    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(context.recorder.requests).toHaveLength(1);
    // And one operation, not four.
    expect(context.recorder.requests[0]?.patch).toHaveLength(1);
    expect(context.recorder.requests[0]?.patch[0]?.value).toBe('أحمد');
  });

  it('flushes immediately when asked', async () => {
    // Step changes and tab-hide cannot wait out a debounce.
    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.engine.flush();
    expect(context.recorder.requests).toHaveLength(1);
  });

  it('does nothing when there is nothing queued', async () => {
    await context.engine.flush();
    expect(context.recorder.requests).toHaveLength(0);
  });
});

// ── the local document ─────────────────────────────────────────────────────

describe('the local document', () => {
  it('updates synchronously, before any network call', () => {
    // The preview must react within a frame; waiting on a round trip to show a
    // typed character would make the builder feel broken.
    const context = build();
    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);

    const document = context.engine.currentDocument() as typeof DOCUMENT;
    expect(document.content.couple.groomName).toBe('أحمد');
    expect(context.recorder.requests).toHaveLength(0);
  });

  it('refuses an operation it cannot apply locally', () => {
    // Queuing it anyway would send the server something we could not apply
    // ourselves.
    const context = build();
    const result = context.engine.edit([replace('/content/couple/nonexistent', 'x')]);

    expect(result.ok).toBe(false);
    expect(context.engine.pendingCount()).toBe(0);
  });

  it('persists locally after every edit, before the network (D5.6)', () => {
    // The iOS case: the user opens the photo picker, the browser is evicted
    // from memory, and nothing has been sent yet.
    const context = build();
    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);

    expect(context.drafts).toHaveLength(1);
    const draft = context.drafts[0] as LocalDraft;
    expect((draft.document as typeof DOCUMENT).content.couple.groomName).toBe('أحمد');
    expect(draft.pending).toHaveLength(1);
  });
});

// ── status ─────────────────────────────────────────────────────────────────

describe('the status indicator', () => {
  it('reports the real state through a save', async () => {
    const context = build();
    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    expect(context.engine.currentStatus().kind).toBe('pending');

    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(context.engine.currentStatus().kind).toBe('clean');
    expect(context.statuses.map((status) => status.kind)).toEqual(['pending', 'saving', 'clean']);
  });

  it('reports offline rather than clean when the network fails', async () => {
    const context = build();
    context.recorder.respondWith({ kind: 'offline' });

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);

    const status = context.engine.currentStatus();
    expect(status.kind).toBe('offline');
    if (status.kind !== 'offline') return;
    expect(status.queuedOperations).toBe(1);
  });

  it('knows when closing the tab would lose work', async () => {
    const context = build();
    expect(context.engine.hasUnsavedWork()).toBe(false);

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    expect(context.engine.hasUnsavedWork()).toBe(true);

    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(context.engine.hasUnsavedWork()).toBe(false);
  });
});

// ── offline and retry ──────────────────────────────────────────────────────

describe('losing the connection', () => {
  it('retries with backoff and loses nothing', async () => {
    const context = build();
    context.recorder.respondWith({ kind: 'offline' });

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(context.recorder.requests).toHaveLength(1);

    await context.clock.advance(1000);
    expect(context.recorder.requests).toHaveLength(2);
    await context.clock.advance(2000);
    expect(context.recorder.requests).toHaveLength(3);

    // The edit is still there, unchanged, through every failure.
    const document = context.engine.currentDocument() as typeof DOCUMENT;
    expect(document.content.couple.groomName).toBe('أحمد');
  });

  it('sends everything queued once the connection returns', async () => {
    const context = build();
    context.recorder.respondWith({ kind: 'offline' });

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);

    context.engine.edit([replace('/content/couple/brideName', 'سارة')]);
    context.recorder.respondWith({ kind: 'saved', version: 2, savedAt: NOW });
    await context.clock.advance(1000);

    const last = context.recorder.requests[context.recorder.requests.length - 1];
    expect(last?.patch.map((operation) => operation.path).sort()).toEqual([
      '/content/couple/brideName',
      '/content/couple/groomName',
    ]);
    expect(context.engine.currentStatus().kind).toBe('clean');
  });

  it('keeps retrying even while the user carries on typing', async () => {
    // The defect this guards against: a single timer slot meant a keystroke
    // cancelled the pending reconnect, so the person still typing — the one
    // whose work most needs saving — never retried at all.
    const context = build();
    context.recorder.respondWith({ kind: 'offline' });

    context.engine.edit([replace('/content/couple/groomName', 'أ')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(context.recorder.requests).toHaveLength(1);

    // Typing continues while offline.
    context.engine.edit([replace('/content/couple/groomName', 'أح')]);
    await context.clock.advance(1000);

    expect(context.recorder.requests.length).toBeGreaterThanOrEqual(2);
  });

  it('treats a thrown transport as offline rather than crashing', async () => {
    const clock = harness();
    const engine = new AutosaveEngine({
      transport: {
        save: async () => {
          throw new Error('network down');
        },
      },
      initialDocument: structuredClone(DOCUMENT),
      initialVersion: 1,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
    });

    engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(engine.currentStatus().kind).toBe('offline');
  });
});

// ── conflicts ──────────────────────────────────────────────────────────────

describe('two devices editing at once', () => {
  it('does not conflict merely because the field exists on the server', async () => {
    // The defect this guards against was found end to end: the server cannot
    // tell which fields changed — it has no per-version diffs — so it reports
    // every path that exists. Trusting that made *every* second device
    // conflict, which is precisely the case merging exists for.
    const context = build();
    const serverDocument = structuredClone(DOCUMENT);
    serverDocument.content.couple.groomName = 'أحمد';

    let call = 0;
    context.recorder.respondWith(() => {
      call += 1;
      return call === 1
        ? {
            kind: 'conflict',
            currentVersion: 5,
            currentDocument: serverDocument,
            // The server's over-broad answer: our own path, echoed back.
            conflictingPaths: ['/content/couple/brideName'],
          }
        : { kind: 'saved', version: 6, savedAt: NOW };
    });

    context.engine.edit([replace('/content/couple/brideName', 'سارة')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);

    // Nobody touched the bride's name, so there was nothing to ask about.
    expect(context.engine.currentStatus().kind).toBe('clean');
    const document = context.engine.currentDocument() as typeof DOCUMENT;
    expect(document.content.couple.brideName).toBe('سارة');
    expect(document.content.couple.groomName).toBe('أحمد');
  });

  it('rebases silently when the edits are disjoint', async () => {
    // The overwhelmingly common case: the same person, phone and laptop,
    // different fields. Asking them to choose would be noise.
    const context = build();
    const serverDocument = structuredClone(DOCUMENT);
    serverDocument.theme.colors.primary = '#c9a227';

    let call = 0;
    context.recorder.respondWith(() => {
      call += 1;
      return call === 1
        ? {
            kind: 'conflict',
            currentVersion: 5,
            currentDocument: serverDocument,
            conflictingPaths: [],
          }
        : { kind: 'saved', version: 6, savedAt: NOW };
    });

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);

    const document = context.engine.currentDocument() as typeof DOCUMENT;
    // Ours kept…
    expect(document.content.couple.groomName).toBe('أحمد');
    // …and theirs picked up.
    expect(document.theme.colors.primary).toBe('#c9a227');
    expect(context.engine.currentStatus().kind).toBe('clean');
  });

  it('asks the user when the same field was edited on both', async () => {
    const context = build();
    const serverDocument = structuredClone(DOCUMENT);
    serverDocument.content.couple.groomName = 'محمد';

    context.recorder.respondWith({
      kind: 'conflict',
      currentVersion: 5,
      currentDocument: serverDocument,
      conflictingPaths: ['/content/couple/groomName'],
    });

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);

    const status = context.engine.currentStatus();
    expect(status.kind).toBe('conflict');
    if (status.kind !== 'conflict') return;
    expect(status.conflictingPaths).toEqual(['/content/couple/groomName']);
  });

  it('exposes the server document so a dialog can act on either answer', async () => {
    // The status alone carries only the contended paths — enough to *show* a
    // dialog and not enough to resolve it, which is a defect the UI found.
    const context = build();
    const serverDocument = structuredClone(DOCUMENT);
    serverDocument.content.couple.groomName = 'محمد';

    context.recorder.respondWith({
      kind: 'conflict',
      currentVersion: 5,
      currentDocument: serverDocument,
      conflictingPaths: ['/content/couple/groomName'],
    });

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);

    const detail = context.engine.pendingConflict();
    expect(detail).not.toBeNull();
    expect(detail?.serverVersion).toBe(5);
    expect(detail?.serverDocument).toEqual(serverDocument);

    context.engine.resolveConflict('mine', serverDocument, 5);
    expect(context.engine.pendingConflict()).toBeNull();
  });

  it('discards nothing until the user chooses', async () => {
    const context = build();
    const serverDocument = structuredClone(DOCUMENT);
    serverDocument.content.couple.groomName = 'محمد';

    context.recorder.respondWith({
      kind: 'conflict',
      currentVersion: 5,
      currentDocument: serverDocument,
      conflictingPaths: ['/content/couple/groomName'],
    });

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);

    // Still ours on screen while the dialog is open.
    expect((context.engine.currentDocument() as typeof DOCUMENT).content.couple.groomName).toBe(
      'أحمد',
    );
  });

  it('keeps my edit when I choose mine', async () => {
    const context = build();
    const serverDocument = structuredClone(DOCUMENT);
    serverDocument.content.couple.groomName = 'محمد';
    serverDocument.theme.colors.primary = '#c9a227';

    context.recorder.respondWith({
      kind: 'conflict',
      currentVersion: 5,
      currentDocument: serverDocument,
      conflictingPaths: ['/content/couple/groomName'],
    });

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);

    context.engine.resolveConflict('mine', serverDocument, 5);

    const document = context.engine.currentDocument() as typeof DOCUMENT;
    expect(document.content.couple.groomName).toBe('أحمد');
    // Their unrelated change survives too — choosing "mine" is about the
    // contended field, not about discarding the rest of their work.
    expect(document.theme.colors.primary).toBe('#c9a227');
    expect(context.engine.currentVersion()).toBe(5);
  });

  it('takes the server version when I choose theirs', async () => {
    const context = build();
    const serverDocument = structuredClone(DOCUMENT);
    serverDocument.content.couple.groomName = 'محمد';

    context.recorder.respondWith({
      kind: 'conflict',
      currentVersion: 5,
      currentDocument: serverDocument,
      conflictingPaths: ['/content/couple/groomName'],
    });

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);

    context.engine.resolveConflict('theirs', serverDocument, 5);

    expect((context.engine.currentDocument() as typeof DOCUMENT).content.couple.groomName).toBe(
      'محمد',
    );
    expect(context.engine.hasUnsavedWork()).toBe(false);
  });
});

// ── rejection ──────────────────────────────────────────────────────────────

describe('a patch the server refuses', () => {
  it('does not retry it forever', async () => {
    // Retrying a refused patch would loop until the tab is closed, and the
    // server would record an audit row every time.
    const context = build();
    context.recorder.respondWith({ kind: 'rejected', message: 'Patch was refused' });

    context.engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);
    await context.clock.advance(60_000);

    expect(context.recorder.requests).toHaveLength(1);
    expect(context.engine.currentStatus().kind).toBe('failed');
  });
});

// ── restoring ──────────────────────────────────────────────────────────────

describe('coming back after the tab was closed', () => {
  it('restores the document and resends what was queued', async () => {
    const context = build();
    context.engine.restore({
      document: {
        ...structuredClone(DOCUMENT),
        content: {
          ...DOCUMENT.content,
          couple: { groomName: 'أحمد', brideName: 'سارة', message: null },
        },
      },
      version: 3,
      pending: [replace('/content/couple/groomName', 'أحمد')],
      updatedAt: NOW.toISOString(),
    });

    expect((context.engine.currentDocument() as typeof DOCUMENT).content.couple.groomName).toBe(
      'أحمد',
    );
    expect(context.engine.currentVersion()).toBe(3);
    expect(context.engine.currentStatus().kind).toBe('pending');

    await context.clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(context.recorder.requests).toHaveLength(1);
    expect(context.recorder.requests[0]?.baseVersion).toBe(3);
  });

  it('restores a clean draft without sending anything', async () => {
    const context = build();
    context.engine.restore({
      document: structuredClone(DOCUMENT),
      version: 3,
      pending: [],
      updatedAt: NOW.toISOString(),
    });

    expect(context.engine.currentStatus().kind).toBe('clean');
    await context.clock.advance(60_000);
    expect(context.recorder.requests).toHaveLength(0);
  });
});

// ── in-flight edits ────────────────────────────────────────────────────────

describe('editing while a save is in flight', () => {
  it('does not send the same operation twice', async () => {
    const context = build();
    // Held in a mutable box so TypeScript does not narrow it to `never`
    // through the callback it is assigned inside.
    const pending: { resolve?: (response: SaveResponse) => void } = {};

    const slow: AutosaveTransport = {
      save: (request) => {
        context.recorder.requests.push(request);
        return new Promise<SaveResponse>((resolve) => {
          pending.resolve = resolve;
        });
      },
    };

    const clock = harness();
    const engine = new AutosaveEngine({
      transport: slow,
      initialDocument: structuredClone(DOCUMENT),
      initialVersion: 1,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
    });

    engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    const flushing = engine.flush();

    engine.edit([replace('/content/couple/brideName', 'سارة')]);
    pending.resolve?.({ kind: 'saved', version: 2, savedAt: NOW });
    await flushing;

    const first = context.recorder.requests[0];
    expect(first?.patch.map((operation) => operation.path)).toEqual(['/content/couple/groomName']);
    // The second edit is queued, not lost and not duplicated.
    expect(engine.pendingCount()).toBe(1);
  });

  /**
   * The regression that published an invitation without its photograph.
   *
   * `flush` used to open with `if (this.saving) return;` — so the one call
   * whose whole purpose is *"send everything, now"* returned having sent
   * nothing whenever a save happened to be in flight, and reported success by
   * resolving. `PublishPanel` awaits exactly this call so that everything
   * typed reaches the server before the snapshot is taken.
   *
   * The observed failure: a couple adds a photograph, presses Publish inside
   * the debounce window, and the invitation goes live **without the
   * photograph** — no error, the edit still queued, the indicator still
   * spinning. Any edit made within a second and a half of acting was exposed,
   * which is most of them.
   */
  it('waits for the save in flight and still sends what was queued behind it', async () => {
    const requests: SaveRequest[] = [];
    const gate: { resolve?: (response: SaveResponse) => void } = {};
    let call = 0;

    const slow: AutosaveTransport = {
      save: (request) => {
        requests.push(request);
        call += 1;
        // Only the first request is held open; the rest answer at once.
        if (call === 1) return new Promise<SaveResponse>((resolve) => (gate.resolve = resolve));
        return Promise.resolve({ kind: 'saved', version: 3, savedAt: NOW } as SaveResponse);
      },
    };

    const clock = harness();
    const engine = new AutosaveEngine({
      transport: slow,
      initialDocument: structuredClone(DOCUMENT),
      initialVersion: 1,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
    });

    // A first edit, sent and left in flight — the autosave a person's typing
    // started a moment ago.
    engine.edit([replace('/content/couple/groomName', 'أحمد')]);
    const firstSave = engine.flush();

    // The photograph, added while that save is still open.
    engine.edit([replace('/content/couple/brideName', 'سارة')]);

    // …and Publish pressed. This is the call that must not return early.
    const publishFlush = engine.flush();
    gate.resolve?.({ kind: 'saved', version: 2, savedAt: NOW });
    await Promise.all([firstSave, publishFlush]);

    expect(engine.pendingCount(), 'an edit was still queued after flush resolved').toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.patch.map((operation) => operation.path)).toEqual([
      '/content/couple/brideName',
    ]);
  });
});

describe('vi is available for spies', () => {
  it('does not need fake timers', () => {
    // Timers are injected, so the suite never touches the global clock — which
    // is what keeps it fast and free of cross-test leakage.
    expect(typeof vi.fn).toBe('function');
  });
});
