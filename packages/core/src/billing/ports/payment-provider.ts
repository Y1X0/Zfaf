/**
 * Payment provider port (ADR-0008).
 *
 * Declared in M1 even though no gateway is integrated until Phase 2, so that
 * billing boundaries exist from the start and no provider-shaped assumption
 * leaks into the domain. Business logic never sees a provider name.
 */

export interface ProviderCapabilities {
  readonly oneTime: boolean;
  readonly subscriptions: boolean;
  readonly refunds: boolean;
  readonly partialRefunds: boolean;
  readonly currencies: readonly string[];
}

export interface CheckoutInput {
  /** Minor units. Read from the database, never from the client. */
  readonly amount: number;
  readonly currency: string;
  readonly description: string;
  readonly customerRef: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
}

export interface CheckoutSession {
  readonly sessionId: string;
  readonly redirectUrl: string;
  readonly expiresAt: Date;
}

/**
 * A provider event, normalised.
 *
 * Every adapter translates its provider's payload into this shape, which is why
 * no `if (provider === 'stripe')` ever appears above the adapter layer.
 */
export type VerifiedEvent =
  | {
      readonly kind: 'payment.succeeded';
      readonly providerPaymentId: string;
      readonly amount: number;
      readonly currency: string;
      readonly metadata: Readonly<Record<string, string>>;
      readonly occurredAt: Date;
    }
  | {
      readonly kind: 'payment.failed';
      readonly providerPaymentId: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: 'payment.refunded';
      readonly providerPaymentId: string;
      readonly amount: number;
    }
  | { readonly kind: 'unknown'; readonly rawType: string };

export type PaymentOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: 'PAYMENTS_NOT_ENABLED' | 'PROVIDER_ERROR';
      readonly message: string;
    };

export interface PaymentProvider {
  readonly key: string;
  readonly capabilities: ProviderCapabilities;
  createCheckout(input: CheckoutInput): Promise<PaymentOutcome<CheckoutSession>>;
  /** Returns null for an invalid signature — never throws on hostile input. */
  verifyWebhook(rawBody: string, signature: string): Promise<VerifiedEvent | null>;
  refund(providerPaymentId: string, amount?: number): Promise<PaymentOutcome<{ refundId: string }>>;
}
