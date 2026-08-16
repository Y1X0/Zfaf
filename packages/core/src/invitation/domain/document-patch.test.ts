import { describe, expect, it } from 'vitest';

import {
  ALLOWED_PATCH_PREFIXES,
  DENIED_PATCH_SEGMENTS,
  MAX_PATCH_OPERATIONS,
  MAX_PATCH_VALUE_BYTES,
  applyPatch,
  conflictingPaths,
  pathsIntersect,
  pointerSegments,
  validatePatch,
} from './document-patch.js';

/**
 * Draft document patching.
 *
 * A patch is a list of instructions to mutate our database, supplied by the
 * client. That framing is the whole reason this module exists, and it is what
 * every test here is checking: which instructions we will carry out, and —
 * far more importantly — which we refuse.
 */

function doc(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    templateKey: 'classic-luxury',
    locale: 'ar',
    timezone: 'Asia/Riyadh',
    theme: { colors: { primary: '#b8860b', accent: '#e8d9a0' }, spacing: 'normal' },
    sections: [
      { id: 'hero', enabled: true, order: 0 },
      { id: 'gallery', enabled: true, order: 1 },
    ],
    content: {
      couple: { groomName: 'أحمد', brideName: 'سارة', message: null },
      wedding: { date: '2026-09-20', startTime: '20:00' },
      location: { venueName: null, address: null },
      events: [{ id: 'e1', title: 'حفل الزفاف' }],
      gallery: [{ id: 'g1' }, { id: 'g2' }],
      rsvp: { enabled: true, maxPartySize: 5 },
    },
  };
}

// ── the mandatory test ─────────────────────────────────────────────────────

