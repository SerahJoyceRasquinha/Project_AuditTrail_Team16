import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';

export function LoginPage() {
  const { login } = useAuth();
  const [credentials, setCredentials] = useState({ username: 'operator', password: 'operator123' });
  const [error, setError] = useState(null);
  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    try { await login(credentials); } catch (loginError) { setError(loginError.message); }
  };

  return (
    <div className="panel login-panel">
      <div className="panel__head"><h1 className="panel__title">Sign in to Audit Trail</h1></div>
      <form className="panel__body login-form" onSubmit={submit}>
        <label>Username<input value={credentials.username} onChange={(event) => setCredentials({ ...credentials, username: event.target.value })} /></label>
        <label>Password<input type="password" value={credentials.password} onChange={(event) => setCredentials({ ...credentials, password: event.target.value })} /></label>
        {error ? <p className="state-block--error" role="alert">{error}</p> : null}
        <button className="btn" type="submit">Sign in</button>
        <p className="eyebrow">Demo roles: operator, auditor, admin</p>
      </form>
    </div>
  );
}