import { clockSkew, correctedNow, countdownParts } from '@zfaf/core/countdown';

/**
 * Everything the published invitation does in the browser (D6.9, D6.10).
 *
 * One file, bundled to `public/invitation.js`, and it is the *only* JavaScript
 * the public page loads. That is the whole point of ADR-0020: an invitation is
 * a document, and the six behaviours below do not justify shipping a rendering
 * framework to run them.
 *
 * Every one of them is a progressive enhancement. Turn JavaScript off and the
 * page still has its names, its date, its photographs, its map link and its
 * RSVP form; the countdown simply shows dashes. Nothing here is load-bearing
 * for reading the invitation, and nothing here decides anything a server
 * should decide.
 *
 * It is deliberately written against `data-` attributes the renderer emits
 * rather than against class names, so restyling a template cannot break
 * behaviour and this file never needs to know which template is in use.
 */

type Cleanup = () => void;

const reducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ── countdown (D6.9) ────────────────────────────────────────────────────────

/**
 * The offset between this device's clock and ours.
 *
 * The page carries the instant the server generated it. Phone clocks are wrong
 * more often than anyone expects — set by hand, stuck after a flat battery, or
 * dragged along by the wrong time zone — and an uncorrected countdown produces
 * the most visible bug the product could have: an invitation telling a guest
 * the wedding was yesterday.
 *
 * The offset is measured once. Afterwards the device's own ticking is trusted,
 * because it is only the absolute reading that is suspect.
 */
function measureSkew(root: Document): number {
  const stamped = root.documentElement.getAttribute('data-server-now');
  if (!stamped) return 0;
  const serverNow = new Date(stamped);
  if (Number.isNaN(serverNow.getTime())) return 0;
  return clockSkew(serverNow, new Date());
}

function startCountdown(root: Document, skew: number): Cleanup {
  const container = root.querySelector<HTMLElement>('[data-countdown-target]');
  const target = container?.getAttribute('data-countdown-target');
  if (!container || !target) return () => {};

  const instant = new Date(target);
  if (Number.isNaN(instant.getTime())) return () => {};

  const cells = new Map<string, HTMLElement>();
  for (const cell of container.querySelectorAll<HTMLElement>('[data-countdown-unit]')) {
    const unit = cell.getAttribute('data-countdown-unit');
    if (unit) cells.set(unit, cell);
  }

  const tick = (): void => {
    const parts = countdownParts(instant, correctedNow(new Date(), skew));
    for (const [unit, cell] of cells) {
      const value = parts[unit as keyof typeof parts];
      if (typeof value !== 'number') continue;
      const text = String(value).padStart(2, '0');
      // Only written when it changed: assigning identical text still dirties
      // the node, and on a low-end phone a per-second reflow of four cells is
      // measurable.
      if (cell.textContent !== text) cell.textContent = text;
    }
    container.toggleAttribute('data-countdown-elapsed', parts.totalMilliseconds === 0);
  };

  tick();
  // One second exactly is enough: the seconds cell is the fastest thing here,
  // and a finer interval would only burn battery.
  const timer = window.setInterval(tick, 1000);
  return () => window.clearInterval(timer);
}

// ── music (D6.10) ───────────────────────────────────────────────────────────

/**
 * The music player, which never starts on its own.
 *
 * Not because browsers block autoplay — though they do — but because an
 * invitation that starts singing in a quiet room is a small betrayal of the
 * person who opened it. The audio element is `preload="none"`, so a guest who
 * never presses play never downloads the track either.
 */
function wireMusic(root: Document): Cleanup {
  const player = root.querySelector<HTMLElement>('[data-music-player]');
  const toggle = player?.querySelector<HTMLButtonElement>('[data-music-toggle]');
  const audio = player?.querySelector<HTMLAudioElement>('[data-music-audio]');
  if (!player || !toggle || !audio) return () => {};

  const setState = (playing: boolean): void => {
    toggle.setAttribute('aria-pressed', playing ? 'true' : 'false');
    player.toggleAttribute('data-playing', playing);
  };

  const onToggle = (): void => {
    if (audio.paused) {
      // A rejected play() is not an error worth showing: the guest pressed a
      // button, nothing happened, and pressing it again is the whole recovery.
      void audio.play().then(
        () => setState(true),
        () => setState(false),
      );
    } else {
      audio.pause();
      setState(false);
    }
  };

  const onEnded = (): void => setState(false);

  toggle.addEventListener('click', onToggle);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('pause', onEnded);

  return () => {
    toggle.removeEventListener('click', onToggle);
    audio.removeEventListener('ended', onEnded);
    audio.removeEventListener('pause', onEnded);
  };
}

