import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

/**
 * The two roles, described in terms of what they let you do rather than what
 * they are called. The choice is permanent, and the copy says so before it is
 * made rather than after.
 */
const ROLE_OPTIONS = [
  {
    value: 'user',
    label: 'User',
    summary: 'Read-only access',
    detail:
      'View shipments, the immutable event timeline, reconstructed state, the time scrubber, sensor readings and exports. Cannot create or change shipments.',
  },
  {
    value: 'operator',
    label: 'Operator',
    summary: 'Full shipment management',
    detail:
      'Everything a User can do, plus creating shipments, amending details, confirming lifecycle stages, scheduling, archiving and restoring.',
  },
];

export function validateRegistration({ username, password, confirmPassword, role }) {
  const errors = {};

  const cleanUsername = username.trim();
  if (!cleanUsername) {
    errors.username = 'Choose a username.';
  } else if (cleanUsername.length < 3) {
    errors.username = 'A username must be at least 3 characters.';
  } else if (!/^[A-Za-z0-9._-]+$/.test(cleanUsername)) {
    errors.username = 'Use only letters, numbers, dots, underscores and hyphens.';
  }

  if (!password) {
    errors.password = 'Choose a password.';
  } else if (password.length < 8) {
    errors.password = 'A password must be at least 8 characters.';
  }

  if (!confirmPassword) {
    errors.confirmPassword = 'Re-enter the password.';
  } else if (password !== confirmPassword) {
    errors.confirmPassword = 'The two passwords do not match.';
  }

  if (!['user', 'operator'].includes(role)) {
    errors.role = 'Choose a role.';
  }

  return errors;
}

/**
 * Create an account.
 *
 * Validation is mirrored rather than duplicated: these checks exist so the form
 * can respond immediately, and the backend runs the same rules again because
 * this form is not the only way to reach the endpoint. Where the two disagree,
 * the backend's answer is the one displayed - its per-field errors are merged
 * straight into the form.
 */
export function RegisterPage() {
  const { register, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    username: '',
    displayName: '',
    password: '',
    confirmPassword: '',
    role: 'user',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) return <Navigate to="/shipments" replace />;

  const update = (field) => (event) => {
    const { value } = event.target;
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    const errors = validateRegistration(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      const created = await register({
        username: form.username.trim(),
        displayName: form.displayName.trim() || undefined,
        password: form.password,
        confirmPassword: form.confirmPassword,
        role: form.role,
      });

      /**
       * Registering creates the account; it does not sign you in.
       *
       * The new credentials are then used the ordinary way, at the ordinary
       * sign-in form - which is both the honest thing to do and the only way
       * the password is ever actually checked against what was stored. The
       * username travels in router state so the person does not have to retype
       * it; the password deliberately does not.
       */
      navigate('/login', {
        replace: true,
        state: {
          registered: true,
          username: created?.username ?? form.username.trim().toLowerCase(),
        },
      });
    } catch (error) {
      if (error.details?.fields) {
        setFieldErrors(error.details.fields);
      } else {
        setFormError(
          error.code === 'NETWORK_ERROR'
            ? 'Could not reach the Audit Trail service. Check that the backend is running and try again.'
            : error.message
        );
      }
      setForm((current) => ({ ...current, password: '', confirmPassword: '' }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="panel auth-panel auth-panel--wide">
        <div className="panel__head">
          <h1 className="panel__title">Create an Audit Trail account</h1>
        </div>

        <form className="panel__body auth-form" onSubmit={submit} noValidate>
          <label className="field">
            <span className="field__label">Username</span>
            <input
              className="input"
              name="username"
              value={form.username}
              onChange={update('username')}
              autoComplete="username"
              autoFocus
              disabled={submitting}
              aria-invalid={fieldErrors.username ? 'true' : undefined}
            />
            {fieldErrors.username ? (
              <span className="field__error">{fieldErrors.username}</span>
            ) : (
              <span className="field__hint">Letters, numbers, dots, underscores and hyphens.</span>
            )}
          </label>

          <label className="field">
            <span className="field__label">Display name <span className="field__optional">optional</span></span>
            <input
              className="input"
              name="displayName"
              value={form.displayName}
              onChange={update('displayName')}
              placeholder="How your name appears in the header"
              autoComplete="name"
              disabled={submitting}
            />
          </label>

          <label className="field">
            <span className="field__label">Password</span>
            <input
              className="input"
              name="password"
              type="password"
              value={form.password}
              onChange={update('password')}
              autoComplete="new-password"
              disabled={submitting}
              aria-invalid={fieldErrors.password ? 'true' : undefined}
            />
            {fieldErrors.password ? (
              <span className="field__error">{fieldErrors.password}</span>
            ) : (
              <span className="field__hint">At least 8 characters.</span>
            )}
          </label>

          <label className="field">
            <span className="field__label">Confirm password</span>
            <input
              className="input"
              name="confirmPassword"
              type="password"
              value={form.confirmPassword}
              onChange={update('confirmPassword')}
              autoComplete="new-password"
              disabled={submitting}
              aria-invalid={fieldErrors.confirmPassword ? 'true' : undefined}
            />
            {fieldErrors.confirmPassword ? (
              <span className="field__error">{fieldErrors.confirmPassword}</span>
            ) : null}
          </label>

          <fieldset className="field field--wide role-choice">
            <legend className="field__label">Role</legend>
            {ROLE_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={`role-option ${form.role === option.value ? 'role-option--selected' : ''}`}
              >
                <input
                  type="radio"
                  name="role"
                  value={option.value}
                  checked={form.role === option.value}
                  onChange={update('role')}
                  disabled={submitting}
                />
                <span className="role-option__body">
                  <span className="role-option__head">
                    <strong>{option.label}</strong>
                    <span className="pill pill--muted">{option.summary}</span>
                  </span>
                  <span className="role-option__detail">{option.detail}</span>
                </span>
              </label>
            ))}
            {fieldErrors.role ? <span className="field__error">{fieldErrors.role}</span> : null}
            {/*
              Said plainly at the point of decision. The role is fixed on the
              account at creation and there is no screen, setting or request
              that changes it afterwards.
            */}
            <p className="form-hint">
              Your role is set permanently when the account is created and cannot be changed later.
            </p>
          </fieldset>

          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}

          <button className="btn btn--primary auth-form__submit" type="submit" disabled={submitting}>
            {submitting ? 'Creating account…' : 'Create account'}
          </button>

          <p className="auth-form__alt">
            Already have an account? <Link to="/login">Sign in</Link>.
          </p>
        </form>
      </div>
    </div>
  );
}
