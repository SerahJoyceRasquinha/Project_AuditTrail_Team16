import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { AuthProvider } from '../src/auth/AuthContext.jsx';
import { DashboardPage } from '../src/pages/DashboardPage.jsx';
import { ApiError } from '../src/services/apiClient.js';
import * as api from '../src/services/apiClient.js';

/**
 * Role-aware rendering.
 *
 * These assert the *usability* half of the role model: a read-only account gets
 * a clean screen rather than a set of controls that look usable and then fail.
 * The security half is asserted on the backend, in
 * tests/integration/authentication.test.js - no amount of frontend testing can
 * establish it, because the frontend is not where it is enforced.
 */

const SHIPMENTS = {
  items: [
    {
      aggregateId: 'SHP-1001',
      containerCode: 'MSKU0000001',
      origin: 'Chennai, IN',
      destination: 'Rotterdam, NL',
      currentState: 'IN_TRANSIT',
      currentVersion: 3,
      currentLocation: 'Arabian Sea',
      latestTemperatureC: 4.2,
      lastEventAt: new Date().toISOString(),
      temperatureExcursion: false,
      temperatureBreachCount: 0,
      archived: false,
    },
  ],
  pagination: { page: 1, pageSize: 12, total: 1, totalPages: 1 },
};

function installStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  });
}

function renderDashboardAs(role) {
  installStorage({ [api.authTokenKey]: 'stored-token' });
  vi.spyOn(api, 'getCurrentUser').mockResolvedValue({
    user: { username: 'someone', displayName: 'Someone', role },
  });
  vi.spyOn(api, 'listShipments').mockResolvedValue(SHIPMENTS);
  vi.spyOn(api, 'getWorkerStatus').mockRejectedValue(new ApiError('unavailable', { status: 500 }));

  return render(
    <MemoryRouter initialEntries={['/shipments']}>
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the dashboard as an Operator', () => {
  test('offers shipment creation', async () => {
    renderDashboardAs('operator');
    expect(await screen.findByRole('button', { name: /new shipment/i })).toBeInTheDocument();
  });

  test('offers per-shipment management actions', async () => {
    renderDashboardAs('operator');
    await screen.findByText('SHP-1001');
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument();
  });
});

describe('the dashboard as a read-only User', () => {
  test('does not offer shipment creation', async () => {
    renderDashboardAs('user');
    await screen.findByText('SHP-1001');
    expect(screen.queryByRole('button', { name: /new shipment/i })).not.toBeInTheDocument();
  });

  test('does not offer edit or archive on a shipment card', async () => {
    renderDashboardAs('user');
    await screen.findByText('SHP-1001');
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^archive$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^restore$/i })).not.toBeInTheDocument();
  });

  test('keeps every read affordance intact', async () => {
    renderDashboardAs('user');
    await screen.findByText('SHP-1001');

    // The forensic view is for everybody: search, refresh, filters and the
    // route into the shipment's audit trail all stay.
    expect(screen.getByLabelText(/search shipments/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filters/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view details/i })).toBeInTheDocument();
    expect(screen.getByText('Chennai, IN → Rotterdam, NL')).toBeInTheDocument();
  });

  test('the empty ledger explains the situation without offering a create button', async () => {
    installStorage({ [api.authTokenKey]: 'stored-token' });
    vi.spyOn(api, 'getCurrentUser').mockResolvedValue({
      user: { username: 'someone', displayName: 'Someone', role: 'user' },
    });
    vi.spyOn(api, 'listShipments').mockResolvedValue({
      items: [],
      pagination: { page: 1, pageSize: 12, total: 0, totalPages: 1 },
    });
    vi.spyOn(api, 'getWorkerStatus').mockRejectedValue(new ApiError('unavailable', { status: 500 }));

    render(
      <MemoryRouter initialEntries={['/shipments']}>
        <AuthProvider>
          <DashboardPage />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText(/an Operator account can add the first one/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create a shipment/i })).not.toBeInTheDocument();
  });

  test('a forbidden response from the backend is reported, not swallowed', async () => {
    installStorage({ [api.authTokenKey]: 'stored-token' });
    vi.spyOn(api, 'getCurrentUser').mockResolvedValue({
      user: { username: 'someone', displayName: 'Someone', role: 'user' },
    });
    vi.spyOn(api, 'listShipments').mockRejectedValue(
      new ApiError('This action requires the Operator role.', { status: 403, code: 'FORBIDDEN' })
    );
    vi.spyOn(api, 'getWorkerStatus').mockRejectedValue(new ApiError('unavailable', { status: 500 }));

    render(
      <MemoryRouter initialEntries={['/shipments']}>
        <AuthProvider>
          <DashboardPage />
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(screen.getByText(/requires the Operator role/i)).toBeInTheDocument()
    );
  });
});
