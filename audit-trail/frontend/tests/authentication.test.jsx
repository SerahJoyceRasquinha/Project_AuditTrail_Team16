import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AuthProvider, useAuth } from '../src/auth/AuthContext.jsx';
import { LoginPage, validateCredentials } from '../src/pages/LoginPage.jsx';
import { RegisterPage, validateRegistration } from '../src/pages/RegisterPage.jsx';
import { AppLayout } from '../src/layouts/AppLayout.jsx';
import { ApiError } from '../src/services/apiClient.js';
import * as api from '../src/services/apiClient.js';

/**
 * A fake localStorage, so a test can assert what the browser is *allowed* to
 * keep - which for this application is the token and nothing else.
 */
function installStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    get size() {
      return store.size;
    },
    keys: () => [...store.keys()],
    raw: store,
  };
  vi.stubGlobal('localStorage', storage);
  return storage;
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- validation

describe('login validation', () => {
  test('flags both fields when empty', () => {
    const errors = validateCredentials({ username: '', password: '' });
    expect(errors.username).toBeTruthy();
    expect(errors.password).toBeTruthy();
  });

  test('treats whitespace as empty', () => {
    expect(validateCredentials({ username: '   ', password: 'x' }).username).toBeTruthy();
  });

  test('accepts a complete pair', () => {
    expect(validateCredentials({ username: 'someone', password: 'secret' })).toEqual({});
  });
});

describe('registration validation', () => {
  const valid = {
    username: 'newuser',
    password: 'Password123',
    confirmPassword: 'Password123',
    role: 'user',
  };

  test('accepts a well-formed registration', () => {
    expect(validateRegistration(valid)).toEqual({});
  });

  test('requires a password of at least eight characters', () => {
    expect(validateRegistration({ ...valid, password: 'short', confirmPassword: 'short' }).password).toBeTruthy();
  });

  test('requires the two passwords to match', () => {
    expect(
      validateRegistration({ ...valid, confirmPassword: 'Different123' }).confirmPassword
    ).toBeTruthy();
  });

  test('rejects a username with illegal characters', () => {
    expect(validateRegistration({ ...valid, username: 'bad name!' }).username).toBeTruthy();
  });

  test('rejects a role outside the two-role model', () => {
    // The frontend does not get to invent roles either; the backend would
    // refuse this too, but there is no reason to send it.
    expect(validateRegistration({ ...valid, role: 'admin' }).role).toBeTruthy();
    expect(validateRegistration({ ...valid, role: '' }).role).toBeTruthy();
  });
});

// -------------------------------------------------------------- the sign-in

const renderLogin = (entry = '/login') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/shipments" element={<div>Ledger</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );

