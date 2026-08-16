import { describe, expect, it } from 'vitest';

import { MarketConfigSchema, TaxConfigSchema, parseMarketConfig } from './market-config.js';
import { SA, XX_TEST_MARKET, activeMarkets, getMarket, requireMarket } from './markets.js';

describe('the market registry', () => {
  it('resolves Saudi Arabia, the first market', () => {
    expect(getMarket('SA')).toBe(SA);
    expect(getMarket('sa')).toBe(SA);
  });

  it('returns undefined for an unknown market rather than a default', () => {
    expect(getMarket('ZZ')).toBeUndefined();
    expect(() => requireMarket('ZZ')).toThrow(/Unknown market/);
  });

  it('lists only active markets', () => {
    const active = activeMarkets();
    expect(active).toContain(SA);
    expect(active).not.toContain(XX_TEST_MARKET);
  });
});

describe('no tax rule may exist without a documented review', () => {
  // ADR-0008: nothing about tax is written on our own assumptions. The schema
  // is the enforcement — a rule with no reviewer simply fails to parse.
  it('ships no tax configuration for the launch market', () => {
    expect(SA.tax).toBeNull();
  });

  it('rejects a tax rule with no verifier', () => {
    const result = TaxConfigSchema.safeParse({
      rateBasisPoints: 1500,
      pricesIncludeTax: true,
      registrationId: null,
      invoiceRequirements: [],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty verifier name', () => {
    const result = TaxConfigSchema.safeParse({
      rateBasisPoints: 1500,
      pricesIncludeTax: true,
      registrationId: null,
      invoiceRequirements: [],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      verifiedBy: '',
      verifiedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a rule that names its reviewer', () => {
    const result = TaxConfigSchema.safeParse({
      rateBasisPoints: 1500,
      pricesIncludeTax: true,
      registrationId: '300000000000003',
      invoiceRequirements: ['qr_code', 'seller_vat_number'],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      verifiedBy: 'Certified accountant, engagement ref 2026-01',
      verifiedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('expresses the rate in basis points, never a float', () => {
    const result = TaxConfigSchema.safeParse({
      rateBasisPoints: 0.15,
      pricesIncludeTax: true,
      registrationId: null,
      invoiceRequirements: [],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      verifiedBy: 'x',
      verifiedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('market configuration validation', () => {
  it('rejects a non-ISO market code', () => {
    expect(() => parseMarketConfig({ ...SA, code: 'SAU' })).toThrow();
    expect(() => parseMarketConfig({ ...SA, code: 'sa' })).toThrow();
  });

  it('rejects an unknown time zone rather than accepting the string', () => {
    expect(() => parseMarketConfig({ ...SA, defaultTimezone: 'Mars/Olympus' })).toThrow();
  });

  it('rejects a default locale outside the supported set', () => {
    const result = MarketConfigSchema.safeParse({
      ...SA,
      defaultLocale: 'en',
      supportedLocales: ['ar'],
    });
    expect(result.success).toBe(false);
  });

  it('requires a display name for every supported locale', () => {
    const result = MarketConfigSchema.safeParse({
      ...SA,
      displayName: { ar: 'السعودية' },
      supportedLocales: ['ar', 'en'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys instead of carrying them through', () => {
    expect(() => parseMarketConfig({ ...SA, surprise: true })).toThrow();
  });
});

describe('the test market catches assumptions the launch market would hide', () => {
  it('uses three decimal places, so "divide by 100" fails loudly', () => {
    expect(XX_TEST_MARKET.currency.minorUnits).toBe(3);
    expect(SA.currency.minorUnits).toBe(2);
  });

  it('sits in a southern-hemisphere zone, so DST runs the other way', () => {
    expect(XX_TEST_MARKET.defaultTimezone).not.toBe(SA.defaultTimezone);
  });

  it('defaults to a different locale than the launch market', () => {
    expect(XX_TEST_MARKET.defaultLocale).not.toBe(SA.defaultLocale);
  });

  it('is shipped inactive, so it cannot be selected in production', () => {
    expect(XX_TEST_MARKET.isActive).toBe(false);
  });
});
