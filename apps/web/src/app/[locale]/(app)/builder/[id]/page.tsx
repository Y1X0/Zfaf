import { notFound } from 'next/navigation';

import { getEnv } from '@zfaf/config';
import { tenantScopeFor } from '@zfaf/core';

import { Builder } from '../../../../../builder/Builder.js';
import { IslandMessages } from '../../../../../i18n/island.js';
import { container } from '../../../../../server/container.js';
import { requireActor } from '../../../../../server/request-context.js';
import '../../../../builder.css';

/**
 * The builder page.
 *
 * A server component that does the authorisation and hands the document to a
 * client island. The draft is embedded in the first response rather than
 * fetched afterwards: a couple opening their invitation on hotel wi-fi should
 * see it, not a spinner followed by a request that may fail.
 */

export const dynamic = 'force-dynamic';

export default async function BuilderPage({
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
  // 404 rather than 403 for an invitation that is not the caller's — the same
  // rule the API follows, for the same reason.
  if (!invitation) notFound();

  return (
    <IslandMessages namespaces={['builder', 'common']}>
      <Builder
        invitationId={invitation.id}
        title={invitation.title}
        initialDocument={invitation.draftDocument}
        initialVersion={invitation.draftVersion}
        initialSlug={invitation.slug}
        publishedBaseUrl={getEnv().PUBLIC_BASE_URL}
      />
    </IslandMessages>
  );
}
