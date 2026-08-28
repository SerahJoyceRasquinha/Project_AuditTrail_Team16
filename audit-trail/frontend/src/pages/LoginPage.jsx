import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

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
        </form>
      </div>
    </div>
  );
}
