import { createContext, useContext, useState } from 'react';
import * as api from '../services/apiClient.js';

const USER_KEY = 'audit-trail-user';
const AuthContext = createContext(null);

function readUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(readUser);
  const login = async (credentials) => {
    const result = await api.login(credentials);
    localStorage.setItem(api.authTokenKey, result.token);
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
    setUser(result.user);
  };
  const logout = () => {
    localStorage.removeItem(api.authTokenKey);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  };
  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}