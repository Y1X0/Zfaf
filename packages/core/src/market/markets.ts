import { type MarketConfig, parseMarketConfig } from './market-config.js';

/**
 * The market registry.
 *
 * This file is the one place allowed to name a market's currency, calling code
 * or time zone; the `zfaf/no-market-literals` lint rule rejects those literals
 * everywhere else (ADR-0015).
 */

/** Saudi Arabia — the first market. */
export const SA: MarketConfig = parseMarketConfig({
  code: 'SA',
  displayName: { ar: 'السعودية', en: 'Saudi Arabia' },
  isActive: true,
  currency: {
    code: 'SAR',
    minorUnits: 2,
    symbol: { ar: 'ر.س', en: 'SAR' },
  },
  defaultLocale: 'ar',
  supportedLocales: ['ar', 'en'],
  defaultTimezone: 'Asia/Riyadh',
  phone: {
    countryCallingCode: '+966',
    nationalNumberLength: [9],
    exampleNumber: '512345678',
  },
  // No payments in the MVP, and no tax rule may be written before a specialist
  // has verified it (ADR-0008).
  tax: null,
  paymentProviderKey: 'null',
  numeralSystem: 'latin',
});

/**
 * A deliberately unlike-Saudi market used only by tests.
 *
 * Three-decimal currency and a southern-hemisphere time zone catch the two
 * assumptions that leak most easily: "divide by 100" and "everyone is near
 * UTC+3". Keeping it in the shipped registry (inactive) means the isolation
 * test exercises the same code path production uses.
 */
export const XX_TEST_MARKET: MarketConfig = parseMarketConfig({
  code: 'XX',
  displayName: { ar: 'سوق اختباري', en: 'Test Market' },
  isActive: false,
  currency: {
    code: 'XXX',
    minorUnits: 3,
    symbol: { ar: 'ت', en: 'XXX' },
  },
  defaultLocale: 'en',
  supportedLocales: ['ar', 'en'],
  defaultTimezone: 'Pacific/Auckland',
  phone: {
    countryCallingCode: '+64',
    nationalNumberLength: [8, 9],
    exampleNumber: '211234567',
  },
  tax: null,
  paymentProviderKey: 'null',
  numeralSystem: 'latin',
});

const REGISTRY: ReadonlyMap<string, MarketConfig> = new Map([
  [SA.code, SA],
  [XX_TEST_MARKET.code, XX_TEST_MARKET],
]);

export function getMarket(code: string): MarketConfig | undefined {
  return REGISTRY.get(code.toUpperCase());
}

export function requireMarket(code: string): MarketConfig {
  const market = getMarket(code);
  if (!market) throw new Error(`Unknown market "${code}"`);
  return market;
}

export function activeMarkets(): readonly MarketConfig[] {
  return [...REGISTRY.values()].filter((market) => market.isActive);
}
