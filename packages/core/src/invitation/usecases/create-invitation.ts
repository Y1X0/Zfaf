import type { Actor } from '../../authz/actor.js';
import { tenantScopeFor } from '../../authz/tenant-scope.js';
import type { Entitlements } from '../../billing/domain/entitlements.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { TemplateCatalog } from '../../template/ports/template-catalog.js';
import type { TemplateManifest } from '../../template/domain/template-manifest.js';
import type { DraftDocument } from '../domain/draft-document.js';
import { parseDraftDocument } from '../domain/draft-document.js';
import type { InvitationRecord, InvitationRepository } from '../ports/invitation-repository.js';

/**
 * Starting a draft (docs/04 §invitations, docs/23 §7).
 *
 * The step the product was missing: everything downstream — the builder, the
 * autosave, the publish, the public page — assumed an invitation already
 * existed, and nothing created one. Tests seeded rows directly, so the gap was
 * invisible until somebody asked what a new customer does after signing up.
 *
 * What this owns is the decision, not the writing: who may create, whether the
 * plan allows another one, which template they may pin to, and what a document
 * looks like on the first day. The repository writes the row.
 */

export interface CreateInvitationRequest {
  readonly actor: Actor;
  readonly templateKey: string;
  readonly locale: 'ar' | 'en';
  readonly timezone: string;
  /** `YYYY-MM-DD`. The couple can change it later; it is not a commitment. */
  readonly eventDate: string;
  /** What the couple call this invitation in their own list. */
  readonly title: string;
  readonly marketCode: string;
}

export interface CreateInvitationDeps {
  readonly repository: InvitationRepository;
  readonly templates: TemplateCatalog;
  readonly entitlements: Entitlements;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export type CreateInvitationResult =
  | { readonly ok: true; readonly invitation: InvitationRecord }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** `YYYY-MM-DD`, and a date that exists. `2026-02-31` parses and is not a day. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * The document a template starts life as.
 *
 * Every field the schema requires, and nothing filled in that the couple has
 * not said. Empty names are the starting state rather than an error — the
 * builder's own completeness rules decide when an invitation is ready to
 * publish, and duplicating that judgement here would give it two homes.
 *
 * Exported because it is the interesting half: a manifest that cannot produce
 * a valid document is a manifest that would fail at the first autosave, and
 * that is worth asserting directly.
 */
export function startingDocument(
  manifest: TemplateManifest,
  input: { readonly locale: 'ar' | 'en'; readonly timezone: string },
): DraftDocument {
  const document = {
    schemaVersion: 1 as const,
    templateKey: manifest.key,
    templateVersion: manifest.version,
    locale: input.locale,
    timezone: input.timezone,
    // The template's own theme, copied rather than referenced: a customer who
    // changes a colour must not be editing the library.
    theme: manifest.theme,
    sections: manifest.sections.map((section) => ({
      id: section.id,
      type: section.type,
      variant: section.variant,
      enabled: section.enabled,
      order: section.order,
      props: section.props,
    })),
    content: {
      couple: { groomName: '', brideName: '', shortName: null, message: null, photo: null },
      wedding: { date: null, startTime: null, endTime: null, timezone: input.timezone },
      location: {
        venueName: null,
        address: null,
        latitude: null,
        longitude: null,
        mapsUrl: null,
      },
      events: [],
      cover: null,
      gallery: [],
      music: { trackId: null, url: null, title: null, attribution: null },
      /** On by default: an invitation nobody can answer is a poster. */
      rsvp: { enabled: true, deadline: null, maxPartySize: 5 },
    },
  };

  const parsed = parseDraftDocument(document);
  if (!parsed.ok) {
    // Unreachable through a valid manifest, and worth failing loudly rather
    // than persisting a document the autosave would reject on the first edit.
    throw new Error(`Template "${manifest.key}" cannot produce a valid draft document`);
  }
  return parsed.document;
}

export async function createInvitation(
  input: CreateInvitationRequest,
  deps: CreateInvitationDeps,
): Promise<CreateInvitationResult> {
  /**
   * A customer, specifically — not merely somebody with a scope.
   *
   * Platform staff do get a scope, and theirs is unconstrained by design
   * (`ownerId: null`, so a moderator can read across tenants). Letting it
   * through here would be wrong twice: the invitation would be owned by a staff
   * account, and the plan check below would compare **every tenant's**
   * invitation count against one customer's limit. Refused explicitly rather
   * than by hoping the scope shape says no.
   */
  const scope = tenantScopeFor(input.actor);
  if (!scope || input.actor.kind !== 'user' || scope.isPlatformStaff) {
    return { ok: false, code: 'FORBIDDEN', message: 'Only a signed-in customer may create one' };
  }

  const title = input.title.trim();
  if (title.length === 0 || title.length > 120) {
    return { ok: false, code: 'INVALID_TITLE', message: 'A title of 1–120 characters is required' };
  }
  if (!isCalendarDate(input.eventDate)) {
    return {
      ok: false,
      code: 'INVALID_EVENT_DATE',
      message: 'eventDate must be a real YYYY-MM-DD',
    };
  }

  /**
   * The plan limit, counted rather than trusted.
   *
   * `countActiveInScope` asks the database how many this customer actually
   * has; a counter kept anywhere else drifts, and the direction it drifts is
   * always in the customer's favour until somebody notices (ADR-0014).
   */
  const allowed = deps.entitlements.limit('invitation.active');
  const existing = await deps.repository.countActiveInScope(scope);
  if (existing >= allowed) {
    return {
      ok: false,
      code: 'PLAN_LIMIT_EXCEEDED',
      message: 'This plan does not allow another active invitation',
    };
  }

  const template = await deps.templates.findPublishedByKey(input.templateKey);
  if (!template) {
    return { ok: false, code: 'TEMPLATE_NOT_FOUND', message: 'No such published template' };
  }

  const { manifest } = template;
  if (manifest.meta.requiredPlanLevel > deps.entitlements.planLevel()) {
    // Compared by level, never branched on by plan name (ADR-0014).
    return { ok: false, code: 'TEMPLATE_LOCKED', message: 'This template needs a higher plan' };
  }
  if (!manifest.meta.supportedLocales.includes(input.locale)) {
    return {
      ok: false,
      code: 'LOCALE_NOT_SUPPORTED',
      message: 'This template does not support that language',
    };
  }

  const now = deps.clock.now();
  const invitation = await deps.repository.create({
    id: deps.ids.uuid(),
    ownerId: input.actor.userId,
    title,
    templateKey: manifest.key,
    templateVersion: manifest.version,
    templateVersionId: template.templateVersionId,
    locale: input.locale,
    marketCode: input.marketCode,
    timezone: input.timezone,
    eventDate: input.eventDate,
    draftDocument: startingDocument(manifest, {
      locale: input.locale,
      timezone: input.timezone,
    }),
    now,
  });

  return { ok: true, invitation };
}
