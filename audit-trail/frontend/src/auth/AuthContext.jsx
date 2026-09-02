import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as api from '../services/apiClient.js';

/**
 * The frontend's view of who is signed in.
 *
 * The important decision here is what is *not* stored. An earlier version kept
 * the whole user object - including the role - in local storage and read it
 * back on boot, which meant a role was whatever the browser said it was. The
 * backend never honoured that claim, but the UI did, and a dashboard that
 * renders operator controls for a read-only account is a bug even when every
 * button it offers is ultimately refused.
 *
 * So: the browser keeps the token and nothing else. On every load the token is
 * exchanged at `/api/auth/me` for the identity and role the *server* holds.
 * Editing local storage can therefore invalidate a session, but it can never
 * upgrade one - the worst a tampered token achieves is being logged out.
 *
 * `status` distinguishes "not signed in" from "not known yet", which is what
 * stops the router from bouncing an authenticated user to the login page during
 * the first moments after a refresh.
 */
const AuthContext = createContext(null);

export const AUTH_STATUS = Object.freeze({
  PENDING: 'pending',
  AUTHENTICATED: 'authenticated',
  ANONYMOUS: 'anonymous',
});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(AUTH_STATUS.PENDING);

  /**
   * Restore the session on mount.
   *
   * No token means anonymous without a round trip. A token that the backend
   * rejects is discarded rather than retried, so a stale or tampered value
   * cannot leave the app stuck in a pending state.
   */
  useEffect(() => {
    const token = api.readToken();
    if (!token) {
      setStatus(AUTH_STATUS.ANONYMOUS);
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;

    api
      .getCurrentUser(controller.signal)
      .then((result) => {
        if (cancelled) return;
        setUser(result.user);
        setStatus(AUTH_STATUS.AUTHENTICATED);
      })
      .catch((error) => {
        if (cancelled || error.name === 'AbortError') return;
        // 401 means the token is no longer good for anything; clear it.
        // A network failure is different - the token may well still be valid -
        // but without the server we cannot establish a role, and guessing one
        // is exactly what this context exists to avoid.
        if (error.status === 401) api.clearToken();
        setUser(null);
        setStatus(AUTH_STATUS.ANONYMOUS);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const adopt = useCallback((result) => {
    api.storeToken(result.token);
    // Taken from the response body, which the backend built from the stored
    // account - not from anything the form supplied.
    setUser(result.user);
    setStatus(AUTH_STATUS.AUTHENTICATED);
    return result.user;
  }, []);

  const login = useCallback(
    async (credentials) => adopt(await api.login(credentials)),
    [adopt]
  );

  /**
   * Creates an account. It deliberately does not sign in.
   *
   * An earlier version passed the registration response to `adopt()`, which
   * stored a token and made the new account authenticated the instant the form
   * submitted. Two things were wrong with that. The backend no longer issues a
   * token here at all, so there is nothing to adopt; and even when it did, the
   * only evidence the chosen password worked was that the form had been filled
   * in - the credentials were never actually exercised. So this returns the
   * created account and leaves the session alone, and the caller sends the user
   * to sign in with the credentials they just chose.
   *
   * Nothing is written to storage, which is also what stops a page refresh
   * immediately after registering from finding a session that was never
   * established.
   */
  const register = useCallback(async (details) => {
    const result = await api.register(details);
    return result.user;
  }, []);

  const logout = useCallback(() => {
    api.clearToken();
    setUser(null);
    setStatus(AUTH_STATUS.ANONYMOUS);
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      isAuthenticated: status === AUTH_STATUS.AUTHENTICATED,
      isPending: status === AUTH_STATUS.PENDING,
      /**
       * Used for conditional rendering only. The backend re-derives this from
       * the stored account on every command it receives, so a UI that got it
       * wrong would produce a 403, never an unauthorised write.
       */
      isOperator: user?.role === 'operator',
      login,
      register,
      logout,
    }),
    [user, status, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return context;
}
