'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

interface DeleteInvitationButtonProps {
  readonly invitationId: string;
  readonly onDeleted?: () => void;
}

export function DeleteInvitationButton({
  invitationId,
  onDeleted,
}: DeleteInvitationButtonProps): ReactElement {
  const t = useTranslations('dashboard');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!confirm(t('deleteConfirm'))) return;

    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(`/api/v1/invitations/${invitationId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(errorData?.error?.message ?? `HTTP ${response.status}`);
      }

      if (onDeleted) {
        onDeleted();
      } else {
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete invitation');
      setIsDeleting(false);
    }
  };

  return (
    <>
      <button
        className="zfd-btn zfd-btn--quiet zfd-btn--danger"
        onClick={handleDelete}
        disabled={isDeleting}
        data-testid="delete-invitation"
      >
        {isDeleting ? t('deleting') : t('delete')}
      </button>
      {error && <p className="zfd-row__error">{error}</p>}
    </>
  );
}
