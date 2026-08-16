/**
 * Data access layer.
 *
 * The only package permitted to import Prisma (ADR-0003, enforced by
 * `zfaf/no-prisma-outside-db`). Everything above depends on the repository
 * ports declared in `@zfaf/core`, which is what keeps the domain testable
 * without a database and portable off Prisma.
 */
export * from './client.js';
export * from './repositories/invitation.repository.js';
