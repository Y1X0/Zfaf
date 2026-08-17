import { snapshotChecksum } from '@zfaf/core';

import { getPrismaClient } from '../src/client.js';

/**
 * Verifies that every published snapshot still hashes to what was recorded.
 *
 * ADR-0005 puts a checksum on `invitation_versions` for one reason: the
 * immutability trigger guards the path through the database engine, and a
 * restore from a doctored backup, a migration that rewrites JSONB, or a bug in
 * a future publish path all leave the row looking untouched. The checksum is
 * what makes such a change **detectable** rather than merely disallowed.
 *
 * So this is the check that gives a restored database meaning. "The row count
 * matches" says the rows arrived; this says they are the same rows.
 *
 *   DATABASE_URL=... pnpm --filter @zfaf/db exec tsx prisma/verify-checksums.ts
 *
 * Exits non-zero on the first mismatch found, and names every one.
 */

const BATCH = 500;

const prisma = getPrismaClient(process.env['DATABASE_URL']);

let checked = 0;
let cursor: string | undefined;
const mismatches: { id: string; invitationId: string; version: number }[] = [];

try {
  for (;;) {
    const rows = await prisma.invitationVersion.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        invitationId: true,
        versionNumber: true,
        publishedDocument: true,
        documentChecksum: true,
      },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      checked += 1;
      // The same function the publish path uses — a second implementation here
      // would verify our re-implementation rather than the stored snapshot.
      const actual = snapshotChecksum(row.publishedDocument as Record<string, unknown>);
      if (actual !== row.documentChecksum) {
        mismatches.push({
          id: row.id,
          invitationId: row.invitationId,
          version: row.versionNumber,
        });
      }
    }

    cursor = rows[rows.length - 1]?.id;
    if (rows.length < BATCH) break;
  }

  // `console.warn` rather than `log`: this is a script, and the lint rule that
  // keeps stray `console.log` out of application code applies here too.
  console.warn(`\nSnapshot integrity — ${checked} published versions checked`);

  if (mismatches.length > 0) {
    console.error(`\n✗ ${mismatches.length} snapshot(s) do not match their recorded checksum:`);
    for (const mismatch of mismatches) {
      console.error(`  • invitation ${mismatch.invitationId} version ${mismatch.version}`);
    }
    console.error(
      '\nThis means a published document changed after it was written. Do not switch\n' +
        'traffic to this database until it is understood — the invitation a guest sees\n' +
        'is not the one that was published.',
    );
    process.exit(1);
  }

  console.warn('✓ Every published snapshot hashes to what was recorded.');
} finally {
  await prisma.$disconnect();
}
