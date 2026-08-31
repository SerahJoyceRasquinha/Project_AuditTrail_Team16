import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

/**
 * The demo accounts these buttons fill in.
 *
 * This list previously offered Operator, Auditor and Admin. Only the first of
 * those is a role the backend has: `roles.js` defines exactly two, `operator`
 * and `user`, and deliberately no administrator. Registering with either of
 * the other two was rejected with a 400, so two of the three buttons could
 * only ever fill in credentials that failed to sign in.
 *
 * These two match the accounts the backend seeds when
 * AUTH_SEED_DEMO_ACCOUNTS=true (see backend/src/application/services/
 * demoAccounts.js). If that flag is off - which is the default - the accounts
 * do not exist, so the block is only rendered when the API says they do.
 */
const DEMO_USERS = [
  { username: 'operator', password: 'operator123', role: 'Operator', hint: 'Can issue shipment commands' },
  { username: 'viewer', password: 'viewer123', role: 'User', hint: 'Read-only access to the ledger' },
];

export function validateCredentials({ username, password }) {
  const errors = {};
  if (!username.trim()) errors.username = 'Enter your username.';
  if (!password) errors.password = 'Enter your password.';
  return errors;
}

/**
 * Sign in.
 *
 * The previous version shipped with credentials pre-filled, reported failures
 * as a bare message, and had no notion of a request being in flight - so a slow
 * network looked identical to a dead button. This one validates before it
 * calls, disables while it waits, and distinguishes the failure the user can
 * act on (wrong credentials) from the one they cannot (the backend is down).
 */
export function LoginPage() {
  const { login, isAuthenticated, isPending } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [credentials, setCredentials] = useState({ username: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Where the user was heading before being redirected here.
  const destination = location.state?.from ?? '/shipments';

  if (isAuthenticated) return <Navigate to={destination} replace />;

  const update = (field) => (event) => {
    setCredentials((current) => ({ ...current, [field]: event.target.value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
  };

  const applyDemoAccount = (demoUser) => {
    setCredentials({ username: demoUser.username, password: demoUser.password });
    setFieldErrors({});
    setFormError(null);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    const errors = validateCredentials(credentials);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      await login({ username: credentials.username.trim(), password: credentials.password });
      navigate(destination, { replace: true });
    } catch (error) {
      /**
       * The backend deliberately returns the same message for a wrong password
       * and a username that does not exist, and it is repeated verbatim here
       * rather than being helpfully expanded into "no such user" - that
       * distinction is exactly what the backend is withholding.
       */
      if (error.status === 400 && error.details?.fields) {
        setFieldErrors(error.details.fields);
      } else {
        setFormError(
          error.code === 'NETWORK_ERROR'
            ? 'Could not reach the Audit Trail service. Check that the backend is running and try again.'
            : error.message
        );
      }
      // Never leave a password sitting in state after a failed attempt.
      setCredentials((current) => ({ ...current, password: '' }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="panel auth-panel">
        <div className="panel__head">
          <h1 className="panel__title">Sign in to Audit Trail</h1>
        </div>

        <form className="panel__body auth-form" onSubmit={submit} noValidate>
          <label className="field">
            <span className="field__label">Username</span>
            <input
              className="input"
              name="username"
              value={credentials.username}
              onChange={update('username')}
              autoComplete="username"
              autoFocus
              disabled={submitting || isPending}
              aria-invalid={fieldErrors.username ? 'true' : undefined}
            />
            {fieldErrors.username ? <span className="field__error">{fieldErrors.username}</span> : null}
          </label>

          <label className="field">
            <span className="field__label">Password</span>
            <input
              className="input"
              name="password"
              type="password"
              value={credentials.password}
              onChange={update('password')}
              autoComplete="current-password"
              disabled={submitting || isPending}
              aria-invalid={fieldErrors.password ? 'true' : undefined}
            />
            {fieldErrors.password ? <span className="field__error">{fieldErrors.password}</span> : null}
          </label>

          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}

          <button className="btn btn--primary auth-form__submit" type="submit" disabled={submitting || isPending}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="auth-form__alt">
            No account yet? <Link to="/register">Create one</Link>.
          </p>

          <div className="auth-meta">
            <span className="eyebrow">Demo access</span>
            <div className="auth-demo-grid" aria-label="Demo accounts">
              {DEMO_USERS.map((demoUser) => (
                <button
                  key={demoUser.username}
                  type="button"
                  className="btn btn--ghost btn--sm auth-demo"
                  onClick={() => applyDemoAccount(demoUser)}
                  title={demoUser.hint}
                >
                  {demoUser.role}
                </button>
              ))}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
