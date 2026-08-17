'use client';

import { type FormEvent, type ReactElement, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { type ApiFailure, apiSend } from './api.js';

/**
 * The five auth forms (docs/23 §7.1).
 *
 * Client islands, because a form that reports "that address is already
 * registered" without losing what the person typed needs state. They are the
 * only interactive part of these pages; the headings and links around them are
 * server-rendered, and `IslandMessages` hands each page only the `auth` and
 * `common` namespaces rather than the whole catalogue.
 *
 * ## What these components deliberately do not do
 *
 * **No validation that decides anything.** `required`, `type="email"` and
 * `minLength` are here to spare somebody a round trip, not to enforce a rule:
 * every one of them is re-checked server-side, and the server's answer is what
 * the form reports. A client-side password policy that disagrees with the
 * server's is how a person is told their password is fine and then refused.
 *
 * **No branching on a message.** Errors are matched on `code`. The sentence is
 * written for a person and may be reworded; the code is the contract (docs/04
 * §2).
 *
 * ## The honesty rule these forms follow
 *
 * Registration and the reset request both answer the same way whether or not
 * the address has an account — that is the API's design, and the interface
 * must not undo it by rendering a different screen for the two. So neither
 * form ever says "that address is taken". They say a message is on its way,
 * which is true in both cases.
 */

/** Where somebody lands after signing in or signing up. */
const AFTER_AUTH = '/dashboard';

function useSubmit(): {
  readonly pending: boolean;
  readonly error: ApiFailure | null;
  readonly setError: (failure: ApiFailure | null) => void;
  run: (task: () => Promise<ApiFailure | null>) => Promise<void>;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  const run = useCallback(async (task: () => Promise<ApiFailure | null>) => {
    setPending(true);
    setError(null);
    try {
      setError(await task());
    } finally {
      // In a `finally`, so a thrown render error still releases the button.
      // A permanently disabled submit is indistinguishable from a hung server.
      setPending(false);
    }
  }, []);

  return { pending, error, setError, run };
}

/**
 * The error line.
 *
 * `role="alert"` so a screen reader announces it without the person having to
 * go looking, and keyed by code so the copy stays in the catalogue.
 */
function ErrorLine({ error }: { readonly error: ApiFailure | null }): ReactElement | null {
  const t = useTranslations('auth');
  if (!error) return null;

  const known = ['NETWORK', 'RATE_LIMITED', 'VALIDATION_FAILED', 'UNAUTHENTICATED'];
  const key = known.includes(error.code) ? error.code : 'UNKNOWN';

  return (
    <p className="zfa-error" role="alert" data-testid="auth-error" data-code={error.code}>
      {t(`errors.${key}`)}
    </p>
  );
}

function navigate(to: string): void {
  // A full navigation rather than a router push: these pages carry no client
  // router, and the session cookie has just changed — a hard load is what
  // guarantees the next page is rendered with it.
  window.location.assign(to);
}

// ── register ───────────────────────────────────────────────────────────────

export function RegisterForm({ locale }: { readonly locale: 'ar' | 'en' }): ReactElement {
  const t = useTranslations('auth');
  const { pending, error, run } = useSubmit();

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    void run(async () => {
      const result = await apiSend('/api/v1/auth/register', 'POST', {
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
        name: String(form.get('name') ?? '') || undefined,
        locale,
      });
      if (!result.ok) return result.error;

      /**
       * Straight to the dashboard, verified or not.
       *
       * Verification gates **publishing**, not the first run (FR-A2). Parking
       * a new customer on a "check your inbox" wall before they have seen
       * anything is how a signup becomes an abandoned tab.
       */
      navigate(AFTER_AUTH);
      return null;
    });
  };

  return (
    <form className="zfa-form" onSubmit={onSubmit} noValidate data-testid="register-form">
      <label className="zfa-field">
        <span className="zfa-field__label">{t('field.name')}</span>
        <input className="zfa-field__input" name="name" autoComplete="name" maxLength={120} />
      </label>

      <label className="zfa-field">
        <span className="zfa-field__label">{t('field.email')}</span>
        <input
          className="zfa-field__input"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          data-testid="email"
        />
      </label>

      <label className="zfa-field">
        <span className="zfa-field__label">{t('field.password')}</span>
        <input
          className="zfa-field__input"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          data-testid="password"
        />
        {/* Stated before they type, not after they are refused. */}
        <span className="zfa-field__hint">{t('field.passwordHint')}</span>
      </label>

      <ErrorLine error={error} />

      <button className="zfa-btn" type="submit" disabled={pending} data-testid="submit">
        {pending ? t('working') : t('register.submit')}
      </button>
    </form>
  );
}

