import { notFound } from 'next/navigation';

import { tenantScopeFor } from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { requireActor } from '../../../../../server/request-context.js';
import { IslandMessages } from '../../../../../i18n/island.js';
import { PreviewFrame } from './PreviewFrame.js';

/**
 * The preview document, loaded inside the builder's iframe (D5.8).
 *
 * A real route rather than a `srcdoc`, so the frame is a same-origin document
 * with its own navigation, its own stylesheet and honest media queries. It is
 * authorised exactly like every other private page: the actor comes from the
 * session cookie, and an invitation the caller cannot reach is a 404.
 *
 * `X-Frame-Options: DENY` is set globally, so this route relaxes it to
 * `SAMEORIGIN` — the builder embeds it, and nothing else may.
 */

export const dynamic = 'force-dynamic';

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const session = await requireActor();
  if (!session.authenticated) notFound();

  const scope = tenantScopeFor(session.actor);
  if (!scope) notFound();

  const { id } = await params;
  const invitation = await container().invitations.findByIdInScope(id, scope);
  if (!invitation) notFound();

  // Stamped once on the server so the preview is deterministic for this load:
  // a clock read inside the render would make two renders of the same document
  // differ, which is the property M3 spent its determinism tests protecting.
  const previewedAt = new Date().toISOString();

  return (
    <IslandMessages namespaces={['builder']}>
      <PreviewFrame initialDocument={invitation.draftDocument} previewedAt={previewedAt} />
    </IslandMessages>
  );
}
