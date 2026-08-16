/**
 * Browser-side media helpers.
 *
 * Separate from `@zfaf/core` because this code needs DOM APIs, and separate
 * from the web app so the builder (M5) and any later upload surface share one
 * implementation rather than each growing their own.
 */
export * from './compress-before-upload.js';
