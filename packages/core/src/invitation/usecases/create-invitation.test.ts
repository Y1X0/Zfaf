import { describe, expect, it } from 'vitest';

import type { Actor } from '../../authz/actor.js';
import { FREE_BETA_PLAN, resolveEntitlements } from '../../billing/domain/entitlements.js';
import { parseManifest } from '../../template/domain/template-manifest.js';
import type { TemplateManifest } from '../../template/domain/template-manifest.js';
import type { PublishedTemplate, TemplateCatalog } from '../../template/ports/template-catalog.js';
import type {
  CreateInvitationInput,
  InvitationRecord,
  InvitationRepository,
} from '../ports/invitation-repository.js';
import { createInvitation, startingDocument } from './create-invitation.js';

/**
 * Creating the first invitation (docs/23 §7).
 *
 * The rules worth testing here are the refusals. Creating one is easy; not
 * creating one for a visitor, not creating a sixth when the plan allows five,
 * and not pinning to a template the customer has not paid for are the parts a
 * route must never be trusted to remember on its own.
 */

const NOW = new Date('2026-08-17T09:00:00.000Z');

const OWNER: Actor = { kind: 'user', userId: 'user-1', role: 'customer', memberships: [] };
const ANONYMOUS: Actor = { kind: 'anonymous' };

