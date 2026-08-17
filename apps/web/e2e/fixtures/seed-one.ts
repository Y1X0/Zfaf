import { seedPublished } from './seed.js';

/**
 * Seeds one published invitation and prints its slug.
 *
 * Exists so the CI budget and Lighthouse checks measure a **real published
 * page** rather than a hand-written fixture. Both are statements about what a
 * guest downloads, and a guest downloads a page assembled from a real snapshot
 * — measuring anything else would report a number nobody receives.
 *
 * Prints only the slug, so a shell can capture it:
 *
 *   SLUG="$(npx tsx e2e/fixtures/seed-one.ts)"
 */
const seeded = await seedPublished();
process.stdout.write(seeded.slug);
