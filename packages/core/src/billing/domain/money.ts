import { type Result, err, ok } from '@zfaf/shared';

/**
 * Money.
 *
 * Stored as an integer in the currency's minor unit, never a float: 0.1 + 0.2
 * is not 0.3 in binary floating point, and that error compounds across an
 * invoice. The currency travels with the amount so a value can never be
 * interpreted in the wrong one (ADR-0015).
 */

export type MoneyIssue = 'NOT_AN_INTEGER' | 'NEGATIVE' | 'INVALID_CURRENCY' | 'CURRENCY_MISMATCH';

export class Money {
  private constructor(
    /** Amount in minor units — halalas, cents, fils. */
    readonly amount: number,
    /** ISO 4217. */
    readonly currency: string,
    /** Decimal places for this currency. Not always 2 — KWD uses 3. */
    readonly minorUnits: number,
  ) {
    Object.freeze(this);
  }

  static create(amount: number, currency: string, minorUnits: number): Result<Money, MoneyIssue> {
    if (!Number.isInteger(amount)) return err('NOT_AN_INTEGER');
    if (amount < 0) return err('NEGATIVE');
    if (!/^[A-Z]{3}$/.test(currency)) return err('INVALID_CURRENCY');
    if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
      return err('INVALID_CURRENCY');
    }
    return ok(new Money(amount, currency, minorUnits));
  }

  static zero(currency: string, minorUnits: number): Money {
    return new Money(0, currency, minorUnits);
  }

  add(other: Money): Result<Money, MoneyIssue> {
    if (other.currency !== this.currency) return err('CURRENCY_MISMATCH');
    return ok(new Money(this.amount + other.amount, this.currency, this.minorUnits));
  }

  subtract(other: Money): Result<Money, MoneyIssue> {
    if (other.currency !== this.currency) return err('CURRENCY_MISMATCH');
    if (other.amount > this.amount) return err('NEGATIVE');
    return ok(new Money(this.amount - other.amount, this.currency, this.minorUnits));
  }

  /**
   * Formats for display.
   *
   * Delegates to `Intl` rather than concatenating strings so digits, grouping
   * and placement follow the locale instead of our assumptions.
   */
  format(locale: string): string {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: this.currency,
      minimumFractionDigits: this.minorUnits,
      maximumFractionDigits: this.minorUnits,
    }).format(this.amount / 10 ** this.minorUnits);
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }

  isZero(): boolean {
    return this.amount === 0;
  }
}
