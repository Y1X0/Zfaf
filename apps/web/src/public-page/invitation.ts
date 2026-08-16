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

export function enhanceInvitation(root: Document = document): Cleanup {
  const skew = measureSkew(root);
  const cleanups = [
    startCountdown(root, skew),
    wireMusic(root),
    wireGallery(root),
    wireShare(root),
    wireReveal(root),
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
