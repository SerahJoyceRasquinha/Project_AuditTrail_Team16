import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { AuthProvider } from '../src/auth/AuthContext.jsx';
import { LoginPage } from '../src/pages/LoginPage.jsx';

function LoginHarness() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/shipments" element={<div>Shipment ledger</div>} />
    </Routes>
  );
}

describe('login page', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test('signs in and redirects to the shipment ledger', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        token: 'demo-token',
        user: { username: 'operator', displayName: 'Shipment Operator', role: 'operator' },
      }),
    })));

    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <LoginHarness />
        </AuthProvider>
      </MemoryRouter>
    );

    await user.clear(screen.getByLabelText(/username/i));
    await user.type(screen.getByLabelText(/username/i), 'operator');
    await user.clear(screen.getByLabelText(/password/i));
    await user.type(screen.getByLabelText(/password/i), 'operator123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Shipment ledger')).toBeInTheDocument();
    });
  });

  test('shows a loading state while the login request is in flight', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve({
        ok: true,
        text: async () => JSON.stringify({
          token: 'demo-token',
          user: { username: 'auditor', displayName: 'Compliance Auditor', role: 'auditor' },
        }),
      }), 50);
    })));

    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <LoginHarness />
        </AuthProvider>
      </MemoryRouter>
    );

    await user.type(screen.getByLabelText(/username/i), 'auditor');
    await user.type(screen.getByLabelText(/password/i), 'auditor123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();
  });
});