// ── gallery (D6.10) ─────────────────────────────────────────────────────────

/**
 * A lightbox, built the first time someone opens one.
 *
 * Delegated from a single listener on the grid, and the dialog is created on
 * first use rather than at load. Most guests scroll past the photographs; they
 * should not pay for a viewer they never open.
 */
function wireGallery(root: Document): Cleanup {
  const grid = root.querySelector<HTMLElement>('.zf-gallery__grid');
  if (!grid) return () => {};

  let dialog: HTMLDialogElement | null = null;
  let image: HTMLImageElement | null = null;

  const build = (): HTMLDialogElement => {
    const created = root.createElement('dialog');
    created.className = 'zf-lightbox';
    created.setAttribute('data-lightbox', '');
    const picture = root.createElement('img');
    picture.className = 'zf-lightbox__image';
    picture.alt = '';
    const close = root.createElement('button');
    close.type = 'button';
    close.className = 'zf-lightbox__close';
    close.setAttribute('aria-label', root.documentElement.lang === 'en' ? 'Close' : 'إغلاق');
    close.textContent = '✕';
    close.addEventListener('click', () => created.close());
    // Clicking the backdrop closes it, which is what everyone expects and what
    // a `<dialog>` does not do on its own.
    created.addEventListener('click', (event) => {
      if (event.target === created) created.close();
    });
    created.append(picture, close);
    root.body.append(created);
    image = picture;
    return created;
  };

  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const source = target?.closest?.('img');
    if (!source || !grid.contains(source)) return;

    dialog ??= build();
    if (image) {
      image.src = source.currentSrc || source.src;
      image.alt = source.alt;
    }
    // `showModal` traps focus and handles Escape for us — reimplementing either
    // is how a lightbox becomes an accessibility problem.
    dialog.showModal();
  };

  grid.addEventListener('click', onClick);
  return () => grid.removeEventListener('click', onClick);
}

// ── share (D6.8) ────────────────────────────────────────────────────────────

/**
 * The share button.
 *
 * `navigator.share` where it exists — on a phone that is the native sheet,
 * which is where WhatsApp actually lives — and copying the link where it does
 * not. The button is rendered `hidden` by the server and revealed here, so a
 * guest without JavaScript is never shown a control that would do nothing.
 */
function wireShare(root: Document): Cleanup {
  const button = root.querySelector<HTMLButtonElement>('[data-share]');
  if (!button) return () => {};

  const url = button.getAttribute('data-share-url') ?? window.location.href;
  const title = button.getAttribute('data-share-title') ?? root.title;
  button.hidden = false;

  const onClick = (): void => {
    if (typeof navigator.share === 'function') {
      void navigator.share({ title, url }).catch(() => {
        // A cancelled share sheet rejects. That is the guest deciding not to
        // share, not a failure to report.
      });
      return;
    }
    void navigator.clipboard?.writeText(url).then(() => {
      button.setAttribute('data-copied', '');
      window.setTimeout(() => button.removeAttribute('data-copied'), 2000);
    });
  };

  button.addEventListener('click', onClick);
  return () => button.removeEventListener('click', onClick);
}

// ── the RSVP form (M7) ──────────────────────────────────────────────────────

/**
 * Submits the reply without leaving the page.
 *
 * Strictly an enhancement. The form has a real `action` and a real `method`,
 * so with this script absent the browser posts it and the server redirects
 * back with the outcome rendered into the page. All this adds is not losing
 * the guest's scroll position — which on a long invitation is most of the
 * felt quality.
 *
 * The endpoint is the same one the browser would have posted to, and it
 * answers JSON when asked to. Two code paths on the server would be two places
 * for the rules to drift.
 */
