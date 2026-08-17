import type { Logger, MailMessage, MailService } from '@zfaf/core';

import { renderMail } from './mail-templates.js';

/**
 * Transactional email through Resend (Go-Live gate 2).
 *
 * `MAIL_DRIVER` has listed `resend` since Phase 0 with nothing behind it; this
 * is that implementation. Written against the HTTP API rather than the SDK,
 * for the same reason the Sentry adapter is: one `fetch` against a documented,
 * stable endpoint is less to audit than a dependency, and there is nothing an
 * SDK would do for us here that we are not already doing.
 *
 * ## What it will and will not do when things go wrong
 *
 * **It throws.** That is the opposite of the CDN purger next door, and the
 * difference is deliberate. A failed purge must never roll back a suspension,
 * because the suspension is what protects people. A failed *verification*
 * email is different: if it is swallowed, a person waits at an inbox for a
 * message that will never arrive and has no way to know. The callers that can
 * tolerate a failure — the RSVP notification, which M7 built explicitly not to
 * fail a guest's reply — already catch it at their own boundary.
 *
 * ## What never leaves this process
 *
 * The link. `MailMessage.data` carries one-time tokens, and docs/15 §2 forbids
 * logging them; so the only thing logged here is the template name, the
 * outcome, and Resend's message id.
 */

export interface ResendConfig {
  readonly apiKey: string;
  /** `Name <address@domain>` — the domain must be the one with SPF/DKIM set up. */
  readonly from: string;
  /** Where links in the email point. Not the API's base; ours. */
  readonly publicBaseUrl: string;
  /** Overridable so a test can point at a local server instead of the internet. */
  readonly endpoint?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly logger?: Logger | undefined;
}

const DEFAULT_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 10_000;

export class ResendMailService implements MailService {
  constructor(private readonly config: ResendConfig) {}

  async send(message: MailMessage): Promise<void> {
    const rendered = renderMail(message, this.config.publicBaseUrl);

    const response = await fetch(this.config.endpoint ?? DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.config.from,
        to: [message.to],
        subject: rendered.subject,
        html: rendered.html,
        // Both parts, always: some clients show the plain one, some people
        // prefer it, and a screen reader handles it better than a table.
        text: rendered.text,
        /**
         * Categorised for the provider's dashboard, by **template name only**.
         *
         * Never the recipient and never the token. A provider's tag index is
         * searchable by anyone with dashboard access, which is a wider circle
         * than the people who may read a customer's address.
         */
        tags: [{ name: 'template', value: message.template }],
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      // The status, not the body: a provider error body echoes the request,
      // and the request contains a one-time link.
      this.config.logger?.error('mail.send_failed', {
        template: message.template,
        status: response.status,
      });
      throw new Error(`Resend responded ${response.status}`);
    }

    const body = (await response.json().catch(() => ({}))) as { id?: string };
    this.config.logger?.info('mail.sent', {
      template: message.template,
      // Resend's own id, which is what a support question about a missing
      // email is answered with.
      messageId: body.id ?? null,
    });
  }
}
