import { describe, expect, it } from 'vitest';

import { displayLocaleTag, formatEventDate } from './shared.js';

/**
 * The calendar a date is displayed in (docs/23 §9-ب).
 *
 * ## The defect
 *
 * The tag was `ar-SA-u-nu-latn`, which pins the numbering system and says
 * nothing about the calendar. `ar-SA` carries `islamic-umalqura` as its CLDR
 * default, and runtimes disagree about whether to apply it: **Node resolves
 * `ar-SA` to `gregory`; Chromium resolves the same tag to
 * `islamic-umalqura`.**
 *
 * So one wedding date, from one document, rendered as two different strings —
 * `18 أغسطس 2027` from the server and `16 ربيع الأول 1449 هـ` in the browser.
 * It showed up as a React hydration mismatch on the builder preview, but the
 * warning was the smallest part of it: the preview a couple approves would not
 * be the page their guests open, two guests on different browsers could read
 * different dates off the same invitation, and a runtime upgrade could
 * restyle every date already in circulation without a deploy.
 *
 * ## Why these assertions and not a rendered string
 *
 * Asserting the formatted output would pass on this runtime **before and
 * after** the fix, because Node already chose Gregorian — the very reason the
 * divergence was invisible here. So the assertion is that the tag *names* the
 * calendar, which is true or false independently of whichever ICU build runs
 * the test.
 *
 * The counterpart runs where the bug actually appeared: `builder.spec.ts`
 * fails on a hydration error in Chromium.
 */
describe('the display locale tag', () => {
  it('names the calendar explicitly in every language', () => {
    expect(displayLocaleTag('ar', 'latin')).toContain('ca-gregory');
    expect(displayLocaleTag('ar', 'arabic-indic')).toContain('ca-gregory');
    expect(displayLocaleTag('en', 'latin')).toContain('ca-gregory');
  });

  it('resolves to the Gregorian calendar, whatever the runtime prefers', () => {
    for (const tag of [
      displayLocaleTag('ar', 'latin'),
      displayLocaleTag('ar', 'arabic-indic'),
      displayLocaleTag('en', 'latin'),
    ]) {
      expect(new Intl.DateTimeFormat(tag).resolvedOptions().calendar, tag).toBe('gregory');
    }
  });

  it('still honours the theme numbering system, which is a real choice', () => {
    // Latin and Arabic-Indic digits are a design decision (`theme.numerals`).
    // Pinning the calendar must not have flattened that too.
    expect(
      new Intl.DateTimeFormat(displayLocaleTag('ar', 'latin')).resolvedOptions().numberingSystem,
    ).toBe('latn');
    expect(
      new Intl.DateTimeFormat(displayLocaleTag('ar', 'arabic-indic')).resolvedOptions()
        .numberingSystem,
    ).toBe('arab');
  });
});

describe('the formatted wedding date', () => {
  it('shows the Gregorian year the couple actually typed', () => {
    // `content.wedding.date` is `YYYY-MM-DD`, collected by a Gregorian date
    // picker; the displayed year must be that year and not a converted one.
    const formatted = formatEventDate('2027-08-18', 'Asia/Riyadh', 'ar', 'latin');
    expect(formatted).toContain('2027');
    // The Hijri era marker would mean a calendar conversion crept back in.
    expect(formatted).not.toContain('هـ');
  });

  it('formats in the invitation’s zone, not the reader’s', () => {
    // Late on the 20th in Riyadh is still the 20th — a date-only value must
    // not slide a day because the server sits in another zone.
    expect(formatEventDate('2026-09-20', 'Asia/Riyadh', 'en', 'latin')).toContain('20');
  });
});
