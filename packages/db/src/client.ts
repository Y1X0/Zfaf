import { PrismaClient } from '@prisma/client';

/**
 * The Prisma client.
 *
 * This module is the only place in the codebase permitted to import Prisma; the
 * `zfaf/no-prisma-outside-db` lint rule rejects it everywhere else (ADR-0003).
 * Everything above this package depends on repository ports instead, which is
 * what keeps the domain testable without a database and portable off Prisma.
 */

export type { PrismaClient };

let singleton: PrismaClient | undefined;

/**
 * Returns a process-wide client.
 *
 * Reused across requests because each instance holds its own connection pool,
 * and serverless-style re-instantiation is a well-known way to exhaust
 * PostgreSQL's connection limit.
 */
export function getPrismaClient(databaseUrl?: string): PrismaClient {
  singleton ??= databaseUrl
    ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    : new PrismaClient();
  return singleton;
}

/** Test-only: an isolated client, so suites do not share a pool. */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

export async function disconnectPrisma(): Promise<void> {
  await singleton?.$disconnect();
  singleton = undefined;
}
