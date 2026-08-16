'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  type DraftDocument,
  Slug,
  canPublish,
  publicInvitationUrl,
  shareText,
  whatsappShareUrl,
} from '@zfaf/core';

/**
 * Publishing, from the builder (D6.1, D6.5, D6.7, D6.8).
 *
 * ## The honesty copy is the point of this component
 *
 * ADR-0017 makes one requirement that is not a nicety: the platform must never
 * describe an unlisted invitation as private. `noindex` keeps it out of search
 * results; it does nothing whatsoever to stop anyone holding the link from
 * opening it or forwarding it. A couple who uploads photographs believing
 * "unlisted" means "only my guests" has been misled by us, and in the target
 * market that is a real social harm, not a support ticket.
 *
 * So the same sentence appears in **all three** places the ADR names, and it
 * is one exported constant so it cannot drift between them:
 *
 *   1. before confirming (`data-honesty="confirm"`),
 *   2. beside the link on success (`data-honesty="success"`),
 *   3. beside the indexing switch in settings (`data-honesty="settings"`).
 *
 * There is deliberately no padlock icon and no use of the words "خاصة" or
 * "سرية" anywhere in this file.
 */

/** ADR-0017's required wording. One constant, three placements. */
export const UNLISTED_HONESTY =
  'دعوتك غير مُدرجة — لن تظهر في نتائج البحث، لكن أي شخص يملك الرابط يستطيع فتحها ومشاركته.';

export interface PublishPanelProps {
  readonly invitationId: string;
  readonly document: DraftDocument;
  readonly initialSlug: string | null;
  readonly publishedBaseUrl: string;
  /** Flushes pending edits, so publishing never races the autosave debounce. */
  readonly flush: () => Promise<void>;
}

type SlugState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'taken'; issue: string; suggestion: string | null };

type PublishState =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | { kind: 'published'; url: string; firstPublication: boolean }
  | { kind: 'error'; message: string; issues: readonly { field: string }[] };

