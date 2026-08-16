import { describe, expect, it, vi } from 'vitest';

import {
  type BuilderToPreview,
  DEFAULT_PREVIEW_DEVICE,
  type Envelope,
  PREVIEW_DEVICES,
  PREVIEW_PROTOCOL_VERSION,
  PreviewChannel,
  envelope,
  isBuilderMessage,
  isPreviewMessage,
  readEnvelope,
} from './preview-bridge.js';

/**
 * The preview bridge.
 *
 * `postMessage` is a cross-document channel: any page that can get a handle on
 * our window can post to it. These tests are mostly about what the bridge
 * *refuses*, because that is the whole reason it exists as a module rather
 * than as two inline listeners.
 */

const OUR_ORIGIN = 'https://app.zfaf.test';

function accept(candidate: unknown): candidate is { type: string } {
  return candidate !== null && typeof candidate === 'object';
}

describe('deciding whether a message is ours', () => {
  it('accepts a well-formed message from our own origin', () => {
    const payload = readEnvelope(
      { origin: OUR_ORIGIN, data: envelope({ type: 'preview:ready' }) },
      OUR_ORIGIN,
      isPreviewMessage,
    );
    expect(payload).toEqual({ type: 'preview:ready' });
  });

  it('refuses a message from any other origin', () => {
    // The load-bearing check. Everything else is only meaningful once we know
    // who sent it.
    for (const origin of [
      'https://evil.test',
      'http://app.zfaf.test',
      'https://app.zfaf.test.evil.test',
      'null',
      '',
    ]) {
      const payload = readEnvelope(
        { origin, data: envelope({ type: 'preview:ready' }) },
        OUR_ORIGIN,
        isPreviewMessage,
      );
      expect(payload, origin).toBeNull();
    }
  });

  it('refuses a message that is not on our channel', () => {
    const payload = readEnvelope(
      { origin: OUR_ORIGIN, data: { channel: 'other-library', protocol: 1, payload: {} } },
      OUR_ORIGIN,
      accept,
    );
    expect(payload).toBeNull();
  });

  it('refuses a protocol version it does not speak', () => {
    // A newer preview build is dropped rather than half-understood.
    const payload = readEnvelope(
      {
        origin: OUR_ORIGIN,
        data: {
          channel: 'zfaf-preview',
          protocol: PREVIEW_PROTOCOL_VERSION + 1,
          payload: { type: 'preview:ready' },
        },
      },
      OUR_ORIGIN,
      isPreviewMessage,
    );
    expect(payload).toBeNull();
  });

  it.each([null, undefined, 'a string', 42, [], { nothing: true }])(
    'refuses malformed data (%s)',
    (data) => {
      expect(readEnvelope({ origin: OUR_ORIGIN, data }, OUR_ORIGIN, accept)).toBeNull();
    },
  );
});

describe('messages the builder sends', () => {
  it.each([
    { type: 'doc:replace', document: {}, version: 3 },
    { type: 'doc:patch', patch: [] },
    { type: 'preview:setMode', device: 'mobile' },
    { type: 'preview:setMotion', enabled: false },
  ])('accepts %o', (message) => {
    expect(isBuilderMessage(message)).toBe(true);
  });

  it.each([
    { type: 'doc:replace', document: {} },
    { type: 'doc:patch', patch: 'not an array' },
    { type: 'preview:setMode', device: 'watch' },
    { type: 'preview:setMotion', enabled: 'yes' },
    { type: 'eval', code: 'alert(1)' },
    { type: 'doc:replace' },
    {},
  ])('refuses %o', (message) => {
    // An unrecognised type is dropped, never dispatched. A preview that ran
    // whatever it was sent would undo the isolation the iframe was chosen for.
    expect(isBuilderMessage(message)).toBe(false);
  });
});

describe('messages the preview sends', () => {
  it('accepts a section click with a plausible id', () => {
    expect(isPreviewMessage({ type: 'section:click', sectionId: 'hero' })).toBe(true);
  });

  it('refuses an unbounded section id', () => {
    // The id opens a panel; an unbounded string from a frame is not something
    // to hand onward unchecked.
    expect(isPreviewMessage({ type: 'section:click', sectionId: 'x'.repeat(500) })).toBe(false);
    expect(isPreviewMessage({ type: 'section:click', sectionId: '' })).toBe(false);
  });

  it('refuses an unknown type', () => {
    expect(isPreviewMessage({ type: 'navigate', url: 'https://evil.test' })).toBe(false);
  });
});

describe('the channel', () => {
  it('buffers until the frame reports ready', () => {
    // Without this the first document — sent while the iframe is still parsing
    // — is dropped, and the preview stays empty until the next keystroke.
    const post = vi.fn();
    const channel = new PreviewChannel(post, OUR_ORIGIN);

    channel.send({ type: 'doc:replace', document: { a: 1 }, version: 1 });
    expect(post).not.toHaveBeenCalled();
    expect(channel.queuedCount()).toBe(1);

    channel.markReady();
    expect(post).toHaveBeenCalledTimes(1);
    expect(channel.queuedCount()).toBe(0);
  });

  it('flushes buffered messages in order', () => {
    const post = vi.fn();
    const channel = new PreviewChannel(post, OUR_ORIGIN);

    channel.send({ type: 'doc:replace', document: {}, version: 1 });
    channel.send({ type: 'preview:setMode', device: 'desktop' });
    channel.markReady();

    const types = post.mock.calls.map(
      (call) => (call[0] as Envelope<BuilderToPreview>).payload.type,
    );
    expect(types).toEqual(['doc:replace', 'preview:setMode']);
  });

  it('sends directly once ready', () => {
    const post = vi.fn();
    const channel = new PreviewChannel(post, OUR_ORIGIN);
    channel.markReady();

    channel.send({ type: 'preview:setMotion', enabled: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(channel.queuedCount()).toBe(0);
  });

  it('never targets a wildcard origin', () => {
    const post = vi.fn();
    const channel = new PreviewChannel(post, OUR_ORIGIN);
    channel.markReady();
    channel.send({ type: 'preview:setMotion', enabled: true });

    expect(post.mock.calls[0]?.[1]).toBe(OUR_ORIGIN);
    expect(post.mock.calls[0]?.[1]).not.toBe('*');
  });

  it('buffers again after the frame reloads', () => {
    const post = vi.fn();
    const channel = new PreviewChannel(post, OUR_ORIGIN);
    channel.markReady();
    channel.markNotReady();

    channel.send({ type: 'doc:replace', document: {}, version: 2 });
    expect(post).not.toHaveBeenCalled();
    expect(channel.isReady()).toBe(false);
  });

  it('ignores a repeated ready signal', () => {
    const post = vi.fn();
    const channel = new PreviewChannel(post, OUR_ORIGIN);
    channel.send({ type: 'doc:replace', document: {}, version: 1 });
    channel.markReady();
    channel.markReady();

    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('device frames', () => {
  it('defaults to mobile', () => {
    // Not a detail: most couples build on a phone and nearly all guests open
    // on one, so the preview keeps reminding the author of the real context.
    expect(DEFAULT_PREVIEW_DEVICE).toBe('mobile');
    expect(PREVIEW_DEVICES.mobile.width).toBe(390);
  });

  it('offers the three sizes the milestone requires', () => {
    expect(Object.keys(PREVIEW_DEVICES).sort()).toEqual(['desktop', 'mobile', 'tablet']);
  });
});
