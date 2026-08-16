import type { MailMessage, MailService } from '@zfaf/core';

/**
 * Mail services for development and tests.
 *
 * The real Resend adapter arrives with the HTTP layer; identity logic is
 * verified against these, which is what lets the reset and verification flows
 * be tested end to end without sending anything.
 */

/** Captures messages in memory so tests can assert on them. */
export class CapturingMailService implements MailService {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  lastTo(recipient: string): MailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === recipient);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Drops everything. For paths where mail is incidental to what is under test. */
export class NoopMailService implements MailService {
  async send(): Promise<void> {}
}