function manifest(overrides: Record<string, unknown> = {}): TemplateManifest {
  const parsed = parseManifest({
    schemaVersion: 1,
    key: 'classic-luxury',
    version: 1,
    meta: {
      name: { ar: 'كلاسيكي', en: 'Classic' },
      description: { ar: '', en: '' },
      category: 'classic',
      author: 'Zfaf',
      previewImage: 'preview-classic-luxury',
      requiredPlanLevel: 0,
      supportedLocales: ['ar', 'en'],
      ...(overrides['meta'] as object | undefined),
    },
    theme: {
      colors: {
        primary: '#8a6d24',
        secondary: '#2f2a24',
        accent: '#d9c89a',
        background: '#fffdf8',
        surface: '#f7f2e7',
        textPrimary: '#241f1a',
        textSecondary: '#5c5348',
        overlay: 'rgba(36, 31, 26, 0.35)',
      },
      typography: {
        displayFont: 'aref-ruqaa',
        bodyFont: 'ibm-plex-arabic',
        scale: 'normal',
        displayWeight: 400,
      },
      spacing: 'normal',
      radius: 'soft',
      buttons: 'solid',
      dividers: 'ornament',
      background: { kind: 'solid', value: 'ivory', overlayOpacity: 0 },
      motion: { intensity: 'subtle', effects: [] },
      numerals: 'latin',
    },
    customizable: {
      colors: ['primary'],
      fonts: false,
      spacing: false,
      motion: false,
      sectionOrder: true,
    },
    sections: [
      {
        id: 'hero',
        type: 'hero',
        variant: 'hero.centeredArch',
        enabled: true,
        order: 0,
        props: {},
      },
      {
        id: 'footer',
        type: 'footer',
        variant: 'footer.ornament',
        enabled: true,
        order: 1,
        props: {},
      },
    ],
    assets: { ornaments: [], patterns: [], fontSubsets: [] },
  });
  if (!parsed.ok) throw new Error(`fixture manifest is invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.manifest;
}

function catalogOf(template: PublishedTemplate | null): TemplateCatalog {
  return {
    listPublished: async () => (template ? [template] : []),
    findPublishedByKey: async (key) =>
      template && template.manifest.key === key ? template : null,
  };
}

function harness(options: { activeCount?: number; template?: PublishedTemplate | null } = {}) {
  const created: CreateInvitationInput[] = [];
  const repository = {
    countActiveInScope: async () => options.activeCount ?? 0,
    create: async (input: CreateInvitationInput) => {
      created.push(input);
      return { id: input.id, title: input.title } as unknown as InvitationRecord;
    },
  } as unknown as InvitationRepository;

  return {
    created,
    deps: {
      repository,
      templates: catalogOf(
        options.template === undefined
          ? { templateVersionId: 'tv-1', manifest: manifest() }
          : options.template,
      ),
      entitlements: resolveEntitlements(FREE_BETA_PLAN, [], NOW),
      ids: { uuid: () => 'invitation-1' },
      clock: { now: () => NOW },
    },
  };
}

const request = {
  actor: OWNER,
  templateKey: 'classic-luxury',
  locale: 'ar' as const,
  timezone: 'Asia/Riyadh',
  eventDate: '2026-12-01',
  title: 'أحمد وسارة',
  marketCode: 'SA',
};

describe('creating a draft', () => {
  it('creates one, pinned to the template version', async () => {
    const { deps, created } = harness();
    const result = await createInvitation(request, deps);

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.templateVersionId).toBe('tv-1');
    expect(created[0]!.ownerId).toBe('user-1');
    // The couple's own name for it, trimmed but not rewritten.
    expect(created[0]!.title).toBe('أحمد وسارة');
  });

  it('starts from a document the schema accepts', async () => {
    const document = startingDocument(manifest(), { locale: 'ar', timezone: 'Asia/Riyadh' });

    expect(document.templateKey).toBe('classic-luxury');
    expect(document.sections.map((section) => section.id)).toEqual(['hero', 'footer']);
    // Empty is the starting state; the builder decides when it is publishable.
    expect(document.content.couple.groomName).toBe('');
    expect(document.content.rsvp.enabled).toBe(true);
    expect(document.content.wedding.timezone).toBe('Asia/Riyadh');
  });

  it('copies the theme rather than referencing the library', async () => {
    const source = manifest();
    const document = startingDocument(source, { locale: 'ar', timezone: 'UTC' });
    expect(document.theme.colors.primary).toBe(source.theme.colors.primary);
  });
});

describe('who may not', () => {
  it('refuses a visitor', async () => {
    const { deps, created } = harness();
    const result = await createInvitation({ ...request, actor: ANONYMOUS }, deps);

    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(created).toHaveLength(0);
  });

  it('refuses platform staff, who own no tenant', async () => {
    const staff: Actor = { kind: 'user', userId: 'staff-1', role: 'admin', memberships: [] };
    const { deps, created } = harness();
    const result = await createInvitation({ ...request, actor: staff }, deps);

    // An invitation created by staff would belong to a tenant nobody can name.
    expect(result.ok).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('refuses once the plan limit is reached, counting what exists', async () => {
    const limit = resolveEntitlements(FREE_BETA_PLAN, [], NOW).limit('invitation.active');
    const { deps, created } = harness({ activeCount: limit });
    const result = await createInvitation(request, deps);

    expect(result).toMatchObject({ ok: false, code: 'PLAN_LIMIT_EXCEEDED' });
    expect(created).toHaveLength(0);
  });

  it('refuses a template that is not published', async () => {
    const { deps } = harness({ template: null });
    expect(await createInvitation(request, deps)).toMatchObject({
      ok: false,
      code: 'TEMPLATE_NOT_FOUND',
    });
  });

  it('refuses a template above the plan level', async () => {
    const premium = {
      templateVersionId: 'tv-2',
      manifest: manifest({ meta: { requiredPlanLevel: 5 } }),
    };
    const { deps } = harness({ template: premium });
    expect(await createInvitation(request, deps)).toMatchObject({
      ok: false,
      code: 'TEMPLATE_LOCKED',
    });
  });

  it('refuses a language the template does not support', async () => {
    const arabicOnly = {
      templateVersionId: 'tv-3',
      manifest: manifest({ meta: { supportedLocales: ['ar'] } }),
    };
    const { deps } = harness({ template: arabicOnly });
    expect(await createInvitation({ ...request, locale: 'en' }, deps)).toMatchObject({
      ok: false,
      code: 'LOCALE_NOT_SUPPORTED',
    });
  });
});

describe('what it will not accept', () => {
  it.each([
    ['', 'INVALID_TITLE'],
    ['   ', 'INVALID_TITLE'],
    ['x'.repeat(121), 'INVALID_TITLE'],
  ])('refuses the title %j', async (title, code) => {
    const { deps } = harness();
    expect(await createInvitation({ ...request, title }, deps)).toMatchObject({ ok: false, code });
  });

  it.each(['2026-13-01', '2026-02-31', '01-12-2026', 'tomorrow', ''])(
    'refuses the event date %j',
    async (eventDate) => {
      const { deps } = harness();
      expect(await createInvitation({ ...request, eventDate }, deps)).toMatchObject({
        ok: false,
        code: 'INVALID_EVENT_DATE',
      });
    },
  );
});
