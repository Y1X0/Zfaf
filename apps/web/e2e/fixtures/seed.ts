import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  TOTP_SECRET_BYTES,
  flushAnalytics,
  normaliseRecoveryCode,
  parseDraftDocument,
  recoveryCodeFromBytes,
  resolveDocument,
  snapshotChecksum,
} from '@zfaf/core';
import { AesGcmSecretCipher } from '@zfaf/infra/crypto/cipher';
import { PrismaAnalyticsRepository, getPrismaClient } from '@zfaf/db';
import { RedisAnalyticsBuffer, getRedis } from '@zfaf/infra/analytics';

/**
 * Seeds a signed-in user with an invitation, for the end-to-end suite.
 *
 * The session is created the way the application does — a random token stored
 * only as a SHA-256 hash (ADR-0006) — rather than by a test-only bypass. A
 * fixture that logs in through a back door tests a path production does not
 * have, and would keep passing if the real one broke.
 */

export interface SeededBuilder {
  readonly invitationId: string;
  readonly sessionToken: string;
  readonly userId: string;
  readonly draftVersion: number;
}

export interface SeededPublished extends SeededBuilder {
  readonly slug: string;
  readonly versionId: string;
}

export type PublishedStatus = 'PUBLISHED' | 'PAUSED' | 'EXPIRED' | 'SUSPENDED' | 'DRAFT';

const TEST_EMAIL_DOMAIN = 'e2e.zfaf.test';

export function testDatabaseUrl(): string {
  return (
    process.env['DATABASE_URL'] ??
    'postgresql://zfaf:zfaf_local_dev@127.0.0.1:5432/zfaf?schema=public'
  );
}

/**
 * Reuses the data layer's own client factory.
 *
 * `packages/db` is the only package permitted to import Prisma (ADR-0003,
 * enforced by `zfaf/no-prisma-outside-db`), and a test fixture is not an
 * exemption from that — it is just another caller.
 */
export function prismaClient(): ReturnType<typeof getPrismaClient> {
  return getPrismaClient(testDatabaseUrl());
}

function draftDocument(timezone: string) {
  return {
    schemaVersion: 1,
    templateKey: 'classic-luxury',
    templateVersion: 1,
    locale: 'ar',
    timezone,
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
        id: 'couple',
        type: 'couple',
        variant: 'couple.portraitPair',
        enabled: true,
        order: 1,
        props: {},
      },
      {
        id: 'gallery',
        type: 'gallery',
        variant: 'gallery.masonry',
        enabled: true,
        order: 2,
        props: {},
      },
      {
        id: 'footer',
        type: 'footer',
        variant: 'footer.ornament',
        enabled: true,
        order: 3,
        props: {},
      },
    ],
    content: {
      couple: { groomName: '', brideName: '', shortName: null, message: null, photo: null },
      wedding: { date: null, startTime: null, endTime: null, timezone },
      location: { venueName: null, address: null, latitude: null, longitude: null, mapsUrl: null },
      events: [],
      cover: null,
      gallery: [],
      music: { trackId: null, url: null, title: null, attribution: null },
      rsvp: { enabled: true, deadline: null, maxPartySize: 5 },
    },
  };
}

export async function seedBuilder(): Promise<SeededBuilder> {
  const prisma = prismaClient();
  try {
    // The market decides the zone; hard-coding one here would reintroduce
    // exactly the assumption ADR-0015 removes.
    const timezone = 'UTC';

    const templateId = randomUUID();
    const templateVersionId = randomUUID();
    await prisma.template.create({
      data: {
        id: templateId,
        key: `e2e-${randomUUID().slice(0, 8)}`,
        nameI18n: { ar: 'قالب اختبار', en: 'Test template' },
        descriptionI18n: { ar: '', en: '' },
        category: 'classic',
        status: 'published',
      },
    });
    await prisma.templateVersion.create({
      data: {
        id: templateVersionId,
        templateId,
        version: 1,
        manifest: {},
        manifestChecksum: 'e2e',
        publishedAt: new Date(),
      },
    });

    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `e2e-${randomUUID().slice(0, 8)}@${TEST_EMAIL_DOMAIN}`,
        emailVerifiedAt: new Date(),
        marketCode: 'SA',
        role: 'customer',
      },
    });

    const invitationId = randomUUID();
    await prisma.invitation.create({
      data: {
        id: invitationId,
        ownerId: userId,
        title: 'دعوة اختبار',
        templateId,
        templateVersionId,
        locale: 'ar',
        marketCode: 'SA',
        timezone,
        eventDate: new Date('2026-09-20T00:00:00.000Z'),
        draftDocument: draftDocument(timezone),
      },
    });
    await prisma.invitationMember.create({
      data: {
        id: randomUUID(),
        invitationId,
        userId,
        role: 'owner',
        acceptedAt: new Date(),
      },
    });

    // Stored as a hash only, exactly as the application does.
    const sessionToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    await prisma.session.create({
      data: {
        id: randomUUID(),
        userId,
        tokenHash: createHash('sha256').update(sessionToken).digest(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        // `createdAt` bounds the absolute lifetime; the domain derives the cap
        // from it rather than storing a second timestamp.
        createdAt: new Date(),
        lastUsedAt: new Date(),
      },
    });

    const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    return { invitationId, sessionToken, userId, draftVersion: invitation.draftVersion };
  } finally {
    // The factory caches one client per URL, so it is not disconnected here;
    // the process exiting closes it.
  }
}

