/**
 * Fetches a real HEVC-coded HEIC for the end-to-end processing test.
 *
 * We cannot produce one: the bundled libvips decodes HEVC but does not encode
 * it, so `sharp` can read an iPhone photo and never write one. And we do not
 * vendor a third-party photograph of unclear licence into a commercial
 * repository — so the fixture is fetched on demand into a gitignored directory
 * and the test that needs it skips, visibly, when it is absent.
 *
 * Usage: pnpm --filter @zfaf/media-processing fixtures:heic
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.heic';
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../src/__fixtures__/sample.heic');

const response = await fetch(SOURCE);
if (!response.ok) {
  console.error(`Could not fetch the fixture: HTTP ${response.status}`);
  process.exit(1);
}

const bytes = new Uint8Array(await response.arrayBuffer());

// The whole point of the fixture is that it is HEVC-coded. An AVIF file
// wearing a HEIC brand would make the test pass while proving nothing.
if (!Buffer.from(bytes).includes(Buffer.from('hvcC'))) {
  console.error('Fetched file is not HEVC-coded; refusing to write it.');
  process.exit(1);
}

await mkdir(dirname(target), { recursive: true });
await writeFile(target, bytes);
console.warn(`Wrote ${bytes.byteLength} bytes to ${target}`);