describe('paths autosave may never write', () => {
  it.each([
    '/status',
    '/ownerId',
    '/slug',
    '/publishedAt',
    '/publishedVersionId',
    '/draftVersion',
    '/schemaVersion',
    '/templateKey',
    '/templateVersion',
  ])('refuses a patch naming %s', (path) => {
    // The scenario in one line: without this, autosave publishes an
    // invitation, or hands it to somebody else.
    const result = validatePatch([{ op: 'replace', path, value: 'PUBLISHED' }]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toHaveLength(1);
    expect(['DENIED_SEGMENT', 'PATH_NOT_ALLOWED']).toContain(result.violations[0]?.reason);
  });

  it('refuses a denied segment nested inside an allowed prefix', () => {
    // `/theme` is allowed; `/theme/ownerId` is still not.
    for (const segment of DENIED_PATCH_SEGMENTS) {
      const result = validatePatch([
        { op: 'replace', path: `/theme/${segment}`, value: 'anything' },
      ]);
      expect(result.ok, `/theme/${segment} was accepted`).toBe(false);
    }
  });

  it('refuses the whole patch when one operation is forbidden', () => {
    // Not a filter that drops the bad one: a client sending a forbidden path is
    // either broken or hostile, and neither should be half-applied.
    const result = validatePatch([
      { op: 'replace', path: '/content/couple/groomName', value: 'أحمد' },
      { op: 'replace', path: '/status', value: 'PUBLISHED' },
      { op: 'replace', path: '/theme/colors/primary', value: '#000000' },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.index).toBe(1);
  });

  it('decodes JSON Pointer escapes before checking segments', () => {
    // `~1` decodes to a literal `/` *inside a key name* — it cannot traverse,
    // so `/theme/~1status` addresses one key called "/status" nested under
    // theme and can never reach the document's own `/status`. What decoding
    // does buy is that a denied segment cannot hide behind an escape, which
    // requires the check to run on decoded text rather than raw.
    expect(pointerSegments('/theme/~1status')).toEqual(['theme', '/status']);
    expect(pointerSegments('/a/~0b')).toEqual(['a', '~b']);
    // Order matters: `~01` must decode to `~1`, not to `/`.
    expect(pointerSegments('/a/~01')).toEqual(['a', '~1']);

    // And the root-level path stays refused however it is written.
    expect(validatePatch([{ op: 'replace', path: '/status', value: 'x' }]).ok).toBe(false);
  });

  it('cannot be bypassed with a path that merely starts like an allowed one', () => {
    // `/themeEvil` shares a prefix with `/theme` as a string but is a
    // different field, so prefix matching has to respect the separator.
    for (const path of ['/themeEvil', '/sectionsOwner', '/contentX/couple', '/localeX']) {
      expect(validatePatch([{ op: 'replace', path, value: 1 }]).ok, path).toBe(false);
    }
  });

  it('refuses prototype-pollution segments', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const result = validatePatch([{ op: 'add', path: `/content/couple/${key}`, value: {} }]);
      expect(result.ok, key).toBe(false);
    }
  });

  it('records enough to investigate', () => {
    const result = validatePatch([{ op: 'replace', path: '/ownerId', value: 'attacker' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const violation = result.violations[0];
    expect(violation?.path).toBe('/ownerId');
    expect(violation?.index).toBe(0);
    expect(violation?.detail.length).toBeGreaterThan(10);
  });
});

describe('operations autosave may not use', () => {
  it.each(['move', 'copy', 'test', 'MOVE', '', 'replace ', 'delete'])('refuses "%s"', (op) => {
    // `move` and `copy` each name a second path, which would need the
    // allowlist applied twice; neither is anything the builder produces.
    const result = validatePatch([{ op, path: '/content/couple/groomName', value: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.reason).toBe('UNSUPPORTED_OP');
  });
});

describe('shape and size', () => {
  it.each([
    ['not an array', {}],
    ['a string', 'patch'],
    ['null', null],
    ['a number', 7],
  ])('refuses %s', (_label, input) => {
    expect(validatePatch(input).ok).toBe(false);
  });

  it('refuses an empty patch', () => {
    expect(validatePatch([]).ok).toBe(false);
  });

  it('refuses more operations than one autosave should carry', () => {
    const many = Array.from({ length: MAX_PATCH_OPERATIONS + 1 }, () => ({
      op: 'replace' as const,
      path: '/content/couple/groomName',
      value: 'x',
    }));
    const result = validatePatch(many);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.reason).toBe('TOO_MANY_OPERATIONS');
  });

  it('accepts exactly the limit', () => {
    const many = Array.from({ length: MAX_PATCH_OPERATIONS }, () => ({
      op: 'replace' as const,
      path: '/content/couple/groomName',
      value: 'x',
    }));
    expect(validatePatch(many).ok).toBe(true);
  });

  it('refuses an oversized value', () => {
    const result = validatePatch([
      {
        op: 'replace',
        path: '/content/couple/message',
        value: 'ا'.repeat(MAX_PATCH_VALUE_BYTES),
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.reason).toBe('VALUE_TOO_LARGE');
  });

  it('refuses add or replace with no value at all', () => {
    for (const op of ['add', 'replace'] as const) {
      const result = validatePatch([{ op, path: '/content/couple/message' }]);
      expect(result.ok, op).toBe(false);
      if (result.ok) continue;
      expect(result.violations[0]?.reason).toBe('MISSING_VALUE');
    }
  });

  it('accepts remove with no value, which is correct', () => {
    expect(validatePatch([{ op: 'remove', path: '/content/gallery/0' }]).ok).toBe(true);
  });

  it('distinguishes an explicit null value from an absent one', () => {
    // Clearing an optional field is `value: null`, and it must not be mistaken
    // for a malformed operation.
    const result = validatePatch([{ op: 'replace', path: '/content/couple/message', value: null }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations[0]?.value).toBeNull();
  });

  it('reports every violation, not only the first', () => {
    const result = validatePatch([
      { op: 'replace', path: '/status', value: 'x' },
      { op: 'copy', path: '/content/couple/groomName' },
      { op: 'replace', path: '/nowhere', value: 'x' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toHaveLength(3);
  });
});

describe('paths autosave may write', () => {
  it.each(ALLOWED_PATCH_PREFIXES)('accepts %s itself', (prefix) => {
    expect(validatePatch([{ op: 'replace', path: prefix, value: {} }]).ok).toBe(true);
  });

  it('accepts the fields the builder actually edits', () => {
    const result = validatePatch([
      { op: 'replace', path: '/content/couple/groomName', value: 'أحمد' },
      { op: 'replace', path: '/content/wedding/date', value: '2026-09-20' },
      { op: 'replace', path: '/content/location/venueName', value: 'قاعة النخيل' },
      { op: 'add', path: '/content/events/-', value: { id: 'e2', title: 'عقد القران' } },
      { op: 'remove', path: '/content/gallery/0' },
      { op: 'replace', path: '/theme/colors/primary', value: '#c9a227' },
      { op: 'replace', path: '/sections/1/enabled', value: false },
      { op: 'replace', path: '/timezone', value: 'Asia/Riyadh' },
    ]);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.violations)).toBe(true);
  });
});

// ── application ────────────────────────────────────────────────────────────

describe('applying a patch', () => {
  it('replaces a nested value', () => {
    const result = applyPatch(doc(), [
      { op: 'replace', path: '/content/couple/groomName', value: 'محمد' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = (result.document as Record<string, Record<string, Record<string, unknown>>>)[
      'content'
    ];
    expect(content?.['couple']?.['groomName']).toBe('محمد');
  });

  it('leaves the caller’s document untouched', () => {
    // A half-applied autosave is worse than a rejected one, because nobody
    // would know to retry it.
    const original = doc();
    const snapshot = JSON.stringify(original);
    applyPatch(original, [{ op: 'replace', path: '/content/couple/groomName', value: 'محمد' }]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('does not partially apply when a later operation fails', () => {
    const original = doc();
    const result = applyPatch(original, [
      { op: 'replace', path: '/content/couple/groomName', value: 'محمد' },
      { op: 'replace', path: '/content/couple/nonexistent', value: 'x' },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.index).toBe(1);
    expect(result.error).toBe('PATH_NOT_FOUND');
  });

  it('appends to an array with "-"', () => {
    const result = applyPatch(doc(), [
      { op: 'add', path: '/content/events/-', value: { id: 'e2' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = (result.document as { content: { events: unknown[] } }).content.events;
    expect(events).toHaveLength(2);
  });

  it('removes an array element by index', () => {
    const result = applyPatch(doc(), [{ op: 'remove', path: '/content/gallery/0' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gallery = (result.document as { content: { gallery: { id: string }[] } }).content.gallery;
    expect(gallery.map((image) => image.id)).toEqual(['g2']);
  });

  it('refuses an array index beyond the end', () => {
    for (const path of ['/content/gallery/9', '/content/gallery/-1']) {
      const result = applyPatch(doc(), [{ op: 'replace', path, value: {} }]);
      expect(result.ok, path).toBe(false);
    }
  });

  it('refuses to replace a key that is not there', () => {
    // Strict on purpose: replacing something absent means the client's idea of
    // the document has diverged from ours, which is a conflict to surface
    // rather than a write to guess at.
    const result = applyPatch(doc(), [
      { op: 'replace', path: '/content/couple/nickname', value: 'x' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('allows add to create a key, which is what RFC 6902 says', () => {
    const result = applyPatch(doc(), [
      { op: 'add', path: '/content/couple/nickname', value: 'أ & س' },
    ]);
    expect(result.ok).toBe(true);
  });

  it('refuses a path whose parent does not exist', () => {
    const result = applyPatch(doc(), [{ op: 'add', path: '/content/nothing/here', value: 1 }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('PARENT_NOT_FOUND');
  });

  it('does not pollute Object.prototype even if a forbidden path reached it', () => {
    // Validation rejects these long before application. Asserted anyway,
    // because a defence that only holds while the layer above holds is one
    // layer, not defence in depth.
    applyPatch(doc(), [{ op: 'add', path: '/content/couple/__proto__', value: { polluted: 1 } }]);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

// ── conflicts ──────────────────────────────────────────────────────────────

describe('deciding whether two edits conflict', () => {
  it('treats identical paths as conflicting', () => {
    expect(pathsIntersect(['/content/couple/groomName'], ['/content/couple/groomName'])).toBe(true);
  });

  it('treats a parent and its child as conflicting', () => {
    // Writing `/content/couple` and `/content/couple/groomName` concurrently is
    // a genuine conflict even though the strings differ.
    expect(pathsIntersect(['/content/couple'], ['/content/couple/groomName'])).toBe(true);
    expect(pathsIntersect(['/content/couple/groomName'], ['/content/couple'])).toBe(true);
  });

  it('treats disjoint paths as safe to merge', () => {
    // The common case by far: one device edits names, another edits colours.
    expect(pathsIntersect(['/content/couple/groomName'], ['/theme/colors/primary'])).toBe(false);
  });

  it('does not mistake a shared string prefix for a shared path', () => {
    expect(pathsIntersect(['/content/couple'], ['/content/coupleOther'])).toBe(false);
  });

  it('reports which of my paths are contended', () => {
    const contended = conflictingPaths(
      ['/content/couple/groomName', '/theme/colors/primary'],
      ['/content/couple', '/sections/0/enabled'],
    );
    expect(contended).toEqual(['/content/couple/groomName']);
  });
});
