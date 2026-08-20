/**
 * The base stylesheet.
 *
 * Authored here as a constant rather than assembled from a manifest, because a
 * manifest is untrusted data and must never be able to contribute CSS. What a
 * template controls is which classes appear and what the custom properties hold
 * — never the rules themselves.
 *
 * Every inline-axis rule uses logical properties, so RTL is correct by
 * construction rather than by a mirrored override sheet (ADR-0011). The
 * `zfaf/no-physical-css-properties` rule rejects the physical forms here.
 *
 * That rule has one blind spot, and `.zf-hero__arch` fell into it: a transform
 * is a *function*, not a property, so `inset-inline-start:50%` paired with
 * `transform:translateX(-50%)` passes the lint and still breaks. It looks like
 * centring, and is, in LTR — but in RTL the inset is measured from the right
 * while the translate still moves left, so the arch hung 276px off the page
 * and every Arabic invitation scrolled sideways on a phone. It is centred with
 * `inset-inline:0` and `margin-inline:auto` instead, which has no physical
 * axis to disagree with. Caught by the 390px end-to-end overflow check, which
 * is now the guard for this class of defect.
 */
export const BASE_STYLESHEET = `
.zf-invitation{background:var(--zf-color-bg);color:var(--zf-color-text);font-family:var(--zf-font-body);font-size:var(--zf-font-size-body);line-height:var(--zf-line-height);margin:0}
.zf-section{padding-block:var(--zf-space-section);padding-inline:clamp(1rem,5vw,3rem);position:relative}
.zf-section__inner{margin-inline:auto;max-width:56rem;text-align:center}
.zf-image{max-width:100%;height:auto;display:block}
.zf-divider{block-size:1px;inline-size:min(12rem,60%);margin-block:1.5rem;margin-inline:auto;background:var(--zf-color-accent)}
.zf-button{display:inline-block;padding-block:.75rem;padding-inline:1.75rem;border-radius:var(--zf-radius);background:var(--zf-color-primary);color:var(--zf-color-on-primary,var(--zf-color-bg));text-decoration:none;font-weight:600;min-block-size:44px}

/* Headings share one display treatment; templates differ through the variables. */
.zf-hero__names,.zf-couple__names{font-family:var(--zf-font-display);font-size:var(--zf-font-size-display);font-weight:var(--zf-font-display-weight);line-height:1.15;margin-block:0;letter-spacing:0}
.zf-hero__eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:.75rem;color:var(--zf-color-text-muted)}
.zf-hero__date{color:var(--zf-color-text-muted);margin-block-start:1rem}
.zf-hero--fullbleed{padding-block:0;min-block-size:80svh;display:grid;place-items:center}
.zf-hero__bleed{position:absolute;inset:0;inline-size:100%;block-size:100%;object-fit:cover}
.zf-hero__scrim{position:absolute;inset:0;background:var(--zf-color-overlay)}
.zf-hero__body--over{position:relative;color:var(--zf-color-bg)}
.zf-hero__arch{position:absolute;inset-block-start:0;inset-inline:0;margin-inline:auto;inline-size:min(22rem,80%);block-size:100%;border-start-start-radius:999px;border-start-end-radius:999px;border:1px solid var(--zf-color-accent);opacity:.35;pointer-events:none}
.zf-hero__seal{inline-size:5.5rem;block-size:5.5rem;margin-inline:auto;margin-block-end:1.5rem;border-radius:999px;background:var(--zf-color-primary);color:var(--zf-color-on-primary,var(--zf-color-bg));display:grid;place-items:center;font-family:var(--zf-font-display)}
.zf-hero--typographic .zf-hero__names{font-size:clamp(2rem,9vw,4rem)}

.zf-couple__amp{margin-inline:.5em;color:var(--zf-color-primary)}
.zf-couple__photo{border-radius:var(--zf-radius);margin-inline:auto;margin-block-end:1.5rem}
.zf-couple__message{color:var(--zf-color-text-muted);max-inline-size:38rem;margin-inline:auto}

.zf-countdown__units{display:flex;flex-wrap:wrap;justify-content:center;gap:clamp(.75rem,3vw,2rem);margin-block-start:1.5rem}
.zf-countdown__unit{min-inline-size:4.5rem}
.zf-countdown__value{display:block;font-family:var(--zf-font-display);font-size:clamp(1.75rem,6vw,3rem);color:var(--zf-color-primary)}
.zf-countdown__label{font-size:.8rem;color:var(--zf-color-text-muted)}
.zf-countdown--ornate .zf-countdown__unit{border:1px solid var(--zf-color-accent);border-radius:var(--zf-radius);padding:1rem}
.zf-countdown--rings .zf-countdown__unit{border:2px solid var(--zf-color-primary);border-radius:999px;padding:1.25rem;aspect-ratio:1}

.zf-events__list{list-style:none;padding-inline-start:0;margin-block:0;display:grid;gap:1.5rem}
.zf-events__item{padding-block:1rem}
.zf-events__title{font-family:var(--zf-font-display);margin-block:0 .35rem}
.zf-events__when{color:var(--zf-color-text-muted);margin-block:0}
.zf-events__map{display:inline-block;margin-block-start:.5rem;color:var(--zf-color-primary-text,var(--zf-color-primary))}
.zf-events--cards .zf-events__item{border:1px solid var(--zf-color-accent);border-radius:var(--zf-radius);padding:1.5rem}
.zf-events--timeline .zf-events__item{border-inline-start:2px solid var(--zf-color-accent);padding-inline-start:1.5rem;text-align:start}

.zf-location__card{border:1px solid var(--zf-color-accent);border-radius:var(--zf-radius);padding:2rem}
.zf-location__venue{font-family:var(--zf-font-display);font-size:1.5rem;margin-block:0 .5rem}
.zf-location__address{color:var(--zf-color-text-muted)}
.zf-location__button{margin-block-start:1rem}

.zf-gallery__grid{list-style:none;padding-inline-start:0;margin-block:0;display:grid;gap:.75rem;grid-template-columns:repeat(auto-fill,minmax(9rem,1fr))}
.zf-gallery__item{background:var(--zf-color-accent);border-radius:var(--zf-radius);overflow:hidden}
.zf-gallery__image{inline-size:100%;aspect-ratio:1;object-fit:cover;border-radius:var(--zf-radius);display:block}
.zf-gallery__image[data-failed]{display:none}
.zf-gallery--masonry .zf-gallery__image{aspect-ratio:auto}
.zf-gallery--carousel .zf-gallery__grid{grid-auto-flow:column;grid-auto-columns:min(70%,16rem);grid-template-columns:none;overflow-x:auto;scroll-snap-type:x mandatory}

.zf-rsvp__form{display:grid;gap:1rem;max-inline-size:28rem;margin-inline:auto;text-align:start}
.zf-rsvp__choice{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap}
.zf-rsvp__option{display:flex;align-items:center;gap:.5rem;min-block-size:44px}
.zf-field{display:grid;gap:.35rem}
.zf-field__label{font-size:.875rem;color:var(--zf-color-text-muted)}
.zf-field__input{padding:.75rem;border:1px solid var(--zf-color-accent);border-radius:var(--zf-radius);background:var(--zf-color-surface);color:var(--zf-color-text);font:inherit;min-block-size:44px}
.zf-rsvp__trap{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}

.zf-message__body{margin:0;font-family:var(--zf-font-display);font-size:clamp(1.25rem,4vw,1.75rem);line-height:1.7}
.zf-message__attribution{font-family:var(--zf-font-body);font-size:.9rem;color:var(--zf-color-text-muted);margin-block-start:1rem}
.zf-message--letter .zf-message__body{background:var(--zf-color-surface);padding:2rem;border-radius:var(--zf-radius);text-align:start}

.zf-story__paragraph{color:var(--zf-color-text-muted);max-inline-size:38rem;margin-inline:auto;text-align:start}

.zf-music__toggle{background:none;border:1px solid var(--zf-color-primary);color:var(--zf-color-primary-text,var(--zf-color-primary));border-radius:999px;padding-block:.6rem;padding-inline:1.4rem;min-block-size:44px;font:inherit;cursor:pointer}
.zf-music--floating .zf-music__player{position:sticky;inset-block-end:1rem}
.zf-music__attribution{font-size:.75rem;color:var(--zf-color-text-muted);margin-block-start:.75rem}

.zf-footer__names{font-family:var(--zf-font-display);font-size:1.5rem}
.zf-footer__closing{color:var(--zf-color-text-muted)}
.zf-footer__branding{font-size:.75rem;color:var(--zf-color-text-muted);margin-block-start:2rem}

/* Motion is opt-in per theme and always yields to the user's own setting. */
@media (prefers-reduced-motion:no-preference){
.zf-section{animation:zf-fade var(--zf-motion-duration) var(--zf-motion-ease) both}
@keyframes zf-fade{from{opacity:0;transform:translate3d(0,1rem,0)}to{opacity:1;transform:none}}
}
`.replace(/\n/g, '');
