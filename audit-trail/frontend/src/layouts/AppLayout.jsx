import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useWorkerStatus } from '../hooks/useShipmentData.js';
import { useAuth } from '../auth/AuthContext.jsx';

const THEME_KEY = 'audit-trail-theme';

function getInitialTheme() {
  try {
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
  } catch {
    // Ignore storage access issues and fall back to the system preference.
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  return 'dark';
}

/**
 * The application shell.
 *
 * The header carries a live projection-lag indicator. That is not decoration:
 * in a CQRS system the gap between "the event exists" and "the read model knows
 * about it" is a real, observable property, and showing it turns eventual
 * consistency from a source of confusion into something the operator can see
 * resolve.
 */
export function AppLayout() {
  const location = useLocation();
  const worker = useWorkerStatus({ intervalMs: 4000, active: location.pathname !== '/' });
  const behind = worker?.lag?.behindBy ?? 0;
  const { user, logout } = useAuth();
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  };

  return (
    <div className="app">
      <header className="app__header">
        <Link to="/" className="brand">
          <span className="brand__mark">Audit&nbsp;Trail</span>
          <span className="brand__sub">Event-sourced logistics ledger</span>
        </Link>

        <span className="spacer" />

        {worker ? (
          <span className={`pill ${behind > 0 ? 'pill--amber' : 'pill--teal'}`} title="Projection worker status">
            <span className="pill__dot" />
            {behind > 0 ? `Projection ${behind} behind` : 'Projection current'}
          </span>
        ) : null}

        <button
          type="button"
          className="btn btn--sm btn--ghost theme-toggle"
          aria-label="Toggle theme"
          aria-pressed={theme === 'light'}
          onClick={toggleTheme}
        >
          <span aria-hidden="true">{theme === 'dark' ? '☀️' : '🌙'}</span>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>

        <nav>
          {user ? <span className="eyebrow">{user.displayName} · {user.role}</span> : null}
          {user ? <button type="button" className="btn btn--sm btn--ghost" onClick={logout}>Log out</button> : null}
          <Link
            to="/shipments"
            className="btn btn--sm btn--ghost"
            aria-current={location.pathname === '/shipments' ? 'page' : undefined}
          >
            Open ledger
          </Link>
        </nav>
      </header>

      <main className="app__main">
        <Outlet />
      </main>

      <footer className="app__footer">
        Events are the source of truth. The read model is derived, and can be rebuilt from history at any time.
      </footer>
    </div>
  );
}
