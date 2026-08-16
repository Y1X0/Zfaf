import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  sha256Hex,
  snapshotChecksum,
  verifySnapshotChecksum,
} from './snapshot-checksum.js';

describe('sha256Hex', () => {
  /**
   * The NIST FIPS 180-4 vectors.
   *
   * An integrity digest is only worth the confidence that it is the algorithm
   * it claims to be. These are the published answers, not values this
   * implementation produced.
   */
  it('matches the published FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('handles a message that lands exactly on a block boundary', () => {
    // 56 bytes is where the length field no longer fits and a second block is
    // required — the classic off-by-one in a hand-written padding routine.
    expect(sha256Hex('a'.repeat(55))).toHaveLength(64);
    expect(sha256Hex('a'.repeat(56))).toHaveLength(64);
    expect(sha256Hex('a'.repeat(55))).not.toBe(sha256Hex('a'.repeat(56)));
  });

  it('hashes non-ASCII as UTF-8', () => {
    // The names on every invitation in the first market are Arabic; a digest
    // that mangled them would verify against nothing.
    expect(sha256Hex('أحمد')).toBe(sha256Hex('أحمد'));
    expect(sha256Hex('أحمد')).not.toBe(sha256Hex('سارة'));
  });
});

describe('canonicalize', () => {
  it('is blind to key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('preserves array order, because in a snapshot order is content', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('reaches nested values', () => {
    // The defect this module replaces: a checksum that ignored everything
    // below the top level, so two invitations for different couples hashed
    // identically.
    const left = { content: { couple: { groomName: 'أحمد' } } };
    const right = { content: { couple: { groomName: 'خالد' } } };
    expect(canonicalize(left)).not.toBe(canonicalize(right));
  });

  it('treats an absent key and an undefined one as the same document', () => {
    // They are the same once stored, so they must hash the same or the
    // checksum fails on a document nobody touched.
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('refuses values that cannot survive storage', () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalize(undefined)).toThrow(TypeError);
  });
});

describe('snapshotChecksum', () => {
  const snapshot = {
    schemaVersion: 1,
    content: { couple: { groomName: 'أحمد', brideName: 'سارة' }, gallery: [{ id: 'a' }] },
  };

  it('names its algorithm', () => {
    expect(snapshotChecksum(snapshot)).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('survives a round trip that reorders keys', () => {
    // PostgreSQL JSONB does exactly this, so a checksum that did not survive it
    // would fail on every read.
    const reordered = JSON.parse(
      JSON.stringify({
        content: { gallery: [{ id: 'a' }], couple: { brideName: 'سارة', groomName: 'أحمد' } },
        schemaVersion: 1,
      }),
    );
    expect(snapshotChecksum(reordered)).toBe(snapshotChecksum(snapshot));
  });

  it('changes when any nested value changes', () => {
    const tampered = structuredClone(snapshot);
    tampered.content.couple.groomName = 'خالد';
    expect(snapshotChecksum(tampered)).not.toBe(snapshotChecksum(snapshot));
  });

  it('changes when a photograph is inserted', () => {
    const tampered = structuredClone(snapshot);
    tampered.content.gallery.push({ id: 'b' });
    expect(snapshotChecksum(tampered)).not.toBe(snapshotChecksum(snapshot));
  });
});

describe('verifySnapshotChecksum', () => {
  const snapshot = { a: 1, b: { c: 'د' } };

  it('confirms an untouched snapshot', () => {
    expect(verifySnapshotChecksum(snapshot, snapshotChecksum(snapshot))).toBe('MATCH');
  });

  it('reports a tampered snapshot', () => {
    expect(verifySnapshotChecksum({ a: 2, b: { c: 'د' } }, snapshotChecksum(snapshot))).toBe(
      'MISMATCH',
    );
  });

  it('distinguishes an older algorithm from tampering', () => {
    // A row written before this module existed is not evidence of an attack,
    // and treating it as one would take honest invitations offline.
    expect(verifySnapshotChecksum(snapshot, 'v1-deadbeef')).toBe('UNKNOWN_ALGORITHM');
  });
});
