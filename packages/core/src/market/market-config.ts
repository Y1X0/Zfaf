import { z } from 'zod';

/**
 * Market configuration (ADR-0015).
 *
 * Saudi Arabia is the first market, not a baked-in assumption. Everything that
 * varies by market — currency, locale, time zone, phone format, tax, payment
 * provider — lives here as data, so adding Kuwait or the UAE later is a config
 * row rather than a change to the billing layer.
 */

export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

const IANA_TIMEZONE = /^[A-Za-z]+(?:\/[A-Za-z_+-]+){1,2}$/;

/**
 * Tax configuration.
 *
 * `verifiedBy` and `verifiedAt` are required and non-empty on purpose: no tax
 * rule may enter the system on our own assumptions (ADR-0008). The schema is
 * the enforcement — a rule without a documented review simply fails to parse.
 */
export const TaxConfigSchema = z
  .object({
    /** Basis points, never a float. 1500 = 15%. */
    rateBasisPoints: z.number().int().min(0).max(10_000),
    pricesIncludeTax: z.boolean(),
    registrationId: z.string().min(1).nullable(),
    /** Opaque requirement keys — never executable rules. */
    invoiceRequirements: z.array(z.string().min(1)).default([]),
    effectiveFrom: z.string().datetime(),
    verifiedBy: z.string().min(1, 'A tax rule requires the name of the specialist who verified it'),
    verifiedAt: z.string().datetime(),
  })
  .strict();

export type TaxConfig = z.infer<typeof TaxConfigSchema>;

export const MarketConfigSchema = z
  .object({
    /** ISO 3166-1 alpha-2. */
    code: z
      .string()
      .length(2)
      .regex(/^[A-Z]{2}$/),
    displayName: z.record(z.enum(LOCALES), z.string().min(1)),
    isActive: z.boolean(),

    currency: z
      .object({
        /** ISO 4217. */
        code: z
          .string()
          .length(3)
          .regex(/^[A-Z]{3}$/),
        /** Decimal places. Not every currency uses 2 — KWD uses 3. */
        minorUnits: z.number().int().min(0).max(4),
        symbol: z.record(z.enum(LOCALES), z.string().min(1)),
      })
      .strict(),

    defaultLocale: z.enum(LOCALES),
    supportedLocales: z.array(z.enum(LOCALES)).min(1),
    defaultTimezone: z.string().regex(IANA_TIMEZONE),

    phone: z
      .object({
        countryCallingCode: z.string().regex(/^\+\d{1,4}$/),
        nationalNumberLength: z.array(z.number().int().min(4).max(15)).min(1),
        exampleNumber: z.string().min(4),
      })
      .strict(),

    /** Null until a specialist has verified the rules for this market. */
    tax: TaxConfigSchema.nullable(),

    /** Resolved against the payment provider registry. 'null' = payments off. */
    paymentProviderKey: z.string().min(1),

    numeralSystem: z.enum(['latin', 'arabic-indic']),
  })
  .strict()
  .superRefine((market, ctx) => {
    if (!market.supportedLocales.includes(market.defaultLocale)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultLocale'],
        message: 'defaultLocale must be one of supportedLocales',
      });
    }
    for (const locale of market.supportedLocales) {
      if (!market.displayName[locale]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['displayName', locale],
          message: `displayName is missing the supported locale "${locale}"`,
        });
      }
      if (!market.currency.symbol[locale]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['currency', 'symbol', locale],
          message: `currency.symbol is missing the supported locale "${locale}"`,
        });
      }
    }
    // Sanity-check the time zone against the runtime's own tz database rather
    // than trusting the string shape.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: market.defaultTimezone });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultTimezone'],
        message: `Unknown IANA time zone "${market.defaultTimezone}"`,
      });
    }
  });

export type MarketConfig = z.infer<typeof MarketConfigSchema>;

export function parseMarketConfig(input: unknown): MarketConfig {
  return MarketConfigSchema.parse(input);
}