export function PublishPanel({
  invitationId,
  document,
  initialSlug,
  publishedBaseUrl,
  flush,
}: PublishPanelProps): React.ReactElement {
  /**
   * The suggested address follows the names until the owner edits it.
   *
   * Computing it once at mount looked right and was not: the panel is rendered
   * with the rest of the builder, before a couple has typed anything, so the
   * suggestion was derived from two empty strings and never revisited — the
   * field stayed blank however much they filled in afterwards. Tracking
   * "has the owner touched this?" separately is what makes it a suggestion
   * rather than a one-shot guess, and it still never renames silently: once
   * they type, the field is theirs.
   */
  const suggested = Slug.suggestFromNames(
    document.content.couple.groomName,
    document.content.couple.brideName,
  );
  const [edited, setEdited] = useState(initialSlug !== null);
  const [typedSlug, setTypedSlug] = useState(initialSlug ?? '');
  const slug = edited ? typedSlug : suggested.ok ? suggested.value.value : '';

  const setSlug = useCallback((next: string) => {
    setEdited(true);
    setTypedSlug(next);
  }, []);
  const [slugState, setSlugState] = useState<SlugState>({ kind: 'idle' });
  const [state, setState] = useState<PublishState>({ kind: 'idle' });
  const [indexed, setIndexed] = useState(false);

  const ready = canPublish(document);

  /**
   * The availability check is advisory and says so.
   *
   * Between this answer and the write, someone else can claim the name. What
   * makes publishing safe is the database's unique index and the `SLUG_TAKEN`
   * the server returns when it loses that race; this only spares the owner a
   * pointless round trip.
   */
  useEffect(() => {
    if (slug.length < 3) {
      setSlugState({ kind: 'idle' });
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSlugState({ kind: 'checking' });
      void fetch(`/api/v1/slugs/available?slug=${encodeURIComponent(slug)}`)
        .then((response) => response.json())
        .then(
          (body: {
            data?: { available: boolean; issue: string | null; suggestion: string | null };
          }) => {
            if (cancelled || !body.data) return;
            setSlugState(
              body.data.available
                ? { kind: 'available' }
                : {
                    kind: 'taken',
                    issue: body.data.issue ?? 'TAKEN',
                    suggestion: body.data.suggestion,
                  },
            );
          },
        )
        .catch(() => {
          // A failed check is not a failed publish. Staying silent is better
          // than claiming a name is taken because the network hiccuped.
          if (!cancelled) setSlugState({ kind: 'idle' });
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [slug]);

  const publish = useCallback(async () => {
    setState({ kind: 'publishing' });
    // Everything typed must reach the server before the snapshot is taken, or
    // the couple publishes the version from a second and a half ago.
    await flush();

    const response = await fetch(`/api/v1/invitations/${invitationId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    const body = (await response.json()) as {
      data?: { url: string; firstPublication: boolean };
      error?: { message: string; details?: { issues?: { field: string }[] } };
    };

    if (response.ok && body.data) {
      setState({
        kind: 'published',
        url: body.data.url,
        firstPublication: body.data.firstPublication,
      });
      return;
    }

    setState({
      kind: 'error',
      message: body.error?.message ?? 'تعذّر النشر',
      issues: body.error?.details?.issues ?? [],
    });
  }, [flush, invitationId, slug]);

  const previewUrl = publicInvitationUrl(publishedBaseUrl, slug || 'your-invitation');

  return (
    <details className="zfb-panel" data-testid="publish-panel">
      <summary className="zfb-panel__summary">النشر</summary>

      <div className="zfb-panel__body">
        {/* ── the address ────────────────────────────────────────────────── */}
        <label className="zfb-field">
          <span className="zfb-field__label">رابط الدعوة</span>
          <input
            className="zfb-field__input"
            data-testid="publish-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            dir="ltr"
            inputMode="url"
            maxLength={48}
          />
          <span className="zfb-field__hint" data-testid="publish-url">
            {previewUrl}
          </span>
        </label>

        {slugState.kind === 'available' ? (
          <p className="zfb-field__hint" data-testid="slug-state">
            الرابط متاح.
          </p>
        ) : null}
        {slugState.kind === 'taken' ? (
          <p className="zfb-field__hint zfb-field__hint--warn" data-testid="slug-state">
            هذا الرابط غير متاح.
            {slugState.suggestion ? ` جرّب: ${slugState.suggestion}` : ''}
          </p>
        ) : null}

        {/* ── what publishing actually means: placement 1 of 3 ───────────── */}
        <p className="zfb-honesty" data-honesty="confirm" data-testid="honesty-confirm">
          {UNLISTED_HONESTY}
        </p>

        {!ready ? (
          <p className="zfb-field__hint zfb-field__hint--warn" data-testid="publish-blocked">
            أكمل الحقول المطلوبة قبل النشر.
          </p>
        ) : null}

        <button
          type="button"
          className="zfb-btn zfb-btn--primary"
          data-testid="publish"
          disabled={!ready || state.kind === 'publishing'}
          onClick={() => void publish()}
        >
          {state.kind === 'publishing' ? 'جارٍ النشر…' : 'نشر الدعوة'}
        </button>

        {state.kind === 'error' ? (
          <p className="zfb-field__hint zfb-field__hint--warn" data-testid="publish-error">
            {state.message}
          </p>
        ) : null}

        {/* ── after publishing: placement 2 of 3, beside the link ────────── */}
        {state.kind === 'published' ? (
          <div className="zfb-published" data-testid="publish-success">
            <p className="zfb-field__label">
              {state.firstPublication ? 'نُشرت دعوتك.' : 'حُدّثت الدعوة المنشورة.'}
            </p>
            <a
              className="zfb-published__link"
              data-testid="published-url"
              href={state.url}
              dir="ltr"
              target="_blank"
              rel="noreferrer"
            >
              {state.url}
            </a>

            <p className="zfb-honesty" data-honesty="success" data-testid="honesty-success">
              {UNLISTED_HONESTY}
            </p>

            <div className="zfb-published__actions">
              <a
                className="zfb-btn"
                data-testid="share-whatsapp"
                href={whatsappShareUrl(
                  shareText({
                    groomName: document.content.couple.groomName,
                    brideName: document.content.couple.brideName,
                    url: state.url,
                    locale: document.locale,
                  }),
                )}
                target="_blank"
                rel="noreferrer"
              >
                مشاركة على واتساب
              </a>
              {/* Downloads rather than previews: the point of the code is that
                  it goes onto something printed. */}
              <a
                className="zfb-btn"
                data-testid="qr-svg"
                href={`/api/v1/invitations/${invitationId}/qr?format=svg`}
              >
                تنزيل QR للطباعة
              </a>
              <a
                className="zfb-btn"
                data-testid="qr-png"
                href={`/api/v1/invitations/${invitationId}/qr?format=png&size=1024`}
              >
                تنزيل QR للمشاركة
              </a>
            </div>
          </div>
        ) : null}

        {/* ── settings: placement 3 of 3, beside the indexing switch ─────── */}
        <div className="zfb-visibility">
          <label className="zfb-toggle">
            <input
              type="checkbox"
              data-testid="visibility-indexed"
              checked={indexed}
              onChange={(event) => setIndexed(event.target.checked)}
            />
            <span>السماح لمحركات البحث بفهرسة الدعوة</span>
          </label>
          <p className="zfb-honesty" data-honesty="settings" data-testid="honesty-settings">
            {UNLISTED_HONESTY}
          </p>
        </div>
      </div>
    </details>
  );
}
