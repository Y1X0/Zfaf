import { describe, expect, it } from 'vitest';

import type { MailMessage, MailTemplate } from '@zfaf/core';

import { renderMail } from './mail-templates.js';
import { ResendMailService } from './resend-mail-service.js';

/**
 * Transactional email (Go-Live gate 2).
 *
 * The assertions worth having here are about what an email must **not**
 * contain and must **not** do. That it renders is easy; that a guest's phone
 * number cannot reach an owner's inbox, and that a one-time link cannot reach
 * a provider's tag index, are the properties this system has spent ten
 * milestones protecting everywhere else.
 */

const BASE = 'https://zfaf.app';
const TEMPLATES: readonly MailTemplate[] = [
  'email_verification',
  'password_reset',
  'password_changed',
  'new_device_sign_in',
  'account_deletion_requested',
  'rsvp_received',
];

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    to: 'sarah@example.com',
    template: 'email_verification',
    locale: 'ar',
    data: { token: 'one-time-token-value' },
    ...overrides,
  };
}

describe('every template, in both languages', () => {
  for (const template of TEMPLATES) {
    for (const locale of ['ar', 'en'] as const) {
      it(`${template} in ${locale} renders a complete message`, () => {
        const rendered = renderMail(message({ template, locale }), BASE);

        expect(rendered.subject.length).toBeGreaterThan(0);
        expect(rendered.text.length).toBeGreaterThan(0);
        expect(rendered.html).toContain('<!doctype html>');
        // Direction and language are set per locale, exactly as ADR-0011 sets
        // them on the application.
        expect(rendered.html).toContain(`lang="${locale}"`);
        expect(rendered.html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`);
        // No untranslated fallback leaked through.
        if (locale === 'ar') expect(rendered.subject).toMatch(/[؀-ۿ]/);
      });
    }
  }

  it('gives Arabic the leading its diacritics need (ADR-0011 §4)', () => {
    expect(renderMail(message({ locale: 'ar' }), BASE).html).toContain('line-height:1.9');
  });
});

describe('what an email is allowed to carry', () => {
  it('never emails a guest’s phone number or note', () => {
    /**
     * M7 built the notification without them on purpose — an inbox is not
     * where guest contact details should accumulate. This asserts the template
     * cannot reintroduce them even if a caller passes them.
     */
    const rendered = renderMail(
      message({
        template: 'rsvp_received',
        data: {
          invitationTitle: 'أحمد وسارة',
          guestName: 'خالد',
          attending: 'yes',
          partySize: '2',
          phone: '+966501234567',
          note: 'نباتي من فضلك',
        },
      }),
      BASE,
    );

    const whole = `${rendered.subject}${rendered.html}${rendered.text}`;
    expect(whole).not.toContain('966501234567');
    expect(whole).not.toContain('نباتي');
    // What it does carry: enough for the owner to know somebody replied.
    expect(whole).toContain('خالد');
    expect(whole).toContain('2');
  });

  it('carries no image, web font or external asset', () => {
    // Nothing that leaks a read receipt, and nothing that breaks behind a
    // corporate proxy.
    for (const template of TEMPLATES) {
      const { html } = renderMail(message({ template }), BASE);
      expect(html).not.toMatch(/<img\b/i);
      expect(html).not.toMatch(/<script\b/i);
      expect(html).not.toMatch(/https?:\/\/(?!zfaf\.app)/);
    }
  });

  it('escapes anything that came from a person', () => {
    const rendered = renderMail(
      message({
        template: 'rsvp_received',
        data: {
          invitationTitle: '<script>alert(1)</script>',
          guestName: '"><b>x',
          attending: 'no',
        },
      }),
      BASE,
    );
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).not.toContain('"><b>x');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('builds its links from the configured origin, not a hard-coded one', () => {
    const rendered = renderMail(message(), 'https://staging.zfaf.app');
    expect(rendered.html).toContain('https://staging.zfaf.app/verify-email?token=');
    expect(rendered.html).not.toContain('https://zfaf.app/');
  });

  it('percent-encodes the token so a link cannot be broken by its own content', () => {
    const rendered = renderMail(message({ data: { token: 'a b&c=d' } }), BASE);
    expect(rendered.html).toContain('token=a%20b%26c%3Dd');
  });

  it('shows the link as text as well, for a client that strips buttons', () => {
    const rendered = renderMail(message(), BASE);
    expect(rendered.text).toContain(`${BASE}/verify-email?token=`);
  });
});

describe('sending', () => {
  function intercepting(status = 200) {
    const sent: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const service = new ResendMailService({
      apiKey: 're_secret_key',
      from: 'Zfaf <no-reply@zfaf.app>',
      publicBaseUrl: BASE,
      endpoint: 'https://api.test/emails',
    });

    // The adapter takes its `fetch` from the global; swap it for the call.
    const original = globalThis.fetch;
    const intercept: typeof globalThis.fetch = async (_input, init) => {
      sent.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: 'msg-1' }), { status });
    };
    globalThis.fetch = intercept;

    return { service, sent, restore: () => (globalThis.fetch = original) };
  }

  it('sends both an HTML and a plain-text part', async () => {
    const { service, sent, restore } = intercepting();
    try {
      await service.send(message());
    } finally {
      restore();
    }

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body['html']).toBeTruthy();
    expect(sent[0]!.body['text']).toBeTruthy();
    expect(sent[0]!.body['to']).toEqual(['sarah@example.com']);
  });

  it('tags by template only — never by recipient or token', async () => {
    /**
     * A provider's tag index is searchable by anyone with dashboard access,
     * which is a wider circle than the people who may read a customer's
     * address.
     */
    const { service, sent, restore } = intercepting();
    try {
      await service.send(message());
    } finally {
      restore();
    }

    const tags = JSON.stringify(sent[0]!.body['tags']);
    expect(tags).toContain('email_verification');
    expect(tags).not.toContain('sarah@example.com');
    expect(tags).not.toContain('one-time-token-value');
  });

  it('throws when delivery fails, rather than swallowing it', async () => {
    /**
     * The opposite of the CDN purger next door, deliberately. A failed purge
     * must not roll back a suspension; a failed verification email that is
     * swallowed leaves a person waiting at an inbox with no way to know.
     */
    const { service, restore } = intercepting(422);
    try {
      await expect(service.send(message())).rejects.toThrow(/422/);
    } finally {
      restore();
    }
  });
});
