'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';

interface VerifyEmailButtonProps {
  readonly userId: string;
  readonly email: string;
}

export function VerifyEmailButton({ userId, email }: VerifyEmailButtonProps): ReactElement {
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);

  const handleVerify = async () => {
    if (!confirm(`Verify email for ${email}?`)) return;

    setIsVerifying(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/users/${userId}/verify-email`, {
        method: 'POST',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(errorData?.error?.message ?? `HTTP ${response.status}`);
      }

      setVerified(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify email');
      setIsVerifying(false);
    }
  };

  if (verified) {
    return <span>yes</span>;
  }

  return (
    <>
      <button
        className="zfd-btn zfd-btn--small"
        onClick={handleVerify}
        disabled={isVerifying}
        data-testid={`verify-email-${userId}`}
      >
        {isVerifying ? 'Verifying…' : 'Verify'}
      </button>
      {error && <p className="zfd-note zfd-note--error">{error}</p>}
    </>
  );
}
