import type {
  CheckoutInput,
  PaymentOutcome,
  PaymentProvider,
  CheckoutSession,
} from '../ports/payment-provider.js';

/**
 * The MVP payment provider: none.
 *
 * Its purpose is to prove the abstraction holds. Wiring a real gateway in
 * Phase 2 means adding an adapter, not reshaping the code around it — and until
 * then every payment path fails loudly rather than silently succeeding.
 */
export class NullPaymentProvider implements PaymentProvider {
  readonly key = 'null';

  readonly capabilities = {
    oneTime: false,
    subscriptions: false,
    refunds: false,
    partialRefunds: false,
    currencies: [] as readonly string[],
  };

  async createCheckout(_input: CheckoutInput): Promise<PaymentOutcome<CheckoutSession>> {
    return {
      ok: false,
      code: 'PAYMENTS_NOT_ENABLED',
      message: 'Payments are not enabled in this phase (ADR-0008).',
    };
  }

  async verifyWebhook(_rawBody: string, _signature: string): Promise<null> {
    return null;
  }

  async refund(_providerPaymentId: string): Promise<PaymentOutcome<{ refundId: string }>> {
    return {
      ok: false,
      code: 'PAYMENTS_NOT_ENABLED',
      message: 'Payments are not enabled in this phase (ADR-0008).',
    };
  }
}
