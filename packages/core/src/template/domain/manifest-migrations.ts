import { MANIFEST_SCHEMA_VERSION } from './template-manifest.js';

/**
 * Manifest schema migration (ADR-0004, D3.10).
 *
 * A published invitation renders from the manifest it was published with. When
 * the manifest schema changes, three things must all remain true:
 *
 *   • An invitation published two years ago still renders. A guest opening a
 *     link from an old message must not meet an error.
 *   • The upgrade path is explicit and reviewable — a chain of small, named
 *     steps rather than a `if (!manifest.foo) manifest.foo = …` scattered
 *     through the parser, which is how a schema quietly becomes untyped.
 *   • Nothing is inferred. A migration that cannot state what it does to a
 *     field is a migration that will lose data.
 *
 * The registry below is **empty on purpose**. Only schema version 1 exists, so
 * there is nothing to migrate; writing speculative migrations for a version
 * nobody has designed would be inventing behaviour. What ships now is the
 * mechanism and its tests, so the first real migration is a data change rather
 * than an architectural one.
 */

export interface ManifestMigration {
  /** The schema version this step reads. */
  readonly from: number;
  /** The schema version it produces. Must be exactly `from + 1`. */
  readonly to: number;
  /** A one-line description, shown in migration logs and reviews. */
  readonly description: string;
  /** Pure: receives a copy, returns the upgraded document. */
  readonly migrate: (manifest: Record<string, unknown>) => Record<string, unknown>;
}

/** No migrations exist yet — version 1 is the only schema ever published. */
export const MANIFEST_MIGRATIONS: readonly ManifestMigration[] = [];

export type MigrationResult =
  | {
      readonly ok: true;
      readonly manifest: Record<string, unknown>;
      readonly applied: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

export interface MigrationOptions {
  /** Defaults to the shipped registry. */
  readonly migrations?: readonly ManifestMigration[];
  /**
   * Defaults to the current schema version.
   *
   * Overridable so the walk itself can be tested across a chain of versions
   * that does not exist yet — the alternative is a test that re-implements the
   * loop and therefore proves nothing about this function.
   */
  readonly targetVersion?: number;
}

/**
 * Upgrades a manifest to the current schema version.
 *
 * Refuses rather than guesses in every ambiguous case: an unreadable version,
 * a version newer than this build understands, or a gap in the migration
 * chain. A manifest that silently half-migrates is worse than one that is
 * rejected while an engineer is present.
 */
export function migrateManifest(input: unknown, options: MigrationOptions = {}): MigrationResult {
  const migrations = options.migrations ?? MANIFEST_MIGRATIONS;
  const target = options.targetVersion ?? MANIFEST_SCHEMA_VERSION;

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'Manifest is not an object' };
  }

  const source = input as Record<string, unknown>;
  const version = source['schemaVersion'];

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'Manifest has no readable schemaVersion' };
  }

  if (version > target) {
    // Forward migration is not possible: this build does not know what the
    // newer fields mean. This happens during a rollback, and the honest
    // answer is to say so rather than drop the fields.
    return {
      ok: false,
      reason: `Manifest schema version ${version} is newer than this build understands (${target})`,
    };
  }

  // Structured-clone the input so a migration cannot mutate the caller's object
  // — the same reason snapshots are frozen.
  let current: Record<string, unknown> = JSON.parse(JSON.stringify(source));
  const applied: string[] = [];

  for (let at = version; at < target; at += 1) {
    const step = migrations.find((candidate) => candidate.from === at);
    if (!step) {
      return { ok: false, reason: `No migration registered from schema version ${at}` };
    }
    if (step.to !== at + 1) {
      // A step that skips a version cannot be reviewed against the schema it
      // claims to produce.
      return {
        ok: false,
        reason: `Migration ${step.from}→${step.to} must advance exactly one version`,
      };
    }

    current = { ...step.migrate(current), schemaVersion: step.to };
    applied.push(`${step.from}→${step.to}: ${step.description}`);
  }

  return { ok: true, manifest: current, applied };
}
