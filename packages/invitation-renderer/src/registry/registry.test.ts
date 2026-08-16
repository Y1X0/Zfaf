import { describe, expect, it } from 'vitest';

import { SECTION_TYPES, type SectionType } from '@zfaf/core';

import { buildDefaultRegistry, defaultRegistry } from './default-registry.js';
import { SectionRegistry } from './registry.js';
import { defineProps } from './schema.js';
import type { SectionVariantDefinition } from './types.js';

/**
 * The section registry.
 *
 * The registry is the boundary between capability (code, ours) and composition
 * (data, possibly a third party's). Everything here is a property of that
 * boundary rather than of any one section.
 */

function stub(id: string, type: SectionType): SectionVariantDefinition<Record<string, unknown>> {
  return {
    id,
    type,
    propsSchema: defineProps({}),
    Component: () => null,
    editor: [],
    capabilities: {},
    a11y: {},
  } as unknown as SectionVariantDefinition<Record<string, unknown>>;
}

describe('registration', () => {
  it('registers a well-formed variant', () => {
    const registry = new SectionRegistry();
    registry.register(stub('hero.plain', 'hero'));
    expect(registry.has('hero.plain')).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it('rejects a duplicate id instead of overwriting it', () => {
    // Overwriting would silently change how already published invitations
    // render — the one thing a published snapshot promises cannot happen.
    const registry = new SectionRegistry();
    registry.register(stub('hero.plain', 'hero'));
    expect(() => registry.register(stub('hero.plain', 'hero'))).toThrow(/already registered/);
  });

  it('rejects an id that is not namespaced under its section type', () => {
    const registry = new SectionRegistry();
    expect(() => registry.register(stub('plain', 'hero'))).toThrow(/namespaced/);
    expect(() => registry.register(stub('couple.plain', 'hero'))).toThrow(/namespaced/);
  });

  it('is chainable so a section family registers in one expression', () => {
    const registry = new SectionRegistry();
    expect(registry.register(stub('hero.a', 'hero')).register(stub('hero.b', 'hero'))).toBe(
      registry,
    );
  });
});

describe('lookup', () => {
  it('returns undefined for an unknown id rather than throwing', () => {
    // The renderer relies on this: an unknown variant is a diagnostic, not a
    // crash in front of guests.
    expect(defaultRegistry.get('hero.doesNotExist')).toBeUndefined();
    expect(defaultRegistry.has('hero.doesNotExist')).toBe(false);
  });

  it('lists ids in a stable sorted order', () => {
    const ids = defaultRegistry.ids();
    expect([...ids].sort()).toEqual([...ids]);
    // Stability matters because the validator prints this list in its errors.
    expect(buildDefaultRegistry().ids()).toEqual(ids);
  });

  it('filters ids by section type without matching a prefix by accident', () => {
    for (const id of defaultRegistry.idsForType('hero')) {
      expect(id.startsWith('hero.')).toBe(true);
    }
    // `couple` must not be reachable from a `count…` prefix search or similar.
    const countdown = defaultRegistry.idsForType('countdown');
    expect(countdown.every((id) => id.startsWith('countdown.'))).toBe(true);
    expect(countdown).not.toContain('couple.stacked');
  });

  it('offers a fallback for every section type it knows', () => {
    for (const type of SECTION_TYPES) {
      const fallback = defaultRegistry.fallbackForType(type);
      expect(fallback, `no fallback for "${type}"`).toBeDefined();
      expect(fallback?.type).toBe(type);
    }
  });

  it('offers no fallback for a type it has no variants for', () => {
    expect(new SectionRegistry().fallbackForType('hero')).toBeUndefined();
  });
});

describe('the shipped registry', () => {
  it('covers every section type the domain defines', () => {
    // If this fails, a manifest could legitimately name a type we cannot
    // render — the gap that fallbacks exist to survive, not to excuse.
    for (const type of SECTION_TYPES) {
      expect(defaultRegistry.idsForType(type).length, `type "${type}"`).toBeGreaterThan(0);
    }
  });

  it('exposes 27 variants across 11 types', () => {
    expect(defaultRegistry.size()).toBe(27);
    expect(new Set(defaultRegistry.ids().map((id) => id.split('.')[0])).size).toBe(
      SECTION_TYPES.length,
    );
  });

  it('gives every variant a props schema whose defaults parse', () => {
    // A default that its own schema rejects would make a malformed section
    // unrenderable, defeating the degrade-to-defaults path in the renderer.
    for (const id of defaultRegistry.ids()) {
      const definition = defaultRegistry.get(id);
      const parsed = definition?.propsSchema.parse(definition.propsSchema.defaults);
      expect(parsed?.ok, `defaults rejected for "${id}"`).toBe(true);
    }
  });

  it('declares no editor field that does not correspond to a prop', () => {
    // A control that edits nothing is a dead control in the builder (M5).
    // The converse is *not* asserted per variant: variants within a type share
    // one props schema, and a variant deliberately omits the fields it ignores
    // — `hero.centeredArch` has no scrim, so it does not offer `overlay`.
    for (const id of defaultRegistry.ids()) {
      const definition = defaultRegistry.get(id);
      if (!definition) continue;
      const propKeys = new Set(Object.keys(definition.propsSchema.defaults));
      for (const field of definition.editor) {
        expect(propKeys.has(field.key), `editor field "${field.key}" on "${id}"`).toBe(true);
      }
    }
  });

  it('exposes every prop through at least one variant of its type', () => {
    // The converse, stated where it is actually true: a prop no variant offers
    // is a capability nobody can reach.
    for (const type of SECTION_TYPES) {
      const ids = defaultRegistry.idsForType(type);
      const declared = new Set<string>();
      const offered = new Set<string>();

      for (const id of ids) {
        const definition = defaultRegistry.get(id);
        if (!definition) continue;
        for (const key of Object.keys(definition.propsSchema.defaults)) declared.add(key);
        for (const field of definition.editor) offered.add(field.key);
      }

      for (const key of declared) {
        expect(offered.has(key), `prop "${key}" of type "${type}" has no editor field`).toBe(true);
      }
    }
  });

  it('builds a fresh, independent registry each time', () => {
    // Shared mutable state between builds would make one test's registration
    // visible to another — and, in production, one request's to the next.
    const first = buildDefaultRegistry();
    expect(() => first.register(stub('hero.extra', 'hero'))).not.toThrow();
    expect(buildDefaultRegistry().has('hero.extra')).toBe(false);
    expect(defaultRegistry.has('hero.extra')).toBe(false);
  });
});