// ── login ──────────────────────────────────────────────────────────────────

interface LoginResponse {
  readonly requiresEmailVerification: boolean;
  readonly nextStep: 'none' | 'two_factor' | 'enrol_two_factor';
}

export function LoginForm(): ReactElement {
  const t = useTranslations('auth');
  const { pending, error, run } = useSubmit();

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    void run(async () => {
      const result = await apiSend<LoginResponse>('/api/v1/auth/login', 'POST', {
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      if (!result.ok) return result.error;

      /**
       * A staff account owing a second factor is sent to the console, which
       * owns that flow (M10). A customer never sees this branch — `nextStep`
       * is a rendering hint, and the session already carries exactly the
       * authority it is entitled to whatever this value says.
       */
      navigate(result.data?.nextStep === 'none' ? AFTER_AUTH : '/admin');
      return null;
    });
  };

  return (
    <form className="zfa-form" onSubmit={onSubmit} noValidate data-testid="login-form">
      <label className="zfa-field">
        <span className="zfa-field__label">{t('field.email')}</span>
        <input
          className="zfa-field__input"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          data-testid="email"
        />
      </label>

      <label className="zfa-field">
        <span className="zfa-field__label">{t('field.password')}</span>
        <input
          className="zfa-field__input"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          data-testid="password"
        />
      </label>

      <ErrorLine error={error} />

      <button className="zfa-btn" type="submit" disabled={pending} data-testid="submit">
        {pending ? t('working') : t('login.submit')}
      </button>
    </form>
  );
}

// ── verify email ───────────────────────────────────────────────────────────

/**
 * Redeems the token from the email link.
 *
 * The link points **here**, at a page, and the page posts to the endpoint —
 * never the other way round. docs/09 §5 forbids a mutating `GET`, and beyond
 * that a verification link is followed by mail scanners, corporate proxies and
 * link previewers, every one of which would consume a single-use token before
 * the person ever clicked.
 *
 * It fires once on mount rather than asking for a button press: the person has
 * already expressed their intent by opening the link, and a second click for
 * the same decision is friction with nothing behind it.
 */
export function VerifyEmailPanel({ token }: { readonly token: string | null }): ReactElement {
  const t = useTranslations('auth');
  const [state, setState] = useState<'working' | 'done' | 'failed' | 'missing'>(
    token ? 'working' : 'missing',
  );
  const [resent, setResent] = useState<'idle' | 'sent' | 'signedOut'>('idle');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    void (async () => {
      const result = await apiSend('/api/v1/auth/verify-email', 'POST', { token });
      if (cancelled) return;
      setState(result.ok ? 'done' : 'failed');
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const resend = useCallback(async () => {
    const result = await apiSend('/api/v1/auth/verify-email', 'PUT');
    // Resending needs a session rather than an address — an endpoint that took
    // an email would send mail to anyone, at anyone's request. So somebody who
    // opened a stale link in a browser with no session is told to sign in
    // rather than left pressing a button that answers 401.
    setResent(result.ok ? 'sent' : 'signedOut');
  }, []);

  return (
    <div className="zfa-panel" data-testid="verify-panel" data-state={state}>
      {state === 'working' && <p aria-live="polite">{t('verify.working')}</p>}

      {state === 'done' && (
        <>
          <p className="zfa-ok" role="status" data-testid="verify-done">
            {t('verify.done')}
          </p>
          <a className="zfa-btn" href={AFTER_AUTH}>
            {t('verify.continue')}
          </a>
        </>
      )}

      {(state === 'failed' || state === 'missing') && (
        <>
          <p className="zfa-error" role="alert" data-testid="verify-failed">
            {t('verify.failed')}
          </p>
          {resent === 'idle' && (
            <button className="zfa-btn" type="button" onClick={() => void resend()}>
              {t('verify.resend')}
            </button>
          )}
          {resent === 'sent' && <p role="status">{t('verify.resent')}</p>}
          {resent === 'signedOut' && (
            <p role="status">
              {t('verify.signInFirst')} <a href="/login">{t('login.title')}</a>
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── forgot password ────────────────────────────────────────────────────────

export function ForgotPasswordForm(): ReactElement {
  const t = useTranslations('auth');
  const { pending, error, run } = useSubmit();
  const [sent, setSent] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    void run(async () => {
      const result = await apiSend('/api/v1/auth/password-reset', 'POST', {
        email: String(form.get('email') ?? ''),
      });
      // Rate limiting is about the caller and may be reported. Everything else
      // is the same answer whether or not the address has an account — and the
      // interface must not undo that by rendering two different screens.
      if (!result.ok && result.error.code === 'RATE_LIMITED') return result.error;
      setSent(true);
      return null;
    });
  };

  if (sent) {
    return (
      <p className="zfa-ok" role="status" data-testid="reset-requested">
        {t('forgot.sent')}
      </p>
    );
  }

  return (
    <form className="zfa-form" onSubmit={onSubmit} noValidate data-testid="forgot-form">
      <label className="zfa-field">
        <span className="zfa-field__label">{t('field.email')}</span>
        <input
          className="zfa-field__input"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          data-testid="email"
        />
      </label>

      <ErrorLine error={error} />

      <button className="zfa-btn" type="submit" disabled={pending} data-testid="submit">
        {pending ? t('working') : t('forgot.submit')}
      </button>
    </form>
  );
}

// ── reset password ─────────────────────────────────────────────────────────

export function ResetPasswordForm({ token }: { readonly token: string | null }): ReactElement {
  const t = useTranslations('auth');
  const { pending, error, run } = useSubmit();
  const [done, setDone] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    void run(async () => {
      const result = await apiSend('/api/v1/auth/password-reset', 'PUT', {
        token: token ?? '',
        password: String(form.get('password') ?? ''),
      });
      if (!result.ok) return result.error;
      setDone(true);
      return null;
    });
  };

  if (!token) {
    return (
      <p className="zfa-error" role="alert" data-testid="reset-link-invalid">
        {t('reset.linkInvalid')} <a href="/forgot-password">{t('forgot.title')}</a>
      </p>
    );
  }

  if (done) {
    return (
      <div className="zfa-panel">
        {/* Every session was ended by the reset — including this browser's, if
            it had one. Saying so is the point: somebody resetting after a scare
            needs to know the other device is out. */}
        <p className="zfa-ok" role="status" data-testid="reset-done">
          {t('reset.done')}
        </p>
        <a className="zfa-btn" href="/login">
          {t('login.title')}
        </a>
      </div>
    );
  }

  return (
    <form className="zfa-form" onSubmit={onSubmit} noValidate data-testid="reset-form">
      <label className="zfa-field">
        <span className="zfa-field__label">{t('field.newPassword')}</span>
        <input
          className="zfa-field__input"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          data-testid="password"
        />
        <span className="zfa-field__hint">{t('field.passwordHint')}</span>
      </label>

      {/* `RESET_LINK_INVALID` is told apart from a weak password on purpose:
          the two need different actions, and somebody whose link had expired
          used to be told to "check the submitted values" and retype until they
          gave up. */}
      {error?.code === 'RESET_LINK_INVALID' ? (
        <p className="zfa-error" role="alert" data-testid="auth-error" data-code={error.code}>
          {t('reset.linkInvalid')} <a href="/forgot-password">{t('forgot.title')}</a>
        </p>
      ) : (
        <ErrorLine error={error} />
      )}

      <button className="zfa-btn" type="submit" disabled={pending} data-testid="submit">
        {pending ? t('working') : t('reset.submit')}
      </button>
    </form>
  );
}

// ── sign out ───────────────────────────────────────────────────────────────

/**
 * The sign-out control.
 *
 * A `POST`, never a link. `SameSite=Lax` carries the cookie on a cross-site
 * `GET`, so a sign-out reachable by `GET` is an endpoint any page on the
 * internet can point an `<img>` at to log our customers out (docs/09 §5).
 */
export function SignOutButton(): ReactElement {
  const t = useTranslations('auth');
  const [pending, setPending] = useState(false);

  return (
    <button
      className="zfd-btn zfd-btn--quiet"
      type="button"
      disabled={pending}
      data-testid="sign-out"
      onClick={() => {
        setPending(true);
        void apiSend('/api/v1/auth/logout', 'POST').then(() => {
          // Home, not the login form: somebody who just left should not be
          // looking at a box asking them to come back.
          navigate('/');
        });
      }}
    >
      {t('signOut')}
    </button>
  );
}
