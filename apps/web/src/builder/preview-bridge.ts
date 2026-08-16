import type { PatchOperation } from '@zfaf/core';

/**
 * The preview bridge (D5.8).
 *
 * The preview runs inside an `<iframe>` (docs/06 §5). That buys complete CSS
 * isolation — builder styles cannot leak into an invitation and vice versa —
 * and honest device emulation, because media queries evaluate against the
 * frame's real width rather than a simulated one.
 *
 * The cost is that the two sides can only talk through `postMessage`, which is
 * a cross-document channel and therefore an **untrusted input boundary**. Any
 * page that can get a handle on our window can post to it. So this module's
 * job is less about moving messages than about refusing the ones that did not
 * come from us:
 *
 *   • the origin is checked against our own, never `'*'`;
 *   • the payload shape is validated before anything reads a field;
 *   • an unrecognised message type is dropped silently rather than dispatched.
 *
 * Kept framework-free so the protocol can be tested without mounting an
 * iframe — the parts worth testing are the validation rules, not React.
 */

export const PREVIEW_PROTOCOL_VERSION = 1;

export type BuilderToPreview =
  | { readonly type: 'doc:replace'; readonly document: unknown; readonly version: number }
  | { readonly type: 'doc:patch'; readonly patch: readonly PatchOperation[] }
  | { readonly type: 'preview:setMode'; readonly device: PreviewDevice }
  | { readonly type: 'preview:setMotion'; readonly enabled: boolean };

export type PreviewToBuilder =
  | { readonly type: 'preview:ready' }
  | { readonly type: 'section:click'; readonly sectionId: string }
  | { readonly type: 'preview:error'; readonly message: string };

export interface Envelope<T> {
  readonly channel: 'zfaf-preview';
  readonly protocol: number;
  readonly payload: T;
}

/**
 * Device frames.
 *
 * Mobile is first and is the default. That is not a detail: ~40% of couples
 * build their invitation on a phone, and most guests open it on one, so the
 * preview should keep reminding the author of the real context (docs/06 §5).
 */
export const PREVIEW_DEVICES = {
  mobile: { width: 390, height: 844, label: 'mobile' },
  tablet: { width: 768, height: 1024, label: 'tablet' },
  desktop: { width: 1280, height: 800, label: 'desktop' },
} as const;

export type PreviewDevice = keyof typeof PREVIEW_DEVICES;
export const DEFAULT_PREVIEW_DEVICE: PreviewDevice = 'mobile';

export function envelope<T>(payload: T): Envelope<T> {
  return { channel: 'zfaf-preview', protocol: PREVIEW_PROTOCOL_VERSION, payload };
}

/**
 * Decides whether an arriving message is ours.
 *
 * Returns the payload or null; there is deliberately no "probably fine" branch.
 * The origin check is the load-bearing one — the channel marker only sorts our
 * own traffic from other libraries sharing the same window.
 */
export function readEnvelope<T>(
  event: { readonly origin: string; readonly data: unknown },
  expectedOrigin: string,
  isValidPayload: (candidate: unknown) => candidate is T,
): T | null {
  // Checked first and never relaxed to `'*'`. Everything below is only
  // meaningful once we know who sent it.
  if (event.origin !== expectedOrigin) return null;

  const data = event.data;
  if (data === null || typeof data !== 'object') return null;

  const candidate = data as Record<string, unknown>;
  if (candidate['channel'] !== 'zfaf-preview') return null;
  // A future preview build talking an older protocol is dropped rather than
  // half-understood.
  if (candidate['protocol'] !== PREVIEW_PROTOCOL_VERSION) return null;

  const payload = candidate['payload'];
  return isValidPayload(payload) ? payload : null;
}

export function isBuilderMessage(candidate: unknown): candidate is BuilderToPreview {
  if (candidate === null || typeof candidate !== 'object') return false;
  const message = candidate as Record<string, unknown>;

  switch (message['type']) {
    case 'doc:replace':
      return typeof message['version'] === 'number' && 'document' in message;
    case 'doc:patch':
      return Array.isArray(message['patch']);
    case 'preview:setMode':
      return typeof message['device'] === 'string' && message['device'] in PREVIEW_DEVICES;
    case 'preview:setMotion':
      return typeof message['enabled'] === 'boolean';
    default:
      // Unrecognised types are dropped, not dispatched. A preview that
      // executed whatever it was sent would undo the isolation the iframe was
      // chosen for.
      return false;
  }
}

export function isPreviewMessage(candidate: unknown): candidate is PreviewToBuilder {
  if (candidate === null || typeof candidate !== 'object') return false;
  const message = candidate as Record<string, unknown>;

  switch (message['type']) {
    case 'preview:ready':
      return true;
    case 'section:click':
      // Bounded: this id is used to open a panel, and an unbounded string from
      // a frame is not something to hand onward unchecked.
      return (
        typeof message['sectionId'] === 'string' &&
        message['sectionId'].length > 0 &&
        message['sectionId'].length <= 64
      );
    case 'preview:error':
      return typeof message['message'] === 'string';
    default:
      return false;
  }
}

/**
 * The builder's end of the channel.
 *
 * Buffers until the frame reports ready. Without that, the first document —
 * sent while the iframe is still parsing — is silently dropped and the preview
 * stays empty until the next keystroke.
 */
export class PreviewChannel {
  private ready = false;
  private readonly queue: BuilderToPreview[] = [];

  constructor(
    private readonly post: (message: Envelope<BuilderToPreview>, targetOrigin: string) => void,
    private readonly targetOrigin: string,
  ) {}

  send(message: BuilderToPreview): void {
    if (!this.ready) {
      this.queue.push(message);
      return;
    }
    this.post(envelope(message), this.targetOrigin);
  }

  /** Called when the frame reports `preview:ready`. Flushes what was buffered. */
  markReady(): void {
    if (this.ready) return;
    this.ready = true;
    for (const message of this.queue.splice(0)) {
      this.post(envelope(message), this.targetOrigin);
    }
  }

  /** The frame reloaded; anything sent before it speaks again must be buffered. */
  markNotReady(): void {
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  queuedCount(): number {
    return this.queue.length;
  }
}
