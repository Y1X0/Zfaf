import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Zfaf',
  description: 'Digital wedding invitations',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Root layout.
 *
 * Locale routing and full RTL handling arrive in M9; the document is already
 * marked Arabic/RTL because that is the product default, not a later toggle
 * (ADR-0011).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
