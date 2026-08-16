import type { PropsSchema } from './types.js';

/**
 * A tiny props-schema helper.
 *
 * Variant props are simple by design — a handful of booleans, enums and short
 * strings — so a small validator keeps the registry readable and avoids pulling
 * a schema library into the render path.
 *
 * The important property is that it **never throws and never trusts input**: a
 * manifest is untrusted data, and a malformed prop must degrade to the default
 * rather than take an invitation down in front of guests.
 */

export type FieldSpec =
  | { readonly kind: 'boolean'; readonly default: boolean }
  | {
      readonly kind: 'number';
      readonly default: number;
      readonly min: number;
      readonly max: number;
    }
  | { readonly kind: 'text'; readonly default: string; readonly maxLength: number }
  | { readonly kind: 'enum'; readonly default: string; readonly values: readonly string[] };

export type FieldSpecs = Readonly<Record<string, FieldSpec>>;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Builds a schema from a field description.
 *
 * Unknown keys are dropped rather than passed through: a section receives only
 * what its variant declared, so a manifest cannot smuggle extra data into a
 * component.
 */
export function defineProps<P extends Record<string, unknown>>(specs: FieldSpecs): PropsSchema<P> {
  const defaults = Object.fromEntries(
    Object.entries(specs).map(([key, spec]) => [key, spec.default]),
  ) as P;

  return {
    defaults,
    parse(input: unknown) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        // Absent or wrong-shaped props are not an error: the defaults are a
        // complete, renderable configuration.
        return { ok: true, value: { ...defaults } };
      }

      const source = input as Record<string, unknown>;
      const issues: string[] = [];

      for (const key of Object.getOwnPropertyNames(source)) {
        if (FORBIDDEN_KEYS.has(key)) {
          return { ok: false, issues: [`Prop "${key}" is not permitted`] };
        }
      }

      const value: Record<string, unknown> = { ...defaults };

      for (const [key, spec] of Object.entries(specs)) {
        if (!Object.hasOwn(source, key)) continue;
        const raw = source[key];

        switch (spec.kind) {
          case 'boolean':
            if (typeof raw === 'boolean') value[key] = raw;
            else issues.push(`"${key}" must be a boolean`);
            break;

          case 'number':
            if (
              typeof raw === 'number' &&
              Number.isFinite(raw) &&
              raw >= spec.min &&
              raw <= spec.max
            ) {
              value[key] = raw;
            } else {
              issues.push(`"${key}" must be a number between ${spec.min} and ${spec.max}`);
            }
            break;

          case 'text':
            if (typeof raw === 'string' && raw.length <= spec.maxLength) value[key] = raw;
            else issues.push(`"${key}" must be text of at most ${spec.maxLength} characters`);
            break;

          case 'enum':
            if (typeof raw === 'string' && spec.values.includes(raw)) value[key] = raw;
            else issues.push(`"${key}" must be one of: ${spec.values.join(', ')}`);
            break;
        }
      }

      if (issues.length > 0) return { ok: false, issues };
      return { ok: true, value: value as P };
    },
  };
}
