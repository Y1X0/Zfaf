'use client';

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

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

function SaveIndicator({ status }: { status: SaveStatus }): ReactElement {
  const t = useTranslations('builder.status');
  /**
   * The words matter as much as the state.
   *
   * "Offline" on its own reads as data loss, so the message always says where
   * the work actually is — on this device, still safe (docs/06 §4). Both
   * `pending` and `saving` say "saving": the distinction is real to the
   * autosave engine and meaningless to the person watching.
   */
  const text: Record<SaveStatus['kind'], string> = {
    clean: t('saved'),
    pending: t('saving'),
    saving: t('saving'),
    offline: t('offline'),
    failed: t('failed'),
    conflict: t('conflict'),
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
  const t = useTranslations('builder');
  const formatter = useFormatter();
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
    return <p className="zfb-preview-empty">{t('load.failed')}</p>;
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
            aria-label={t('shell.undo')}
          >
            ↶
          </button>
          <button
            type="button"
            className="zfb-btn zfb-btn--icon"
            data-testid="redo"
            onClick={builder.redo}
            disabled={!builder.canRedo}
            aria-label={t('shell.redo')}
          >
            ↷
          </button>
        </div>
      </header>

      <div className="zfb__tabs" role="tablist" aria-label={t('shell.tabsLabel')}>
        <button
          type="button"
          role="tab"
          className="zfb__tab"
          data-testid="tab-edit"
          aria-selected={tab === 'edit'}
          aria-controls="zfb-pane-edit"
          onClick={() => setTab('edit')}
        >
          {t('shell.editTab')}
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
          {t('shell.previewTab')}
        </button>
      </div>

      <div className="zfb__panes">
        <section
          className="zfb__pane zfb__pane--edit"
          id="zfb-pane-edit"
          hidden={tab !== 'edit'}
          aria-label={t('shell.editPane')}
        >
          {builder.restorePrompt ? (
            <div className="zfb-prompt" role="alertdialog" data-testid="restore-prompt">
              <p>
                {t('shell.restorePrompt', {
                  when: formatter.dateTime(new Date(builder.restorePrompt.localUpdatedAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })}
              </p>
              <div className="zfb-prompt__actions">
                <button
                  type="button"
                  className="zfb-btn zfb-btn--primary"
                  data-testid="restore-accept"
                  onClick={builder.acceptRestore}
                >
                  {t('shell.restoreAccept')}
                </button>
                <button
                  type="button"
                  className="zfb-btn"
                  data-testid="restore-decline"
                  onClick={builder.declineRestore}
                >
                  {t('shell.restoreDecline')}
                </button>
              </div>
            </div>
          ) : null}

          {builder.conflict ? (
            <div className="zfb-prompt" role="alertdialog" data-testid="conflict-prompt">
              <p>{t('conflict.body')}</p>
              <div className="zfb-prompt__actions">
                <button
                  type="button"
                  className="zfb-btn zfb-btn--primary"
                  data-testid="conflict-keep-mine"
                  onClick={() => builder.resolveConflict('mine')}
                >
                  {t('shell.conflictKeepMine')}
                </button>
                <button
                  type="button"
                  className="zfb-btn"
                  data-testid="conflict-take-theirs"
                  onClick={() => builder.resolveConflict('theirs')}
                >
                  {t('shell.conflictTakeTheirs')}
                </button>
              </div>
            </div>
          ) : null}

          <nav className="zfb-steps" aria-label={t('shell.stepsLabel')}>
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
                  <span className="zfb-steps__tick" aria-label={t('shell.stepComplete')}>
                    ✓
                  </span>
                ) : null}
                {t(`steps.${definition.id}`)}
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
              {t('shell.previous')}
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
              {t('shell.next')}
            </button>
          </div>

          {missing.length > 0 ? (
            <p className="zfb-field__hint" data-testid="readiness">
              {t('shell.missingFields', { count: missing.length })}
            </p>
          ) : (
            <p className="zfb-field__hint" data-testid="readiness">
              {t('shell.ready')}
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
          aria-label={t('shell.previewPane')}
        >
          <div className="zfb-preview">
            <div className="zfb-preview__devices" role="group" aria-label={t('shell.previewSize')}>
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
                title={t('shell.previewTitle')}
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