/** Removes everything a run created, keyed by the test email domain. */
export async function cleanupSeeded(): Promise<void> {
  const prisma = prismaClient();
  try {
    const users = await prisma.user.findMany({
      where: { email: { endsWith: TEST_EMAIL_DOMAIN } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);
    if (userIds.length === 0) return;

    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    // Before the user, and not by cascade: `MediaAsset.owner` is `Restrict`,
    // so a single seeded upload makes the `user.deleteMany` below fail with a
    // foreign-key error — and a cleanup that throws leaves the *previous*
    // run's rows behind for the next one to trip over.
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.slugHistory.deleteMany({ where: { invitation: { ownerId: { in: userIds } } } });
    await prisma.rsvp.deleteMany({ where: { invitation: { ownerId: { in: userIds } } } });
    await prisma.invitationMember.deleteMany({ where: { userId: { in: userIds } } });
    // The pointer has to be cleared before the versions it points at can go —
    // and the status with it, because a check constraint (rightly) refuses a
    // PUBLISHED invitation that points at no version.
    await prisma.invitation.updateMany({
      where: { ownerId: { in: userIds } },
      data: { publishedVersionId: null, status: 'DRAFT' },
    });
    // Versions are not deleted directly: the immutability trigger (M1) refuses
    // that while the invitation exists, and rightly — a published snapshot is
    // append-only. Deleting the invitation cascades them, which is the only
    // route the schema allows and therefore the one a cleanup should take.
    await prisma.invitation.deleteMany({ where: { ownerId: { in: userIds } } });
    // Audit rows are deliberately left behind: the table rejects DELETE by
    // trigger (M1), and an audit log a cleanup routine can erase is not an
    // audit log. They carry no personal data beyond an actor id.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    // The factory caches one client per URL, so it is not disconnected here;
    // the process exiting closes it.
  }
}

export async function readDraft(invitationId: string): Promise<{
  document: Record<string, unknown>;
  version: number;
}> {
  const prisma = prismaClient();
  try {
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    return { document: row.draftDocument as Record<string, unknown>, version: row.draftVersion };
  } finally {
    // The factory caches one client per URL, so it is not disconnected here;
    // the process exiting closes it.
  }
}

/**
 * A complete, filled-in draft — the starting point for publishing.
 *
 * Separate from `draftDocument`, which is deliberately empty because the
 * builder tests need to type into it. Publishing needs a draft that has what
 * an invitation must have, and nothing more.
 */
function filledDraft(
  timezone: string,
  themeColors?: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const base = draftDocument(timezone) as Record<string, unknown>;

  if (themeColors) {
    const theme = base['theme'] as Record<string, Record<string, unknown>>;
    theme['colors'] = { ...theme['colors'], ...themeColors };
  }

  // A countdown, because it is the one section with client behaviour and the
  // published page's only moving part.
  const sections = base['sections'] as Record<string, unknown>[];
  sections.splice(1, 0, {
    id: 'countdown',
    type: 'countdown',
    variant: 'countdown.ornateBoxes',
    enabled: true,
    order: 1,
    props: {},
  });
  // The RSVP form, which is the whole of M7's public surface.
  sections.splice(2, 0, {
    id: 'rsvp',
    type: 'rsvp',
    variant: 'rsvp.elegantForm',
    enabled: true,
    order: 2,
    props: {},
  });

  const content = base['content'] as Record<string, Record<string, unknown>>;
  content['couple'] = { ...content['couple'], groomName: 'أحمد', brideName: 'سارة' };
  content['wedding'] = { ...content['wedding'], date: '2026-09-20', startTime: '20:00' };
  content['location'] = { ...content['location'], venueName: 'قاعة النخيل' };
  return base;
}

export interface SeedPublishedOptions {
  readonly status?: PublishedStatus;
  readonly visibility?: 'UNLISTED' | 'INDEXED' | 'PROTECTED';
  readonly expiresAt?: Date | null;
  readonly slug?: string;
  /**
   * Palette overrides, for tests about what a *customised* invitation looks
   * like. The shipped templates all clear WCAG AA, so a suite that only ever
   * sees the default palette cannot see the class of defect that arrives when
   * an owner picks her own colours — which is where the M9 contrast failure
   * lived.
   */
  readonly themeColors?: Readonly<Record<string, string>>;
}

/**
 * Seeds an invitation that has already been published.
 *
 * The snapshot is produced by the same `resolveDocument` the publish use case
 * calls, and checksummed by the same function, so what the public page reads
 * here is what publishing really writes. A fixture that hand-wrote a snapshot
 * would be testing the fixture's idea of one.
 *
 * `status` is settable because the security matrix needs an expired, a paused
 * and a suspended invitation, and there is no legitimate application path that
 * puts an invitation into all three.
 */
export async function seedPublished(options: SeedPublishedOptions = {}): Promise<SeededPublished> {
  const prisma = prismaClient();
  const seeded = await seedBuilder();
  const timezone = 'UTC';

  const draft = filledDraft(timezone, options.themeColors);
  const parsed = parseDraftDocument(draft);
  if (!parsed.ok) throw new Error(`seed draft is invalid: ${parsed.errors.join(', ')}`);

  const publishedAt = new Date();
  const resolved = resolveDocument(parsed.document, { publishedAt: publishedAt.toISOString() });
  if (!resolved.ok) {
    throw new Error(
      `seed draft is not publishable: ${resolved.issues.map((i) => i.field).join(', ')}`,
    );
  }

  const invitation = await prisma.invitation.findUniqueOrThrow({
    where: { id: seeded.invitationId },
    select: { templateVersionId: true },
  });

  const versionId = randomUUID();
  await prisma.invitationVersion.create({
    data: {
      id: versionId,
      invitationId: seeded.invitationId,
      versionNumber: 1,
      publishedDocument: resolved.snapshot as unknown as object,
      documentChecksum: snapshotChecksum(resolved.snapshot),
      templateVersionId: invitation.templateVersionId,
      publishedById: seeded.userId,
      publishedAt,
    },
  });

  const slug = options.slug ?? `e2e-${randomUUID().slice(0, 8)}`;
  await prisma.invitation.update({
    where: { id: seeded.invitationId },
    data: {
      draftDocument: draft as object,
      slug,
      status: options.status ?? 'PUBLISHED',
      visibility: options.visibility ?? 'UNLISTED',
      publishedVersionId: versionId,
      publishedAt,
      expiresAt: options.expiresAt ?? null,
    },
  });

  return { ...seeded, slug, versionId };
}

/**
 * A media row belonging to a seeded invitation.
 *
 * `pending`, because that is the state the authorization matrix wants: the
 * `complete` endpoint accepts exactly that state, so a row in any other one
 * would answer 409 for the owner and the cell would read "denied" for a reason
 * that has nothing to do with authorization.
 *
 * No object is put in storage. The matrix asks who may reach the handler, and
 * the owner's `complete` legitimately fails with `OBJECT_MISSING` — a 409,
 * which is an *allowed* verdict there. A suite that needed real bytes to prove
 * a permission check would be testing storage instead.
 */
export async function seedMedia(seeded: SeededBuilder): Promise<string> {
  const prisma = prismaClient();
  const id = randomUUID();
  await prisma.mediaAsset.create({
    data: {
      id,
      ownerId: seeded.userId,
      invitationId: seeded.invitationId,
      kind: 'image',
      purpose: 'gallery',
      storageKey: `media/${seeded.userId}/${seeded.invitationId}/${id}/original.bin`,
      originalFilename: 'e2e.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: BigInt(1024),
      signedMaxBytes: BigInt(8 * 1024 * 1024),
      status: 'pending',
    },
  });
  return id;
}

/** Retires a slug the way a rename does, so the 301 can be exercised. */
export async function retireSlug(invitationId: string, oldSlug: string): Promise<void> {
  const prisma = prismaClient();
  await prisma.slugHistory.create({
    data: { id: randomUUID(), invitationId, oldSlug, changedAt: new Date() },
  });
}

/** How many replies an invitation has. Used to assert that nothing was written. */
export async function countRsvps(invitationId: string): Promise<number> {
  return prismaClient().rsvp.count({ where: { invitationId } });
}

/** The invitation's denormalised reply counters (M7). */
export async function readCounters(
  invitationId: string,
): Promise<{ yes: number; no: number; guests: number }> {
  const row = await prismaClient().invitation.findUniqueOrThrow({
    where: { id: invitationId },
    select: { rsvpYesCount: true, rsvpNoCount: true, rsvpGuestCount: true },
  });
  return { yes: row.rsvpYesCount, no: row.rsvpNoCount, guests: row.rsvpGuestCount };
}

/**
 * A signed-in platform administrator.
 *
 * Used to prove the negative: staff reach the invitation and are still refused
 * the guest list, because guest data is not staff-readable however senior the
 * account (docs/09 §3.4).
 */
export async function seedStaffSession(
  options: {
    /** `admin` by default; `support` to check the narrower role (M8). */
    readonly role?: 'support' | 'admin' | 'superadmin';
    /**
     * How long ago this operator signed in.
     *
     * The admin console requires a session younger than four hours (docs/04
     * §10), so a test that checks that rule needs to be able to age one.
     */
    readonly signedInMinutesAgo?: number;
    /**
     * The second factor's state for this operator (docs/09 §2.8, M10).
     *
     * Defaults to `verified`, because 2FA is mandatory for staff and a session
     * without it is not a signed-in operator at all — an admin test that
     * started from an unverified session would be testing the gate, not the
     * thing it means to test. The other two values exist so the gate itself
     * can be exercised from the outside.
     */
    readonly twoFactor?: 'none' | 'unverified' | 'verified';
  } = {},
): Promise<{
  userId: string;
  sessionToken: string;
  sessionId: string;
  totpSecret: Uint8Array | null;
}> {
  const prisma = prismaClient();
  const userId = randomUUID();
  await prisma.user.create({
    data: {
      id: userId,
      email: `staff-${randomUUID().slice(0, 8)}@${TEST_EMAIL_DOMAIN}`,
      emailVerifiedAt: new Date(),
      marketCode: 'SA',
      role: options.role ?? 'admin',
    },
  });

  const twoFactor = options.twoFactor ?? 'verified';
  let totpSecret: Uint8Array | null = null;

  if (twoFactor !== 'none') {
    // Sealed with the same key the server holds, so the credential this writes
    // is one the running application can actually verify against — a fixture
    // that wrote plaintext would test a path production does not have.
    totpSecret = new Uint8Array(randomBytes(TOTP_SECRET_BYTES));
    await prisma.twoFactorCredential.create({
      data: {
        id: randomUUID(),
        userId,
        secretSealed: Buffer.from(new AesGcmSecretCipher(totpEncryptionKey()).encrypt(totpSecret)),
        confirmedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  const createdAt = new Date(Date.now() - (options.signedInMinutesAgo ?? 0) * 60 * 1000);
  const sessionToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const sessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: sessionId,
      userId,
      tokenHash: createHash('sha256').update(sessionToken).digest(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt,
      lastUsedAt: new Date(),
      twoFactorVerifiedAt: twoFactor === 'verified' ? new Date() : null,
    },
  });

  return { userId, sessionToken, sessionId, totpSecret };
}

/**
 * A user row, by address or by id.
 *
 * For the authentication suite, which needs to check what a *response* did not
 * say against what the database actually holds.
 */
export async function userByEmail(
  email?: string,
  userId?: string,
): Promise<{
  id: string;
  email: string;
  role: string;
  emailVerifiedAt: Date | null;
} | null> {
  const prisma = prismaClient();
  const row = userId
    ? await prisma.user.findUnique({ where: { id: userId } })
    : email
      ? await prisma.user.findUnique({ where: { email } })
      : null;
  return row
    ? { id: row.id, email: row.email, role: row.role, emailVerifiedAt: row.emailVerifiedAt }
    : null;
}

/**
 * The token a verification or reset email *would* have carried.
 *
 * Read from the database rather than from a response, because no endpoint
 * returns one — a live credential in a response body is a live credential in
 * every proxy log between the server and the browser. With `MAIL_DRIVER=noop`
 * this is the only honest way to exercise the flow end to end.
 *
 * Returns null when the token has already been used, so a test cannot
 * accidentally assert on a spent one.
 */
export async function latestVerificationToken(
  userId: string,
  purpose: 'email_verification' | 'password_reset',
): Promise<string | null> {
  // Two tables, one per purpose — a reset token and a verification token have
  // different lifetimes and different blast radii, and keeping them apart means
  // a bug in one cannot redeem the other.
  const prisma = prismaClient();
  const row =
    purpose === 'email_verification'
      ? await prisma.emailVerification.findFirst({
          where: { userId, usedAt: null },
          orderBy: { createdAt: 'desc' },
        })
      : await prisma.passwordReset.findFirst({
          where: { userId, usedAt: null },
          orderBy: { createdAt: 'desc' },
        });
  if (!row) return null;

  /**
   * Only the SHA-256 is stored, so the plaintext is recovered by brute force
   * over the tokens this process has seen — which is impossible.
   *
   * Instead the fixture re-issues: it writes a token it chose, with the same
   * hash discipline the application uses, replacing the row's hash. The flow
   * under test is unchanged; what changes is that the test knows the secret,
   * exactly as the recipient of the email would.
   */
  const plaintext = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const tokenHash = createHash('sha256').update(plaintext).digest();
  if (purpose === 'email_verification') {
    await prisma.emailVerification.update({ where: { id: row.id }, data: { tokenHash } });
  } else {
    await prisma.passwordReset.update({ where: { id: row.id }, data: { tokenHash } });
  }
  return plaintext;
}

/**
 * A second, unverified session for an operator who already has one.
 *
 * Exists for exactly one test: replaying a spent TOTP code from a different
 * browser on the same account, which is the attack replay protection is for.
 */
export async function seedSecondStaffSession(userId: string): Promise<string> {
  const sessionToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  await prismaClient().session.create({
    data: {
      id: randomUUID(),
      userId,
      tokenHash: createHash('sha256').update(sessionToken).digest(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      twoFactorVerifiedAt: null,
    },
  });
  return sessionToken;
}

/**
 * The key the server encrypts TOTP secrets with.
 *
 * Read from the environment with the same fallback `playwright.config.ts`
 * passes to the server, so the fixture and the application agree without a
 * second place to keep in sync.
 */
export function totpEncryptionKey(): string {
  return (
    process.env['TOTP_ENCRYPTION_KEY'] ?? 'e2e-totp-encryption-key-at-least-32-characters-long'
  );
}

/** Issues a recovery code for a seeded operator, returning the plaintext once. */
export async function seedRecoveryCode(userId: string): Promise<string> {
  const code = recoveryCodeFromBytes(new Uint8Array(randomBytes(16)));
  await prismaClient().twoFactorRecoveryCode.create({
    data: {
      id: randomUUID(),
      userId,
      codeHash: createHash('sha256').update(normaliseRecoveryCode(code)).digest(),
    },
  });
  return code;
}

/** How many analytics rows an invitation has. Direct, so the beacon is measured end to end. */
export async function countAnalyticsEvents(invitationId: string): Promise<number> {
  return await prismaClient().analyticsEvent.count({ where: { invitationId } });
}

/**
 * Everything sitting in the analytics buffer, as raw text.
 *
 * Read directly from Redis so a test can assert on **what is actually at rest
 * there**, not on what a repository chose to show it.
 */
export async function pendingAnalytics(): Promise<readonly string[]> {
  const redis = getRedis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379');
  return await redis.lrange('zfaf:analytics:pending', 0, -1);
}

/** Drains the buffer into the database, as the worker's timer would. */
export async function flushAnalyticsNow(): Promise<number> {
  const redis = getRedis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379');
  const report = await flushAnalytics({
    buffer: new RedisAnalyticsBuffer(redis),
    repository: new PrismaAnalyticsRepository(prismaClient()),
  });
  return report.written;
}
