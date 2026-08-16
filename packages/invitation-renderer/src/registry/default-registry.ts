import { SectionRegistry } from './registry.js';
import { heroVariants } from '../sections/hero/variants.js';
import { coupleVariants } from '../sections/couple/variants.js';
import { countdownVariants } from '../sections/countdown/variants.js';
import { eventsVariants } from '../sections/events/variants.js';
import { locationVariants } from '../sections/location/variants.js';
import { galleryVariants } from '../sections/gallery/variants.js';
import { storyVariants } from '../sections/story/variants.js';
import { rsvpVariants } from '../sections/rsvp/variants.js';
import { messageVariants } from '../sections/message/variants.js';
import { musicVariants } from '../sections/music/variants.js';
import { footerVariants } from '../sections/footer/variants.js';

/**
 * The shipped registry.
 *
 * This list is the complete visual vocabulary available to templates. A
 * manifest composes from it; it can never extend it — which is what makes a
 * manifest safe to accept from outside (ADR-0004).
 *
 * Adding a variant here makes it available to *every* template at once. That is
 * the distinction the architecture rests on: a variant is a general capability,
 * not a copy made for one template.
 */
export function buildDefaultRegistry(): SectionRegistry {
  const registry = new SectionRegistry();

  for (const variant of [
    ...heroVariants,
    ...coupleVariants,
    ...countdownVariants,
    ...eventsVariants,
    ...locationVariants,
    ...galleryVariants,
    ...storyVariants,
    ...rsvpVariants,
    ...messageVariants,
    ...musicVariants,
    ...footerVariants,
  ]) {
    registry.register(variant as never);
  }

  return registry;
}

export const defaultRegistry = buildDefaultRegistry();
