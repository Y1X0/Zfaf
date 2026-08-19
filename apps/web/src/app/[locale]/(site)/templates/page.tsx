import type { ReactElement } from 'react';
import { getTranslations } from 'next-intl/server';

import { localePath } from '../../../../i18n/href.js';
import type { Locale } from '../../../../i18n/routing.js';
import { container } from '../../../../server/container.js';
import { SiteShell } from '../SiteShell.js';

/**
 * The templates page (D9.4, updated).
 *
 * Displays published templates available in the system with their names and
 * descriptions. Visitors can browse templates and start creating an invitation
 * using one of them by signing up.
 */
export default async function TemplatesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ReactElement> {
  const { locale: raw } = await params;
  const locale = raw as Locale;
  const t = await getTranslations('marketing.templates');

  const templates = await container().templates.listPublished();

  return (
    <SiteShell locale={locale} path="/templates">
      <div className="zf-prose">
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>

        {templates.length > 0 ? (
          <div
            className="zf-template-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '2rem',
              marginTop: '2rem',
              marginBottom: '2rem',
            }}
          >
            {templates.map((template) => (
              <div
                key={template.manifest.key}
                className="zf-template-card"
                style={{
                  padding: '1.5rem',
                  border: '1px solid #e5e7eb',
                  borderRadius: '0.5rem',
                  backgroundColor: '#fafafa',
                }}
              >
                <h3 style={{ marginTop: 0 }}>
                  {template.manifest.meta.name[locale] || template.manifest.meta.name.en || template.manifest.key}
                </h3>
                <p style={{ marginBottom: '1rem', fontSize: '0.95rem', color: '#666' }}>
                  {template.manifest.meta.description[locale] ||
                    template.manifest.meta.description.en ||
                    ''}
                </p>
                <a
                  className="zf-btn"
                  href={localePath(locale, '/register')}
                  style={{ display: 'inline-block' }}
                >
                  {t('useTemplate')}
                </a>
              </div>
            ))}
          </div>
        ) : (
          <p className="zf-legal__updated">{t('empty')}</p>
        )}
      </div>
    </SiteShell>
  );
}
