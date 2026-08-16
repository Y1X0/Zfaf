import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { TEST_DATABASE_URL } from './helpers/database.js';

/**
 * Migration correctness.
 *
 * Verifies the whole path — empty database, run every migration, get the
 * expected schema — rather than only inspecting the current state. A schema
 * that is right but unreachable from an empty database is a production incident
 * waiting for the next environment to be provisioned.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A throwaway database, so the migration path is exercised from truly nothing. */
const SCRATCH_DATABASE = `zfaf_migration_check_${Date.now()}`;

function adminUrl(database: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

let admin: PrismaClient;
let scratch: PrismaClient | undefined;

beforeAll(async () => {
  admin = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}"`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH_DATABASE}"`);
}, 60_000);

afterAll(async () => {
  await scratch?.$disconnect();
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}"`);
  await admin.$disconnect();
}, 60_000);

describe('empty database → all migrations → expected schema', () => {
  it('applies every migration from scratch', () => {
    const output = execFileSync(
      'node',
      [resolve(packageRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      {
        cwd: packageRoot,
        env: { ...process.env, DATABASE_URL: adminUrl(SCRATCH_DATABASE) },
        encoding: 'utf8',
      },
    );
    expect(output).toMatch(/successfully applied|No pending migrations/i);
  }, 120_000);

  it('produces every expected table', async () => {
    scratch = new PrismaClient({ datasources: { db: { url: adminUrl(SCRATCH_DATABASE) } } });

    const rows = await scratch.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const tables = rows.map((row) => row.table_name);

    // The Phase 1 table set, listed explicitly. A table appearing here that is
    // not in docs/20-phase1-milestones.md means scope crept into the schema.
    for (const expected of [
      'analytics_events',
      'audit_logs',
      'email_verifications',
      'entitlement_overrides',
      'events',
      'invitation_members',
      'invitation_versions',
      'invitations',
      'media_assets',
      'music_tracks',
      'oauth_accounts',
      'password_resets',
      'plans',
      'reserved_slugs',
      'rsvps',
      'sessions',
      'settings',
      'slug_history',
      'subscriptions',
      'template_versions',
      'templates',
      'users',
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected);
    }

    // Deferred to Phase 2+ — their presence would mean unapproved scope.
    for (const deferred of ['payments', 'webhook_events', 'guests', 'reports', 'custom_domains']) {
      expect(tables, `unexpected table ${deferred}`).not.toContain(deferred);
    }
  });

  it('creates the required extensions', async () => {
    const rows = await scratch!.$queryRawUnsafe<{ extname: string }[]>(
      `SELECT extname FROM pg_extension ORDER BY extname`,
    );
    const extensions = rows.map((row) => row.extname);
    expect(extensions).toContain('citext');
    expect(extensions).toContain('pgcrypto');
  });

  it('creates the partial unique index that makes slugs safe', async () => {
    const rows = await scratch!.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'invitations_slug_live_key'`,
    );
    expect(rows).toHaveLength(1);
    // Partial, so a deleted invitation releases its slug.
    expect(rows[0]?.indexdef).toContain('WHERE');
    expect(rows[0]?.indexdef).toContain('deleted_at IS NULL');
  });

  it('creates the immutability triggers', async () => {
    const rows = await scratch!.$queryRawUnsafe<{ tgname: string }[]>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
    );
    const triggers = rows.map((row) => row.tgname);
    expect(triggers).toContain('invitation_versions_immutable');
    expect(triggers).toContain('audit_logs_append_only');
  });

  it('creates the check constraints that guard domain invariants', async () => {
    const rows = await scratch!.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
       WHERE contype = 'c' AND connamespace = 'public'::regnamespace
       ORDER BY conname`,
    );
    const constraints = rows.map((row) => row.conname);
    for (const expected of [
      'rsvps_party_size_range',
      'invitations_slug_shape',
      'invitations_published_requires_version',
      'entitlement_overrides_target_exclusive',
      'invitations_market_code_shape',
    ]) {
      expect(constraints, `missing constraint ${expected}`).toContain(expected);
    }
  });

  it('records the migration in the history table, so re-running is a no-op', async () => {
    const rows = await scratch!.$queryRawUnsafe<
      { migration_name: string; finished_at: Date | null }[]
    >(`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.finished_at).not.toBeNull();
  });
});
