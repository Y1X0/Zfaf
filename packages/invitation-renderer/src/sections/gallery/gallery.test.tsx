import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSnapshot } from '@zfaf/core';
import { InvitationRenderer } from '../../render/InvitationRenderer.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('gallery', () => {
  it('failed images hide without reserving height', () => {
    const manifest = JSON.parse(readFileSync(
      resolve('../../templates/elegant-simple/manifest.json'), 'utf8'
    ));

    const content = {
      couple: { groomName: 'A', brideName: 'B', shortName: 'A & B', message: 'Test', photo: null },
      wedding: { date: '2026-09-20', startTime: '20:00', endTime: null, timezone: 'UTC' },
      location: null,
      events: [],
      cover: null,
      gallery: [
        {
          id: 'g1',
          url: 'https://example.test/missing.avif',
          width: 800,
          height: 800,
          blurhash: null,
          alt: null,
        },
      ],
      music: null,
      rsvp: null,
    };

    const snap = createSnapshot({
      schemaVersion: 1,
      templateKey: manifest.key,
      templateVersion: manifest.version,
      locale: 'ar',
      timezone: 'UTC',
      theme: manifest.theme,
      sections: manifest.sections,
      content,
      publishedAt: new Date().toISOString(),
    });

    if (!snap.ok) throw new Error('Snapshot failed');

    const html = renderToStaticMarkup(InvitationRenderer({ snapshot: snap.snapshot }));

    // Image element should have onError set to data-failed attribute
    expect(html).toContain('data-failed');

    // Failed images should have CSS rule to hide them
    expect(html).toContain('.zf-gallery__image[data-failed]{display:none}');
  });
});
