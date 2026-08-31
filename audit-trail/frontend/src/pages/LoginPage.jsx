import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const DEMO_USERS = [
  { username: 'operator', password: 'operator123', role: 'Operator' },
  { username: 'auditor', password: 'auditor123', role: 'Auditor' },
  { username: 'admin', password: 'admin123', role: 'Admin' },
];

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [credentials, setCredentials] = useState({ username: 'operator', password: 'operator123' });
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (user) {
    return <Navigate to="/shipments" replace />;
  }

  const handleChange = (field) => (event) => {
    setCredentials((current) => ({ ...current, [field]: event.target.value }));
    if (error) setError('');
  };

  const applyDemoAccount = (demoUser) => {
    setCredentials({ username: demoUser.username, password: demoUser.password });
    setError('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      await login(credentials);
      navigate('/shipments', { replace: true });
    } catch (loginError) {
      setError(loginError.message || 'Unable to sign in right now.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card panel">
        <div className="auth-header panel__head">
          <div>
            <span className="auth-badge">Secure access</span>
            <h1 className="panel__title auth-title">Sign in to Audit Trail</h1>
          </div>
        </div>

        <form className="auth-form panel__body" onSubmit={submit} noValidate>
          <div className="auth-field">
            <label htmlFor="username" className="field__label">Username</label>
            <input
              id="username"
              className="input"
              type="text"
              autoComplete="username"
              value={credentials.username}
              onChange={handleChange('username')}
              placeholder="Enter your username"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password" className="field__label">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={credentials.password}
              onChange={handleChange('password')}
              placeholder="Enter your password"
            />
          </div>

          {error ? (
            <div className="state-block state-block--error auth-error" role="alert" aria-live="polite">
              <div className="state-block__title">Sign-in failed</div>
              {error}
            </div>
          ) : null}

          <button className="btn btn--primary auth-submit" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="auth-meta">
            <span className="eyebrow">Demo access</span>
            <div className="auth-demo-grid" aria-label="Demo accounts">
              {DEMO_USERS.map((demoUser) => (
                <button
                  key={demoUser.username}
                  type="button"
                  className="btn btn--ghost btn--sm auth-demo"
                  onClick={() => applyDemoAccount(demoUser)}
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