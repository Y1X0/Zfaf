import type { SectionType } from '@zfaf/core';

import type { SectionVariantDefinition } from './types.js';

/**
 * The section registry (ADR-0004).
 *
 * The registry is where visual capability lives, and it is the only part of the
 * system that is code rather than data. A manifest names variants; it can never
 * introduce one.
 *
 * Two consequences follow, and they are the point of the design:
 *   • A manifest naming an unknown variant is rejected, not executed.
 *   • Adding a variant makes it available to *every* template at once, rather
 *     than cloning behaviour per template.
 */

// The registry is deliberately heterogeneous — each variant has its own props
// type — so entries are stored with the props type erased and re-narrowed at
// the single point where a component is invoked.
type StoredDefinition = SectionVariantDefinition<Record<string, unknown>>;

export class SectionRegistry {
  private readonly variants = new Map<string, StoredDefinition>();

  /**
   * Registers a variant.
   *
   * Rejects a duplicate id rather than overwriting: silently replacing a
   * variant would change how already published invitations render.
   */
  register<P extends Record<string, unknown>>(definition: SectionVariantDefinition<P>): this {
    if (this.variants.has(definition.id)) {
      throw new Error(`Section variant "${definition.id}" is already registered`);
    }
    if (!definition.id.startsWith(`${definition.type}.`)) {
      throw new Error(
        `Variant id "${definition.id}" must be namespaced under its section type "${definition.type}"`,
      );
    }
    this.variants.set(definition.id, definition as unknown as StoredDefinition);
    return this;
  }

  get(variantId: string): StoredDefinition | undefined {
    return this.variants.get(variantId);
  }

  has(variantId: string): boolean {
    return this.variants.has(variantId);
  }

  /** Every registered variant id, sorted — used by the manifest validator. */
  ids(): readonly string[] {
    return [...this.variants.keys()].sort();
  }

  idsForType(type: SectionType): readonly string[] {
    return this.ids().filter((id) => id.startsWith(`${type}.`));
  }

  /** A variant to fall back to when a manifest names one that no longer exists. */
  fallbackForType(type: SectionType): StoredDefinition | undefined {
    const [first] = this.idsForType(type);
    return first ? this.variants.get(first) : undefined;
  }

  size(): number {
    return this.variants.size;
  }
}
