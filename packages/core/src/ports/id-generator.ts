/**
 * Identifier generation as a dependency.
 *
 * Injecting it keeps use-case tests deterministic and keeps randomness out of
 * the render path, which must stay reproducible (ADR-0004).
 */
export interface IdGenerator {
  /** Primary keys. UUIDv7 in production: time-ordered, non-guessable. */
  uuid(): string;
  /** URL-safe opaque tokens (sessions, guest links, edit tokens). */
  token(bytes: number): string;
}
