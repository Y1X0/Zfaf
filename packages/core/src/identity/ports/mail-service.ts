/**
 * Outbound mail port.
 *
 * The domain describes the message it wants sent; rendering and delivery belong
 * to infrastructure. Templates are named rather than composed here so that
 * translations and layout never leak into use cases.
 */

export type MailTemplate =
  | 'email_verification'
  | 'password_reset'
  | 'password_changed'
  | 'new_device_sign_in'
  | 'account_deletion_requested';

export interface MailMessage {
  readonly to: string;
  readonly template: MailTemplate;
  readonly locale: string;
  /**
   * Substitutions. May contain a one-time link, so this value must never be
   * logged (docs/15-observability-and-dr.md §2).
   */
  readonly data: Readonly<Record<string, string>>;
}

export interface MailService {
  send(message: MailMessage): Promise<void>;
}
