import type { Actor } from '../../authz/actor.js';
import { type Action, can } from '../../authz/can.js';
import type { Clock } from '../../ports/clock.js';
import {
  INVITATION_STATUSES,
  type InvitationStatus,
} from '../../invitation/domain/invitation-status.js';

import type {
  AdminAuditRow,
  AdminInvitationRow,
  AdminPage,
  AdminRepository,
  AdminUserRow,
} from '../ports/admin-repository.js';

/**
 * The read-only half of the admin console (D8.6, D8.7).
 *
 * Support staff need to answer "does this account exist", "why is this link
 * dead", "who suspended this and when". All three are answerable from counts,
 * statuses and timestamps — none of them needs a guest list, and none of these
 * functions can return one.
 *
 * Every call here is itself audited. Reading a list of users is a legitimate
 * support action *and* a sensitive one, and the record of who looked is what
 * makes the access reviewable rather than merely permitted. Writing an audit
 * row per admin read costs one insert on a screen a handful of people open.
 */

export const ADMIN_PAGE_MAX = 100;

export type AdminReadResult<T> =
  | { readonly ok: true; readonly page: AdminPage<T> }
  | { readonly ok: false; readonly code: 'FORBIDDEN' };

/**
 * Metadata is scalars only, matching what `audit_logs` accepts.
 *
 * Deliberately narrow. An audit entry that can hold an arbitrary object is an
 * audit entry that will eventually hold a guest's phone number because someone
 * spread a row into it.
 */
export type AdminAuditMetadata = Readonly<Record<string, string | number | boolean>>;

export interface AdminAuditRecord {
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata: AdminAuditMetadata;
  readonly at: Date;
}

export interface AdminConsoleDeps {
  readonly admin: AdminRepository;
  readonly clock: Clock;
  readonly recordAdminAccess: (entry: AdminAuditRecord) => Promise<void>;
}

export interface AdminListInput {
  readonly actor: Actor;
  readonly query?: string | undefined;
  readonly status?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export async function adminListUsers(
  input: AdminListInput,
  deps: AdminConsoleDeps,
): Promise<AdminReadResult<AdminUserRow>> {
  const denied = refuse(input.actor, 'admin:read_users');
  if (denied) return denied;

  const page = await deps.admin.listUsers({
    query: normaliseQuery(input.query),
    status: input.status,
    ...pagination(input),
  });

  await audit(deps, input.actor, 'admin.users.list', 'user', 'collection', {
    // The search term is recorded, the results are not: knowing an operator
    // searched for an address is the reviewable fact; copying the matched
    // accounts into the audit table would duplicate the data we are guarding.
    query: normaliseQuery(input.query) ?? '',
    matched: page.total,
  });

  return { ok: true, page };
}

export async function adminListInvitations(
  input: AdminListInput,
  deps: AdminConsoleDeps,
): Promise<AdminReadResult<AdminInvitationRow>> {
  // Browsing invitations is the same support capability as browsing users, and
  // giving it a separate permission would mean a role that can see one but not
  // the other — a distinction with no operational meaning.
  const denied = refuse(input.actor, 'admin:read_users');
  if (denied) return denied;

  const page = await deps.admin.listInvitations({
    query: normaliseQuery(input.query),
    status: asInvitationStatus(input.status),
    ...pagination(input),
  });

  await audit(deps, input.actor, 'admin.invitations.list', 'invitation', 'collection', {
    query: normaliseQuery(input.query) ?? '',
    status: asInvitationStatus(input.status) ?? '',
    matched: page.total,
  });

  return { ok: true, page };
}

export interface AdminAuditListInput extends AdminListInput {
  readonly action?: string | undefined;
  readonly actorId?: string | undefined;
  readonly resourceId?: string | undefined;
}

export async function adminListAuditLog(
  input: AdminAuditListInput,
  deps: AdminConsoleDeps,
): Promise<AdminReadResult<AdminAuditRow>> {
  // A stricter role than the other two: the audit log is where an operator's
  // own actions are recorded, so who may read it is a different question from
  // who may do support work (docs/09 §4).
  const denied = refuse(input.actor, 'admin:read_audit_log');
  if (denied) return denied;

  const page = await deps.admin.listAuditLog({
    action: input.action,
    actorId: input.actorId,
    resourceId: input.resourceId,
    ...pagination(input),
  });

  /**
   * Reading the audit log is itself audited.
   *
   * Which does create an entry that will appear in the next read — that is
   * the intended behaviour, not an oversight. An audit trail with a hole
   * shaped like "people looking at the audit trail" is the one hole worth
   * least having.
   */
  await audit(deps, input.actor, 'admin.audit.list', 'audit_log', 'collection', {
    action: input.action ?? '',
    matched: page.total,
  });

  return { ok: true, page };
}

// ── shared ──────────────────────────────────────────────────────────────────

/**
 * The denial branch, shared.
 *
 * Returns the refusal itself rather than a boolean so a call site cannot
 * check the permission and then forget to return — the value it hands back is
 * already the answer.
 */
type AdminDenial = { readonly ok: false; readonly code: 'FORBIDDEN' };

function refuse(actor: Actor, action: Action): AdminDenial | null {
  return can(actor, action).allowed ? null : { ok: false, code: 'FORBIDDEN' };
}

function pagination(input: AdminListInput): { limit: number; offset: number } {
  return {
    limit: clamp(input.limit ?? 25, 1, ADMIN_PAGE_MAX),
    offset: Math.max(0, Math.trunc(input.offset ?? 0)),
  };
}

/** Trimmed, bounded, and empty-means-absent so `?q=` is not a search for "". */
function normaliseQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim();
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

function asInvitationStatus(value: string | undefined): InvitationStatus | undefined {
  return value && (INVITATION_STATUSES as readonly string[]).includes(value)
    ? (value as InvitationStatus)
    : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

async function audit(
  deps: AdminConsoleDeps,
  actor: Actor,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: AdminAuditMetadata,
): Promise<void> {
  await deps.recordAdminAccess({
    actorId: actor.kind === 'user' ? actor.userId : null,
    action,
    resourceType,
    resourceId,
    metadata,
    at: deps.clock.now(),
  });
}
