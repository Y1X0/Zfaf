'use client';

import { type FormEvent, type ReactElement, useState } from 'react';
import { useTranslations } from 'next-intl';

import { apiSend } from '../auth/api.js';

/**
 * Starting an invitation (docs/23 §7.2).
 *
 * The step the product was missing. Everything downstream — the builder, the
 * autosave, the publish, the public page — assumed an invitation existed, and
 * there was no way for a person to make one.
 *
 * Four questions, and no more. A template, a name for the couple's own list, a
 * date and a language: everything else is editable in the builder, which is
 * where a couple actually wants to be. A long form before the first preview is
 * how a signup becomes an abandoned tab.
 *
 * ## What it does not decide
 *
 * The plan limit, whether the template is unlocked, whether the date is a real
 * day — all of it belongs to `createInvitation`, and this form reports what the
 * server answered. The `PLAN_LIMIT_EXCEEDED` case in particular is a *state*
 * the customer can change, not a rejection of what they typed, so it is
 * phrased as one.
 */

export interface TemplateChoice {
  readonly key: string;
  readonly name: string;
  readonly locked: boolean;
}

export function NewInvitation({
  templates,
  defaultLocale,
}: {
  readonly templates: readonly TemplateChoice[];
  readonly defaultLocale: 'ar' | 'en';
}): ReactElement {
  const t = useTranslations('dashboard');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = templates.filter((template) => !template.locked);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);

    void (async () => {
      try {
        const result = await apiSend<{ id: string }>('/api/v1/invitations', 'POST', {
          templateKey: String(form.get('templateKey') ?? ''),
          title: String(form.get('title') ?? ''),
          eventDate: String(form.get('eventDate') ?? ''),
          locale: form.get('locale') === 'en' ? 'en' : 'ar',
        });

        if (!result.ok) {
          const known = ['PLAN_LIMIT_EXCEEDED', 'INVALID_TITLE', 'INVALID_EVENT_DATE'];
          setError(known.includes(result.error.code) ? result.error.code : 'UNKNOWN');
          return;
        }

        // Straight into the builder. The point of creating an invitation is to
        // edit it, and a confirmation screen in between is a click for nothing.
        window.location.assign(`/builder/${result.data.id}`);
      } finally {
        setPending(false);
      }
    })();
  };

  if (!open) {
    return (
      <button
        className="zfd-btn"
        type="button"
        onClick={() => setOpen(true)}
        data-testid="new-invitation"
      >
        {t('new.open')}
      </button>
    );
  }

  return (
    <form className="zfd-controls" onSubmit={onSubmit} noValidate data-testid="new-invitation-form">
      <label className="zfd-field">
        <span className="zfd-field__label">{t('new.title')}</span>
        <input
          className="zfd-field__input"
          name="title"
          required
          maxLength={120}
          data-testid="new-title"
        />
      </label>

      <label className="zfd-field">
        <span className="zfd-field__label">{t('new.template')}</span>
        <select className="zfd-field__input" name="templateKey" required data-testid="new-template">
          {available.map((template) => (
            <option key={template.key} value={template.key}>
              {template.name}
            </option>
          ))}
        </select>
        {/* Locked templates are named rather than hidden: a customer who cannot
            have one yet should know it exists, and why. */}
        {templates.length > available.length ? (
          <span className="zfd-field__label">{t('new.someLocked')}</span>
        ) : null}
      </label>

      <label className="zfd-field">
        <span className="zfd-field__label">{t('new.date')}</span>
        <input
          className="zfd-field__input"
          name="eventDate"
          type="date"
          required
          data-testid="new-date"
        />
      </label>

      <label className="zfd-field">
        <span className="zfd-field__label">{t('new.locale')}</span>
        <select
          className="zfd-field__input"
          name="locale"
          defaultValue={defaultLocale}
          data-testid="new-locale"
        >
          <option value="ar">{t('new.localeAr')}</option>
          <option value="en">{t('new.localeEn')}</option>
        </select>
      </label>

      {error ? (
        <p className="zfa-error" role="alert" data-testid="new-error" data-code={error}>
          {t(`new.errors.${error}`)}
        </p>
      ) : null}

      <div className="zfd-filters">
        <button className="zfd-btn" type="submit" disabled={pending} data-testid="new-submit">
          {pending ? t('new.working') : t('new.submit')}
        </button>
        <button
          className="zfd-btn zfd-btn--quiet"
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          {t('new.cancel')}
        </button>
      </div>
    </form>
  );
}