describe('LoginPage', () => {
  test('does not ship pre-filled credentials', async () => {
    renderLogin();
    await waitFor(() => expect(screen.getByLabelText(/username/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/username/i)).toHaveValue('');
    expect(screen.getByLabelText(/password/i)).toHaveValue('');
  });

  /**
   * Arriving from the registration form.
   *
   * The account exists but the session does not, so the page has to say both
   * things: it worked, and there is one more step. The username is carried over
   * as a convenience; the password deliberately is not.
   */
  test('announces a completed registration and prefills the new username', async () => {
    renderLogin({
      pathname: '/login',
      state: { registered: true, username: 'freshaccount' },
    });

    expect(await screen.findByRole('status')).toHaveTextContent(/account was created/i);
    expect(await screen.findByRole('status')).toHaveTextContent(/sign in/i);
    expect(screen.getByLabelText(/username/i)).toHaveValue('freshaccount');
    expect(screen.getByLabelText(/password/i)).toHaveValue('');
  });

  test('shows no registration notice on an ordinary visit', async () => {
    renderLogin();
    await waitFor(() => expect(screen.getByLabelText(/username/i)).toBeInTheDocument());
    expect(screen.queryByText(/account was created/i)).not.toBeInTheDocument();
  });

  test('validates before calling the API', async () => {
    const login = vi.spyOn(api, 'login');
    renderLogin();

    fireEvent.click(await screen.findByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/enter your username/i)).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  test('invalid credentials do not produce an apparently successful login', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(
      new ApiError('Incorrect username or password.', { status: 401, code: 'INVALID_CREDENTIALS' })
    );

    renderLogin();

    fireEvent.change(await screen.findByLabelText(/username/i), { target: { value: 'someone' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrongpass' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect username or password/i);
    // Still on the login page, and no token was stored.
    expect(screen.queryByText('Ledger')).not.toBeInTheDocument();
    expect(localStorage.getItem(api.authTokenKey)).toBeNull();
  });

  test('clears the password field after a failed attempt', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(
      new ApiError('Incorrect username or password.', { status: 401, code: 'INVALID_CREDENTIALS' })
    );

    renderLogin();
    fireEvent.change(await screen.findByLabelText(/username/i), { target: { value: 'someone' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrongpass' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await screen.findByRole('alert');
    expect(screen.getByLabelText(/password/i)).toHaveValue('');
  });

  test('reports an unreachable backend distinctly from bad credentials', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(
      new ApiError('Could not reach the Audit Trail API.', { status: 0, code: 'NETWORK_ERROR' })
    );

    renderLogin();
    fireEvent.change(await screen.findByLabelText(/username/i), { target: { value: 'someone' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach/i);
  });

  test('shows a loading state while the request is in flight', async () => {
    let release;
    vi.spyOn(api, 'login').mockReturnValue(new Promise((resolve) => { release = resolve; }));

    renderLogin();
    fireEvent.change(await screen.findByLabelText(/username/i), { target: { value: 'someone' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('button', { name: /signing in/i })).toBeDisabled();

    await act(async () => {
      release({ token: 'tok', user: { username: 'someone', displayName: 'Someone', role: 'user' } });
    });
  });

  test('a successful sign-in stores only the token', async () => {
    vi.spyOn(api, 'login').mockResolvedValue({
      token: 'issued-token',
      user: { username: 'someone', displayName: 'Someone', role: 'operator' },
    });

    renderLogin();
    fireEvent.change(await screen.findByLabelText(/username/i), { target: { value: 'someone' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await screen.findByText('Ledger');

    expect(localStorage.getItem(api.authTokenKey)).toBe('issued-token');
    // The role must NOT be persisted anywhere the user could edit it.
    const persisted = localStorage.keys().map((key) => `${key}=${localStorage.getItem(key)}`).join('|');
    expect(persisted).not.toMatch(/operator/i);
    expect(localStorage.keys()).toEqual([api.authTokenKey]);
  });
});

// ---------------------------------------------------------- registration UI

describe('RegisterPage', () => {
  const renderRegister = () =>
    render(
      <MemoryRouter initialEntries={['/register']}>
        <AuthProvider>
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            {/* Where a successful registration is expected to land. */}
            <Route path="/login" element={<div>Sign in here</div>} />
            <Route path="/shipments" element={<div>Ledger</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

  test('offers exactly the two roles, and no administrator', async () => {
    renderRegister();
    const radios = await screen.findAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios.map((radio) => radio.value).sort()).toEqual(['operator', 'user']);
    expect(screen.queryByRole('radio', { name: /admin/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /auditor/i })).not.toBeInTheDocument();
  });

  test('defaults to the read-only role', async () => {
    renderRegister();
    // Matched from the start of the accessible name: the Operator option's
    // description also contains the word "User".
    expect(await screen.findByRole('radio', { name: /^User/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Operator/ })).not.toBeChecked();
  });

  test('says that the role is permanent, before it is chosen', async () => {
    renderRegister();
    expect(await screen.findByText(/set permanently.*cannot be changed/i)).toBeInTheDocument();
  });

  test('surfaces a duplicate username against the username field', async () => {
    vi.spyOn(api, 'register').mockRejectedValue(
      new ApiError('That username is already taken.', {
        status: 409,
        code: 'USERNAME_TAKEN',
        details: { fields: { username: 'That username is already taken.' } },
      })
    );

    renderRegister();
    fireEvent.change(await screen.findByLabelText(/^username/i), { target: { value: 'taken' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'Password123' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'Password123' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/already taken/i)).toBeInTheDocument();
    expect(screen.queryByText('Ledger')).not.toBeInTheDocument();
  });

  test('sends the chosen role, then hands over to the sign-in page', async () => {
    const register = vi.spyOn(api, 'register').mockResolvedValue({
      created: true,
      user: { username: 'fresh', displayName: 'fresh', role: 'operator' },
    });
    const login = vi.spyOn(api, 'login');
    const storeToken = vi.spyOn(api, 'storeToken');

    renderRegister();
    fireEvent.change(await screen.findByLabelText(/^username/i), { target: { value: 'fresh' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'Password123' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'Password123' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Operator/ }));
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    // The account is created with the role that was chosen...
    await waitFor(() =>
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ username: 'fresh', role: 'operator' }))
    );

    // ...and the user lands on the sign-in page rather than inside the ledger.
    expect(await screen.findByText('Sign in here')).toBeInTheDocument();
    expect(screen.queryByText('Ledger')).not.toBeInTheDocument();

    /**
     * Nothing was authenticated on the way. No session was requested, and
     * nothing was written to storage - so refreshing the page at this point
     * leaves the user signed out, which is the whole point of the change.
     */
    expect(login).not.toHaveBeenCalled();
    expect(storeToken).not.toHaveBeenCalled();
    expect(localStorage.keys()).toEqual([]);
  });

  test('a failed registration neither navigates nor creates a session', async () => {
    vi.spyOn(api, 'register').mockRejectedValue(
      new ApiError('That username is already taken.', {
        status: 409,
        code: 'USERNAME_TAKEN',
        details: { fields: { username: 'That username is already taken.' } },
      })
    );
    const storeToken = vi.spyOn(api, 'storeToken');

    renderRegister();
    fireEvent.change(await screen.findByLabelText(/^username/i), { target: { value: 'taken' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'Password123' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'Password123' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/already taken/i)).toBeInTheDocument();
    expect(screen.queryByText('Sign in here')).not.toBeInTheDocument();
    expect(storeToken).not.toHaveBeenCalled();
    expect(localStorage.keys()).toEqual([]);
  });
});

// ------------------------------------------------------------ session state

function Probe() {
  const { user, status, isOperator } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="role">{user?.role ?? 'none'}</span>
      <span data-testid="operator">{String(isOperator)}</span>
    </div>
  );
}

describe('session restoration', () => {
  test('with no token, settles as anonymous without calling the API', async () => {
    const me = vi.spyOn(api, 'getCurrentUser');
    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(me).not.toHaveBeenCalled();
  });

  test('a page refresh re-derives the role from the server, not from storage', async () => {
    installStorage({ [api.authTokenKey]: 'stored-token' });
    // Storage claims nothing about the role - and even if it did, this is where
    // the real answer comes from.
    vi.spyOn(api, 'getCurrentUser').mockResolvedValue({
      user: { username: 'someone', displayName: 'Someone', role: 'operator' },
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('role')).toHaveTextContent('operator');
  });

  test('a forged role in local storage is ignored entirely', async () => {
    // The classic attempt: hand-write an elevated user object into storage.
    installStorage({
      [api.authTokenKey]: 'stored-token',
      'audit-trail-user': JSON.stringify({ username: 'someone', role: 'operator' }),
    });
    vi.spyOn(api, 'getCurrentUser').mockResolvedValue({
      user: { username: 'someone', displayName: 'Someone', role: 'user' },
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    // The server's answer wins.
    expect(screen.getByTestId('role')).toHaveTextContent('user');
    expect(screen.getByTestId('operator')).toHaveTextContent('false');
  });

  test('a rejected token is discarded and the session ends anonymous', async () => {
    installStorage({ [api.authTokenKey]: 'expired-token' });
    vi.spyOn(api, 'getCurrentUser').mockRejectedValue(
      new ApiError('Authentication is required.', { status: 401, code: 'AUTHENTICATION_REQUIRED' })
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(localStorage.getItem(api.authTokenKey)).toBeNull();
  });

  test('starts pending so a refresh does not flash the login page', async () => {
    installStorage({ [api.authTokenKey]: 'stored-token' });
    let release;
    vi.spyOn(api, 'getCurrentUser').mockReturnValue(new Promise((resolve) => { release = resolve; }));

    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(screen.getByTestId('status')).toHaveTextContent('pending');

    await act(async () => {
      release({ user: { username: 'someone', displayName: 'Someone', role: 'user' } });
    });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
  });
});

// ------------------------------------------------------------------- layout

describe('AppLayout identity', () => {
  const renderLayout = () =>
    render(
      <MemoryRouter initialEntries={['/shipments']}>
        <AuthProvider>
          <AppLayout />
        </AuthProvider>
      </MemoryRouter>
    );

  test('signed out, it offers Create account and Sign in', async () => {
    renderLayout();
    expect(await screen.findByRole('link', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();
  });

  test('signed in, it shows the username and role and a way out', async () => {
    installStorage({ [api.authTokenKey]: 'stored-token' });
    vi.spyOn(api, 'getCurrentUser').mockResolvedValue({
      user: { username: 'reader', displayName: 'Reader Person', role: 'user' },
    });
    vi.spyOn(api, 'getWorkerStatus').mockRejectedValue(new ApiError('nope', { status: 500 }));

    renderLayout();

    expect(await screen.findByText('Reader Person')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log out/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /create account/i })).not.toBeInTheDocument();
  });

  test('logging out clears the token and restores the signed-out header', async () => {
    installStorage({ [api.authTokenKey]: 'stored-token' });
    vi.spyOn(api, 'getCurrentUser').mockResolvedValue({
      user: { username: 'reader', displayName: 'Reader Person', role: 'user' },
    });
    vi.spyOn(api, 'getWorkerStatus').mockRejectedValue(new ApiError('nope', { status: 500 }));

    renderLayout();
    fireEvent.click(await screen.findByRole('button', { name: /log out/i }));

    await waitFor(() => expect(localStorage.getItem(api.authTokenKey)).toBeNull());
    expect(await screen.findByRole('link', { name: /sign in/i })).toBeInTheDocument();
  });
});