function wireRsvp(root: Document): Cleanup {
  const form = root.querySelector<HTMLFormElement>('[data-rsvp-form]');
  if (!form || !form.action) return () => {};

  const status = root.querySelector<HTMLElement>('[data-rsvp-status]');
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]');
  const arabic = root.documentElement.lang !== 'en';

  const say = (message: string, state: string): void => {
    if (!status) return;
    status.textContent = message;
    status.setAttribute('data-rsvp-status', state);
  };

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (submit) submit.disabled = true;
    say(arabic ? 'جارٍ الإرسال…' : 'Sending…', 'pending');

    void fetch(form.action, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new FormData(form),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          data?: { editToken?: string };
          error?: { code?: string };
        } | null;

        if (response.ok) {
          /**
           * The edit token is kept in this browser and nowhere else.
           *
           * It is what lets the guest correct their answer for a day without
           * an account. `sessionStorage` rather than `localStorage`: it is a
           * credential with a 24-hour life, and leaving it on a shared phone
           * for months afterwards is a worse trade than losing the ability to
           * edit after the tab closes.
           */
          if (body?.data?.editToken) {
            try {
              window.sessionStorage.setItem(`zf-rsvp:${form.action}`, body.data.editToken);
            } catch {
              // Private browsing refuses storage. Losing the ability to edit is
              // a small loss; failing the reply over it would be a large one.
            }
          }
          form.hidden = true;
          say(
            arabic ? 'شكراً لك! تم تسجيل ردّك.' : 'Thank you — your reply has been recorded.',
            'ok',
          );
          return;
        }

        if (submit) submit.disabled = false;
        say(messageFor(body?.error?.code ?? '', arabic), 'error');
      })
      .catch(() => {
        // The connection failed, not the reply. Re-enabling the button and
        // saying so is better than a silent dead end — and the form still has
        // its native action, so a plain reload-and-submit also works.
        if (submit) submit.disabled = false;
        say(
          arabic
            ? 'تعذّر الإرسال. تحقّق من الاتصال وأعد المحاولة.'
            : 'Could not send. Check your connection and try again.',
          'error',
        );
      });
  };

  form.addEventListener('submit', onSubmit);
  return () => form.removeEventListener('submit', onSubmit);
}

function messageFor(code: string, arabic: boolean): string {
  switch (code) {
    case 'RATE_LIMITED':
      return arabic
        ? 'وصلنا عدد كبير من المحاولات. انتظر قليلاً ثم أعد المحاولة.'
        : 'That is a lot of attempts. Please wait a moment and try again.';
    case 'RSVP_REFUSED':
    case 'NOT_FOUND':
      return arabic
        ? 'هذه الدعوة لم تعد تستقبل الردود.'
        : 'This invitation is no longer accepting replies.';
    case 'HUMAN_CHECK_REQUIRED':
      return arabic
        ? 'نحتاج تأكيداً بسيطاً أنك لست روبوتاً. أعد المحاولة.'
        : 'We need a quick check that you are not a robot. Please try again.';
    default:
      return arabic
        ? 'تحقّق من الاسم وعدد الأشخاص ثم أعد المحاولة.'
        : 'Please check the name and number of guests, then try again.';
  }
}

// ── auto-scroll ────────────────────────────────────────────────────────────

/**
 * The page scrolls itself from top to bottom on load, playing the invitation
 * like a short film. The guest takes over permanently on first input.
 *
 * Skipped entirely when reduced motion is requested — this is not slowed,
 * it is skipped. Moving the viewport under someone who asked for reduced
 * motion is worse than any fade (ADR-0010).
 */
function wireAutoScroll(root: Document): Cleanup {
  if (reducedMotion()) {
    root.documentElement.setAttribute('data-auto-scroll', 'skipped-reduced-motion');
    return () => {};
  }

  let cancelled = false;
  let started = false;

  const cancel = (reason: string): void => {
    if (!cancelled) {
      root.documentElement.setAttribute('data-auto-scroll', `cancelled-${reason}`);
    }
    cancelled = true;
  };

  const startScroll = (): void => {
    if (cancelled || started) return;

    // Check if there's room to scroll
    const maxScroll = root.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll <= 0) {
      root.documentElement.setAttribute('data-auto-scroll', 'no-scroll-room');
      return;
    }

    started = true;
    root.documentElement.setAttribute('data-auto-scroll', 'started');

    const rsvpForm = root.querySelector<HTMLFormElement>('[data-rsvp-form]');
    const startTime = performance.now();
    const scrollSpeed = 95; // pixels per second (~32s for typical 3000px invitation)

    const scroll = (now: number): void => {
      if (cancelled) return;

      // Check if RSVP form has focus
      if (rsvpForm && root.activeElement?.closest('[data-rsvp-form]')) {
        cancel('rsvp-focus');
        return;
      }

      // Recompute scroll bounds each frame (images load lazily)
      const currentMaxScroll = root.documentElement.scrollHeight - window.innerHeight;
      const elapsed = (now - startTime) / 1000; // milliseconds to seconds
      const target = Math.ceil(Math.min(elapsed * scrollSpeed, currentMaxScroll));

      window.scrollTo(0, target);

      // Stop if we've reached the bottom
      if (target < currentMaxScroll && !cancelled) {
        requestAnimationFrame(scroll);
      }
    };

    requestAnimationFrame(scroll);
  };

  // Start after ~2 seconds using performance.now() for device-independent timing
  const delayStart = performance.now();
  const delayLoop = (now: number): void => {
    const elapsed = (now - delayStart) / 1000; // milliseconds to seconds
    if (elapsed >= 2) {
      startScroll();
    } else if (!cancelled) {
      requestAnimationFrame(delayLoop);
    }
  };

  const onInput = (event: Event): void => cancel(event.type);
  const onVisibilityChange = (): void => {
    if (root.hidden) cancel('visibility');
  };

  // Start the delay loop
  requestAnimationFrame(delayLoop);

  // Cancel on user input
  root.addEventListener('touchstart', onInput, { passive: true });
  root.addEventListener('wheel', onInput, { passive: true });
  root.addEventListener('keydown', onInput);
  root.addEventListener('pointerdown', onInput, { passive: true });
  root.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    if (!cancelled) cancel('cleanup');
    root.removeEventListener('touchstart', onInput);
    root.removeEventListener('wheel', onInput);
    root.removeEventListener('keydown', onInput);
    root.removeEventListener('pointerdown', onInput);
    root.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

