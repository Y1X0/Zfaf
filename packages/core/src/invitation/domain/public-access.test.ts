import { describe, expect, it } from 'vitest';

import {
  PUBLIC_ACCESS_STATUS,
  UNAVAILABLE_RESPONSE_POLICY,
  publicInvitationUrl,
  publicResponsePolicy,
  resolvePublicAccess,
  shareText,
  whatsappShareUrl,
} from './public-access.js';

const now = new Date('2026-09-20T12:00:00.000Z');

describe('resolvePublicAccess', () => {
  it('serves a published invitation', () => {
    expect(resolvePublicAccess({ status: 'PUBLISHED', expiresAt: null, now })).toEqual({
      kind: 'VISIBLE',
    });
  });

  it('hides a draft, a paused and a deleted invitation identically', () => {
    // Indistinguishable on purpose: confirming that a slug exists but is
    // unpublished tells a stranger about an invitation that is none of their
    // business.
    for (const status of ['DRAFT', 'PAUSED', 'DELETED'] as const) {
      expect(resolvePublicAccess({ status, expiresAt: null, now }).kind).toBe('NOT_FOUND');
    }
  });

  it('reports an expired invitation as gone, not missing', () => {
    expect(resolvePublicAccess({ status: 'EXPIRED', expiresAt: null, now }).kind).toBe('GONE');
  });

  it('reports a suspended invitation as blocked', () => {
    expect(resolvePublicAccess({ status: 'SUSPENDED', expiresAt: null, now }).kind).toBe('BLOCKED');
  });

  it('stops serving at the expiry instant, without waiting for the sweep', () => {
    // The nightly job has not run yet, so the row still says PUBLISHED. If the
    // route trusted that, the expiry date would mean "some time tomorrow".
    const justExpired = {
      status: 'PUBLISHED' as const,
      expiresAt: new Date(now.getTime() - 1),
      now,
    };
    expect(resolvePublicAccess(justExpired).kind).toBe('GONE');
  });

  it('keeps serving right up to the expiry instant', () => {
    const notYet = { status: 'PUBLISHED' as const, expiresAt: new Date(now.getTime() + 1), now };
    expect(resolvePublicAccess(notYet).kind).toBe('VISIBLE');
  });

  it('reports moderation ahead of expiry', () => {
    // A suspended invitation that also expired is still a moderation outcome;
    // calling it merely "gone" would understate what happened.
    const both = { status: 'SUSPENDED' as const, expiresAt: new Date(now.getTime() - 1), now };
    expect(resolvePublicAccess(both).kind).toBe('BLOCKED');
  });

  it('maps every outcome to the status code that means it', () => {
    expect(PUBLIC_ACCESS_STATUS).toEqual({
      VISIBLE: 200,
      REDIRECT: 301,
      NOT_FOUND: 404,
      GONE: 410,
      BLOCKED: 451,
    });
  });
});

describe('publicResponsePolicy', () => {
  it('does not treat UNLISTED as private (ADR-0017)', () => {
    // The whole failure this ADR exists to prevent is the platform behaving as
    // though "unlisted" meant "secret". It is cached at the edge exactly like
    // an indexed invitation; only indexing differs.
    const unlisted = publicResponsePolicy('UNLISTED');
    const indexed = publicResponsePolicy('INDEXED');
    expect(unlisted.cacheControl).toBe(indexed.cacheControl);
    expect(unlisted.robots).toBe('noindex, nofollow');
    expect(unlisted.indexable).toBe(false);
  });

  it('lets an INDEXED invitation be indexed', () => {
    expect(publicResponsePolicy('INDEXED').robots).toBe('index, follow');
    expect(publicResponsePolicy('INDEXED').indexable).toBe(true);
  });

  it('refuses to cache a PROTECTED invitation anywhere shared', () => {
    // A shared cache holding a credential-gated page would serve it to the
    // next visitor without the credential.
    const policy = publicResponsePolicy('PROTECTED');
    expect(policy.cacheControl).toContain('private');
    expect(policy.cacheControl).toContain('no-store');
  });

  it('never caches or indexes something that is not visible', () => {
    expect(UNAVAILABLE_RESPONSE_POLICY.cacheControl).toBe('no-store');
    expect(UNAVAILABLE_RESPONSE_POLICY.robots).toBe('noindex, nofollow');
  });
});

describe('publicInvitationUrl', () => {
  it('builds the address printed on QR codes', () => {
    expect(publicInvitationUrl('https://zfaf.app', 'ahmad-sara')).toBe(
      'https://zfaf.app/i/ahmad-sara',
    );
  });

  it('does not double the slash when the base url has a trailing one', () => {
    expect(publicInvitationUrl('https://zfaf.app/', 'ahmad-sara')).toBe(
      'https://zfaf.app/i/ahmad-sara',
    );
  });
});

describe('shareText', () => {
  const input = {
    groomName: 'أحمد',
    brideName: 'سارة',
    url: 'https://zfaf.app/i/ahmad-sara',
    locale: 'ar' as const,
  };

  it('ends with the link', () => {
    // WhatsApp only renders a preview for a URL that ends the message, and a
    // share without its preview loses most of its effect.
    expect(shareText(input).endsWith(input.url)).toBe(true);
  });

  it('names both of them', () => {
    expect(shareText(input)).toContain('أحمد');
    expect(shareText(input)).toContain('سارة');
  });

  it('follows the invitation’s language, not the sharer’s', () => {
    expect(shareText({ ...input, locale: 'en' })).toContain('You are invited');
  });

  it('escapes the message into the WhatsApp link', () => {
    const url = whatsappShareUrl(shareText(input));
    expect(url.startsWith('https://wa.me/?text=')).toBe(true);
    expect(url).not.toContain(' ');
    expect(url).not.toContain('\n');
  });
});
