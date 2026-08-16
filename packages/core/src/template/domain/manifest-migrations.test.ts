import { describe, expect, it } from 'vitest';

import {
  MANIFEST_MIGRATIONS,
  type ManifestMigration,
  migrateManifest,
} from './manifest-migrations.js';
import { MANIFEST_SCHEMA_VERSION } from './template-manifest.js';

/**
 * The manifest migration framework.
 *
 * No migration exists yet, so these tests drive the real walk with stand-in
 * steps and an overridden target version. That is the point of testing it now:
 * the first real schema change should be a data change, not the discovery that
 * the walk was never right.
 */

const doc = (version: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: version,
  key: 'classic-luxury',
  ...extra,
});

const noop = (from: number): ManifestMigration => ({
  from,
  to: from + 1,
  description: `${from}→${from + 1}`,
  migrate: (manifest) => manifest,
});

describe('the shipped registry', () => {
  it('registers no migration, because only one schema version exists', () => {
    expect(MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(MANIFEST_MIGRATIONS).toEqual([]);
  });

  it('passes a current-version manifest through untouched', () => {
    const input = doc(MANIFEST_SCHEMA_VERSION, { key: 'royal-gold' });
    const result = migrateManifest(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toEqual(input);
    expect(result.applied).toEqual([]);
  });
});

describe('refusal', () => {
  it.each([null, undefined, 'a string', 42, []])('refuses %s', (input) => {
    expect(migrateManifest(input).ok).toBe(false);
  });

  it.each([undefined, '1', 0, -1, 1.5, Number.NaN])(
    'refuses an unreadable schemaVersion (%s)',
    (version) => {
      const result = migrateManifest({ schemaVersion: version });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/readable schemaVersion/);
    },
  );

  it('refuses a manifest newer than this build understands', () => {
    // The rollback case. Dropping the unknown fields would silently discard a
    // designer's work; refusing says what actually happened.
    const result = migrateManifest(doc(MANIFEST_SCHEMA_VERSION + 5));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/newer than this build/);
  });

  it('refuses when a step in the chain is missing', () => {
    const result = migrateManifest(doc(1), { targetVersion: 3, migrations: [noop(2)] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/No migration registered from schema version 1/);
  });

  it('refuses a step that advances more than one version', () => {
    const result = migrateManifest(doc(1), {
      targetVersion: 3,
      migrations: [{ ...noop(1), to: 3 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/exactly one version/);
  });
});

describe('the walk', () => {
  it('applies each step in order and records what it did', () => {
    const result = migrateManifest(doc(1, { colours: 'old' }), {
      targetVersion: 3,
      migrations: [
        {
          from: 1,
          to: 2,
          description: 'rename colours to colors',
          migrate: (manifest) => {
            const { colours, ...rest } = manifest;
            return { ...rest, colors: colours };
          },
        },
        {
          from: 2,
          to: 3,
          description: 'add a default category',
          migrate: (manifest) => ({ ...manifest, category: 'classic' }),
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toEqual({
      schemaVersion: 3,
      key: 'classic-luxury',
      colors: 'old',
      category: 'classic',
    });
    expect(result.applied).toEqual([
      '1→2: rename colours to colors',
      '2→3: add a default category',
    ]);
  });

  it('stamps the resulting version even if a step forgets to', () => {
    const result = migrateManifest(doc(1), {
      targetVersion: 2,
      migrations: [
        { from: 1, to: 2, description: 'forgetful', migrate: (manifest) => ({ ...manifest }) },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest['schemaVersion']).toBe(2);
  });

  it('does not mutate the input', () => {
    // A migration that edits the caller's object turns a retry into a
    // double-application.
    const input = doc(1, { nested: { value: 'original' } });
    const before = JSON.stringify(input);

    migrateManifest(input, {
      targetVersion: 2,
      migrations: [
        {
          from: 1,
          to: 2,
          description: 'mutates its argument',
          migrate: (manifest) => {
            (manifest['nested'] as Record<string, unknown>)['value'] = 'changed';
            return manifest;
          },
        },
      ],
    });

    expect(JSON.stringify(input)).toBe(before);
  });

  it('picks the step by its source version, not by its position', () => {
    // Registration order is a human convenience; the chain must be resolved by
    // what each step declares.
    const result = migrateManifest(doc(1), {
      targetVersion: 3,
      migrations: [noop(2), noop(1)],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toEqual(['1→2: 1→2', '2→3: 2→3']);
  });
});