// ── scroll reveal ───────────────────────────────────────────────────────────

/**
 * Sections fade in as they arrive.
 *
 * Skipped entirely when the visitor has asked for reduced motion — not damped,
 * skipped, and the sections are left visible. An animation someone has told
 * their operating system they do not want is not a decision for us to revisit
 * (ADR-0010).
 */
function wireReveal(root: Document): Cleanup {
  if (reducedMotion() || typeof IntersectionObserver === 'undefined') return () => {};

  const sections = [...root.querySelectorAll<HTMLElement>('[data-section]')];
  if (sections.length === 0) return () => {};

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute('data-revealed', '');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px' },
  );

  for (const section of sections) {
    section.setAttribute('data-reveal', '');
    observer.observe(section);
  }

  return () => observer.disconnect();
}

// ── entry point ─────────────────────────────────────────────────────────────

// ── the view beacon (D8.1, D8.2) ────────────────────────────────────────────

/**
 * Reports one view, anonymously, and forgets about it.
 *
 * Everything about this is deliberately unremarkable, because it is the piece
 * most likely to be turned into something it should not be:
 *
 *   • **It sets no cookie and reads no storage.** Not `document.cookie`, not
 *     `localStorage`, not `sessionStorage`, no fingerprinting of any kind. The
 *     public page must show zero cookies in a browser inspection and this is
 *     the only call that could have broken that (ADR-0009).
 *   • **It sends the slug and the word `view`.** Nothing else. No screen size,
 *     no timezone, no referrer, no identifier — the server derives the device
 *     category from the User-Agent it was going to receive anyway, and derives
 *     nothing else at all.
 *   • **It cannot fail visibly.** `sendBeacon` is fire-and-forget by
 *     definition and the `fetch` fallback ignores its own result. The endpoint
 *     answers `204` unconditionally, so there is nothing to handle.
 *
 * `keepalive` on the fallback matters on a page people close quickly: without
 * it a guest who reads the date and shuts the tab is never counted.
 */
function reportView(root: Document): Cleanup {
  const slug = root.documentElement.getAttribute('data-invitation-slug');
  if (!slug) return () => {};

  const body = JSON.stringify({ slug, type: 'view' });
  const url = '/api/public/analytics/event';

  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) {
      return () => {};
    }
  } catch {
    // Some browsers throw rather than return false when the payload type is
    // refused. Either way the fallback below covers it.
  }

  void fetch(url, {
    method: 'POST',
    body,
    keepalive: true,
    // `omit`, explicitly. The endpoint neither needs nor wants a session, and
    // saying so here means a future default change cannot start attaching one.
    credentials: 'omit',
  }).catch(() => {});

  return () => {};
}

export function enhanceInvitation(root: Document = document): Cleanup {
  const skew = measureSkew(root);
  const cleanups = [
    startCountdown(root, skew),
    wireMusic(root),
    wireGallery(root),
    wireShare(root),
    wireRsvp(root),
    wireAutoScroll(root),
    wireReveal(root),
    reportView(root),
  ];
  // Marks the page as enhanced, which is what the end-to-end tests wait on
  // instead of sleeping.
  root.documentElement.setAttribute('data-enhanced', '');
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

// The script is loaded with `defer`, so the document is already parsed.
if (typeof document !== 'undefined') enhanceInvitation();
