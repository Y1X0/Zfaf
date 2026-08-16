'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { type DraftDocument, applyPatch, parseDraftDocument, toPreviewSnapshot } from '@zfaf/core';
import { InvitationRenderer } from '@zfaf/invitation-renderer';

import {
  type BuilderToPreview,
  envelope,
  isBuilderMessage,
  readEnvelope,
} from '../../../../../builder/preview-bridge.js';

/**
 * The page inside the preview iframe (D5.8).
 *
 * This is the *same* `InvitationRenderer` the published page will use in M6.
 * That is the point of the iframe: not isolation for its own sake, but a
 * preview that cannot drift from the published result, because there is only
 * one renderer and one document shape.
 *
 * The frame owns no state a user can edit. It receives a document, draws it,
 * and reports clicks back. Everything arriving through `postMessage` is
 * validated by the bridge before a field is read.
 */

export interface PreviewFrameProps {
  readonly initialDocument: unknown;
  /** Fixed so the preview renders identically on every load. */
  readonly previewedAt: string;
}

export function PreviewFrame({
  initialDocument,
  previewedAt,
}: PreviewFrameProps): React.ReactElement {
  const t = useTranslations('builder.preview');
  /**
   * The builder and the preview are the same origin by construction, so our
   * own origin *is* the expected parent's.
   *
   * That also makes embedding elsewhere harmless: a hostile page's origin
   * never matches, so its messages are dropped and ours are never delivered
   * to it.
   */
  const parentOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  const [document, setDocument] = useState<DraftDocument | null>(() => {
    const parsed = parseDraftDocument(initialDocument);
    return parsed.ok ? parsed.document : null;
  });
  const [motionEnabled, setMotionEnabled] = useState(true);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const message = readEnvelope<BuilderToPreview>(event, parentOrigin, isBuilderMessage);
      if (!message) return;

      switch (message.type) {
        case 'doc:replace': {
          const parsed = parseDraftDocument(message.document);
          if (parsed.ok) setDocument(parsed.document);
          return;
        }
        case 'doc:patch': {
          // Applied to the frame's own copy. A patch that does not fit is
          // dropped rather than half-applied — the builder sends a full
          // document on its next save and the two resynchronise.
          setDocument((current) => {
            if (!current) return current;
            const applied = applyPatch(current, message.patch);
            if (!applied.ok) return current;
            const parsed = parseDraftDocument(applied.document);
            return parsed.ok ? parsed.document : current;
          });
          return;
        }
        case 'preview:setMotion':
          setMotionEnabled(message.enabled);
          return;
        case 'preview:setMode':
          // The frame's size is set by the builder's CSS, not from inside.
          return;
      }
    },
    [parentOrigin],
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    // Announced once the listener is attached, so nothing sent earlier is lost.
    window.parent.postMessage(envelope({ type: 'preview:ready' }), parentOrigin);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage, parentOrigin]);

  /**
   * Clicking a section opens its settings in the builder.
   *
   * Delegated from one listener rather than wired per section, because the
   * sections come from the renderer and it does not — and should not — know
   * the builder exists.
   */
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const section = target?.closest?.('[data-section]');
      const sectionId = section?.getAttribute('data-section');
      if (!sectionId) return;
      window.parent.postMessage(envelope({ type: 'section:click', sectionId }), parentOrigin);
    };

    window.document.addEventListener('click', onClick);
    return () => window.document.removeEventListener('click', onClick);
  }, [parentOrigin]);

  const projected = useMemo(() => {
    if (!document) return null;
    const result = toPreviewSnapshot(document, previewedAt);
    return result.ok ? result.snapshot : null;
  }, [document, previewedAt]);

  if (!projected) {
    return (
      <div className="zf-preview-empty" role="status">
        {t('unavailable')}
      </div>
    );
  }

  return (
    <div className={motionEnabled ? undefined : 'zf-preview--no-motion'}>
      <InvitationRenderer snapshot={projected} mode="preview" />
    </div>
  );
}
