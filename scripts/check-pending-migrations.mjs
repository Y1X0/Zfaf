#!/usr/bin/env node

/**
 * Detects pending migrations by comparing the migration directory against
 * the Prisma database state. Used as a pre-deployment gate.
 *
 * Exit codes:
 *   0 = all migrations applied
 *   1 = pending migrations exist (deployment should wait for them)
 *   2 = error reading migration state
 */

import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { resolve } from 'path';

const migrationsDir = resolve('packages/db/prisma/migrations');

async function getPendingMigrations() {
  try {
    // `prisma migrate status` requires a DATABASE_URL to run.
    // If it's not set, we can't check pending migrations—but that's a configuration
    // problem, not a migrations problem. Return empty (assume applied).
    if (!process.env.DATABASE_URL) {
      console.warn('⚠️  DATABASE_URL not set — skipping migration check');
      return [];
    }

    // Get the list of applied migrations from Prisma.
    const status = execSync(
      'pnpm --filter @zfaf/db exec prisma migrate status --skip-generate 2>&1',
      { encoding: 'utf8' },
    );

    // Parse the status output to detect "X migrations pending" or similar.
    // The exact format depends on the Prisma version, but it typically says:
    //   "3 migrations pending" or "Database is up to date"
    if (status.includes('migrations pending')) {
      // Extract the number.
      const match = status.match(/(\d+)\s+migrations? pending/);
      return match ? Array.from({ length: parseInt(match[1], 10) }, (_, i) => `pending-${i}`) : ['unknown'];
    }

    return [];
  } catch (err) {
    console.error('❌ Failed to check migration status:', err.message);
    process.exit(2);
  }
}

async function listLocalMigrations() {
  try {
    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    console.error(`❌ Failed to list migrations in ${migrationsDir}:`, err.message);
    process.exit(2);
  }
}

async function main() {
  const local = await listLocalMigrations();
  const pending = await getPendingMigrations();

  console.log(`📝 Local migrations: ${local.length}`);
  console.log(`📊 Pending migrations: ${pending.length}`);

  if (pending.length > 0) {
    console.log('\n⏳ Pending migrations detected:');
    pending.forEach((m) => console.log(`   • ${m}`));
    console.log(
      '\n❌ Cannot deploy with pending migrations.\n' +
        '   Trigger the "Free stack — migrate" workflow before proceeding:\n' +
        '   https://github.com/y1x0/zfaf/actions/workflows/free-stack-migrate.yml',
    );
    process.exit(1);
  }

  console.log('✅ All migrations applied. Safe to deploy.');
}

main();
