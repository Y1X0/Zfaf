import { PrismaClient } from '@prisma/client';

import { syncTemplates } from '../src/template-sync.js';

/**
 * `pnpm --filter @zfaf/db db:templates` — puts the shipped manifests into the
 * database.
 *
 * A thin wrapper. The work is in `src/template-sync.ts`, because the seed and
 * the e2e fixtures need it too and neither can invoke a CLI.
 *
 * Exits non-zero on a refusal. A refused template means the library on disk and
 * the library in the database disagree, and a deploy that continues past that
 * ships a catalogue nobody checked.
 */
const prisma = new PrismaClient();
try {
  const report = await syncTemplates(prisma);
  console.warn(
    `[templates] created ${report.created.length}, updated ${report.updated.length}, unchanged ${report.unchanged.length}`,
  );
  for (const refusal of report.refused) {
    console.error(`[templates] refused ${refusal.key}: ${refusal.reason}`);
  }
  if (report.refused.length > 0) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
