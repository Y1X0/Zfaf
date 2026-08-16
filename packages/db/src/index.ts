/**
 * Data access layer.
 *
 * This is the only package permitted to import Prisma (ADR-0003, enforced by
 * `zfaf/no-prisma-outside-db`). Everything above it depends on repository ports
 * declared in `@zfaf/core`.
 *
 * The Prisma schema and repository implementations land in M1.
 */
export const DB_PACKAGE = '@zfaf/db' as const;
