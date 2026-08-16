'use client';

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';

import {
  BUILDER_STEP_DEFINITIONS,
  type BuilderStepId,
  isStepComplete,
  publishReadiness,
} from '@zfaf/core';

import { DesignPanel, SectionsPanel } from './Panels.js';
import { PublishPanel } from './PublishPanel.js';
import { CoupleStep, DateStep, EventsStep, LocationStep, MusicStep, PhotosStep } from './Steps.js';
import {
  DEFAULT_PREVIEW_DEVICE,
  PREVIEW_DEVICES,
  type PreviewDevice,
  type PreviewToBuilder,
  PreviewChannel,
  isPreviewMessage,
  readEnvelope,
} from './preview-bridge.js';
import type { SaveStatus } from './autosave-engine.js';
import { useBuilder } from './useBuilder.js';

/**
 * The builder shell (D5.1, D5.8).
 *
 * Two panes. On a phone they are tabs, because 390px cannot show an editor and
 * a preview at once and pretending otherwise produces two unusable halves. On
 * a wide screen they sit side by side. Switching tabs never unmounts either
 * pane — the preview iframe reloading on every tab switch would be slow and
 * would lose its scroll position.
 *
 * There is no save button anywhere in this file. That is the point.
 */

export interface BuilderProps {
  readonly invitationId: string;
  readonly title: string;
  readonly initialDocument: unknown;
  readonly initialVersion: number;
  /** Null until the invitation has been published at least once. */
  readonly initialSlug: string | null;
  /**
   * The public origin, resolved on the server.
   *
   * Passed down rather than read from `window.location`, because the address
   * shown in the publish dialog is the one that will be printed on QR codes —
   * and behind a proxy the browser's origin is not necessarily ours.
   */
  readonly publishedBaseUrl: string;
}

const STEP_LABELS: Readonly<Record<BuilderStepId, string>> = {
  couple: 'العروسان',
  date: 'الموعد',
  location: 'المكان',
  events: 'البرنامج',
  photos: 'الصور',
  music: 'الموسيقى',
};

function SaveIndicator({ status }: { status: SaveStatus }): ReactElement {
  // The words matter as much as the state: "غير متصل" alone reads as data
  // loss, so it always says where the work actually is (docs/06 §4).
  const text: Record<SaveStatus['kind'], string> = {
    clean: '✓ تم الحفظ',
    pending: '● جارٍ الحفظ…',
    saving: '● جارٍ الحفظ…',
    offline: '⚠ غير متصل — تعديلاتك محفوظة على جهازك',
    failed: '⚠ تعذّر الحفظ',
    conflict: '⚠ فُتحت في مكان آخر',
  };

  return (
    <span
      className={`zfb-save zfb-save--${status.kind}`}
      data-testid="save-status"
      data-status={status.kind}
      role="status"
      aria-live="polite"
    >
      <span className="zfb-save__dot" aria-hidden="true" />
      {text[status.kind]}
    </span>
  );
}

export function Builder({
  invitationId,
  title,
  initialDocument,
  initialVersion,
  initialSlug,
  publishedBaseUrl,
}: BuilderProps): ReactElement {
  const builder = useBuilder({ invitationId, initialDocument, initialVersion });
  const [step, setStep] = useState<BuilderStepId>('couple');
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [device, setDevice] = useState<PreviewDevice>(DEFAULT_PREVIEW_DEVICE);

  const frame = useRef<HTMLIFrameElement | null>(null);
  const channel = useRef<PreviewChannel | null>(null);

  if (!channel.current && typeof window !== 'undefined') {
    channel.current = new PreviewChannel((message, targetOrigin) => {
      frame.current?.contentWindow?.postMessage(message, targetOrigin);
    }, window.location.origin);
  }

  /** Listens for the frame reporting ready, and for section clicks. */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = readEnvelope<PreviewToBuilder>(
        event,
        window.location.origin,
        isPreviewMessage,
      );
      if (!message) return;

      if (message.type === 'preview:ready') {
        channel.current?.markReady();
        return;
      }
      if (message.type === 'section:click') {
        // Clicking a section in the preview jumps to the step that edits it.
        const target = SECTION_TO_STEP[message.sectionId];
        if (target) {
          setStep(target);
          setTab('edit');
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /**
   * Pushes the document into the frame whenever it changes.
   *
   * A whole document rather than a patch: the two sides then cannot drift, and
   * a document this size costs well under a frame to serialise. Patches are
   * available in the protocol for when a measurement says they are needed.
   */
  useEffect(() => {
    if (!builder.document) return;
    channel.current?.send({
      type: 'doc:replace',
      document: builder.document,
      version: initialVersion,
    });
  }, [builder.document, initialVersion]);

  const onFrameLoad = useCallback(() => {
    // A reload means anything already sent is gone; buffer until it speaks.
    channel.current?.markNotReady();
  }, []);

  /** Ctrl/⌘+Z and Ctrl/⌘+Shift+Z, the shortcuts people already know. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      if (event.shiftKey) builder.redo();
      else builder.undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [builder]);

  if (!builder.document) {
    return <p className="zfb-preview-empty">تعذّر تحميل هذه الدعوة.</p>;
  }

  const document = builder.document;
  const stepIndex = BUILDER_STEP_DEFINITIONS.findIndex((definition) => definition.id === step);
  const readiness = publishReadiness(document);
  const missing = readiness.filter((issue) => issue.severity === 'required');

  const StepComponent = {
    couple: CoupleStep,
    date: DateStep,
    location: LocationStep,
    events: EventsStep,
    photos: PhotosStep,
    music: MusicStep,
  }[step];

  /** Flushes before moving, so a step change never waits out the debounce. */
  const goToStep = (next: BuilderStepId) => {
    void builder.flush();
    setStep(next);
  };

  return (
    <div className="zfb">
      <header className="zfb__bar">
        <h1 className="zfb__title">{title}</h1>
        <SaveIndicator status={builder.status} />
        <div className="zfb__bar-actions">
          <button
            type="button"
            className="zfb-btn zfb-btn--icon"
            data-testid="undo"
            onClick={builder.undo}
            disabled={!builder.canUndo}
            aria-label="تراجع"
          >
            ↶
          </button>
          <button
            type="button"
            className="zfb-btn zfb-btn--icon"
            data-testid="redo"
            onClick={builder.redo}
            disabled={!builder.canRedo}
            aria-label="إعادة"
          >
            ↷
          </button>
        </div>
      </header>

      <div className="zfb__tabs" role="tablist" aria-label="تحرير أو معاينة">
        <button
          type="button"
          role="tab"
          className="zfb__tab"
          data-testid="tab-edit"
          aria-selected={tab === 'edit'}
          aria-controls="zfb-pane-edit"
          onClick={() => setTab('edit')}
        >
          تحرير
        </button>
        <button
          type="button"
          role="tab"
          className="zfb__tab"
          data-testid="tab-preview"
          aria-selected={tab === 'preview'}
          aria-controls="zfb-pane-preview"
          onClick={() => setTab('preview')}
        >
          معاينة
        </button>
      </div>

      <div className="zfb__panes">
        <section
          className="zfb__pane zfb__pane--edit"
          id="zfb-pane-edit"
          hidden={tab !== 'edit'}
          aria-label="تحرير"
        >
          {builder.restorePrompt ? (
            <div className="zfb-prompt" role="alertdialog" data-testid="restore-prompt">
              <p>
                لديك تعديلات غير محفوظة على هذا الجهاز من{' '}
                {new Date(builder.restorePrompt.localUpdatedAt).toLocaleString('ar')}. هل نستعيدها؟
              </p>
              <div className="zfb-prompt__actions">
                <button
                  type="button"
                  className="zfb-btn zfb-btn--primary"
                  data-testid="restore-accept"
                  onClick={builder.acceptRestore}
                >
                  استعادة تعديلاتي
                </button>
                <button
                  type="button"
                  className="zfb-btn"
                  data-testid="restore-decline"
                  onClick={builder.declineRestore}
                >
                  تجاهلها
                </button>
              </div>
            </div>
          ) : null}

          {builder.conflict ? (
            <div className="zfb-prompt" role="alertdialog" data-testid="conflict-prompt">
              <p>فُتحت هذه الدعوة في مكان آخر وتغيّرت نفس الحقول.</p>
              <div className="zfb-prompt__actions">
                <button
                  type="button"
                  className="zfb-btn zfb-btn--primary"
                  data-testid="conflict-keep-mine"
                  onClick={() => builder.resolveConflict('mine')}
                >
                  إبقاء تعديلاتي
                </button>
                <button
                  type="button"
                  className="zfb-btn"
                  data-testid="conflict-take-theirs"
                  onClick={() => builder.resolveConflict('theirs')}
                >
                  استخدام النسخة الأخرى
                </button>
              </div>
            </div>
          ) : null}

          <nav className="zfb-steps" aria-label="خطوات البناء">
            {BUILDER_STEP_DEFINITIONS.map((definition) => (
              <button
                key={definition.id}
                type="button"
                className="zfb-steps__item"
                data-testid={`step-${definition.id}`}
                aria-current={definition.id === step ? 'step' : undefined}
                onClick={() => goToStep(definition.id)}
              >
                {isStepComplete(document, definition.id) ? (
                  <span className="zfb-steps__tick" aria-label="مكتملة">
                    ✓
                  </span>
                ) : null}
                {STEP_LABELS[definition.id]}
              </button>
            ))}
          </nav>

          <StepComponent document={document} builder={builder} />

          <div className="zfb__nav">
            <button
              type="button"
              className="zfb-btn"
              data-testid="step-previous"
              disabled={stepIndex === 0}
              onClick={() => {
                const previous = BUILDER_STEP_DEFINITIONS[stepIndex - 1];
                if (previous) goToStep(previous.id);
              }}
            >
              → السابق
            </button>
            <button
              type="button"
              className="zfb-btn zfb-btn--primary"
              data-testid="step-next"
              disabled={stepIndex === BUILDER_STEP_DEFINITIONS.length - 1}
              onClick={() => {
                const next = BUILDER_STEP_DEFINITIONS[stepIndex + 1];
                if (next) goToStep(next.id);
              }}
            >
              التالي ←
            </button>
          </div>

          {missing.length > 0 ? (
            <p className="zfb-field__hint" data-testid="readiness">
              للنشر تحتاج: {missing.length} حقل مطلوب.
            </p>
          ) : (
            <p className="zfb-field__hint" data-testid="readiness">
              جاهزة للنشر.
            </p>
          )}

          <DesignPanel document={document} builder={builder} />
          <SectionsPanel document={document} builder={builder} />
          <PublishPanel
            invitationId={invitationId}
            document={document}
            initialSlug={initialSlug}
            publishedBaseUrl={publishedBaseUrl}
            flush={builder.flush}
          />
        </section>

        <section
          className="zfb__pane zfb__pane--preview"
          id="zfb-pane-preview"
          hidden={tab !== 'preview'}
          aria-label="معاينة"
        >
          <div className="zfb-preview">
            <div className="zfb-preview__devices" role="group" aria-label="حجم المعاينة">
              {(Object.keys(PREVIEW_DEVICES) as PreviewDevice[]).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className="zfb-swatch"
                  data-testid={`device-${candidate}`}
                  aria-pressed={device === candidate}
                  onClick={() => setDevice(candidate)}
                >
                  {PREVIEW_DEVICES[candidate].label}
                </button>
              ))}
            </div>

            <div className="zfb-preview__stage">
              <iframe
                ref={frame}
                className="zfb-preview__frame"
                data-device={device}
                data-testid="preview-frame"
                title="معاينة الدعوة"
                src={`/preview/${invitationId}`}
                onLoad={onFrameLoad}
                // The preview is same-origin so the bridge works, and sandboxed
                // so a template cannot navigate the builder or open a window.
                sandbox="allow-same-origin allow-scripts"
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Which step edits a given section, for click-through from the preview. */
const SECTION_TO_STEP: Readonly<Record<string, BuilderStepId>> = {
  hero: 'couple',
  couple: 'couple',
  countdown: 'date',
  events: 'events',
  location: 'location',
  gallery: 'photos',
  music: 'music',
  message: 'couple',
  story: 'couple',
  rsvp: 'couple',
  footer: 'couple',
};
