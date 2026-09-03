import { expect } from '@playwright/test';

/**
 * Shared fixtures.
 *
 * Accounts are created through the real HTTP API rather than by driving the
 * registration form, for everything except the one test that is *about* the
 * registration form. Setup that goes through the UI makes every test a test of
 * the sign-up page, so a change there fails a dozen unrelated specs and the
 * report stops telling you what actually broke.
 */

export const PASSWORD = 'Password123';

/** Usernames must not collide across a re-run against a persistent backend. */
export function uniqueUsername(prefix) {
  return `e2e_${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

/** A container code that is unique per run, in the canonical 4-letter + 7-digit shape. */
export function uniqueContainerCode() {
  const digits = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
  return `E2EU${digits}`;
}

export async function registerViaApi(request, username, role = 'operator') {
  const response = await request.post('/api/auth/register', {
    data: { username, password: PASSWORD, role },
  });
  expect(response.status(), await response.text()).toBe(201);
  return username;
}

export async function loginViaApi(request, username) {
  const response = await request.post('/api/auth/login', {
    data: { username, password: PASSWORD },
  });
  expect(response.status(), await response.text()).toBe(200);
  const { token } = await response.json();
  return token;
}

/** Signs in through the form — the path a real user takes. */
export async function signIn(page, username, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/shipments/);
}

/**
 * Creates a shipment over the API and returns its server-allocated id.
 *
 * Deliberately not driven through the create dialog: these specs are about the
 * ledger and the audit trail, and a shipment is their fixture, not their
 * subject. The dialog has its own spec.
 */
export async function createShipmentViaApi(request, token, overrides = {}) {
  const response = await request.post('/api/shipment/create', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      containerCode: uniqueContainerCode(),
      origin: { countryCode: 'IN', stateCode: 'KA', city: 'Bengaluru' },
      destination: { countryCode: 'US', stateCode: 'CA', city: 'Los Angeles' },
      estimatedDurationDays: 21,
      cargoDescription: 'Vaccines',
      carrier: 'Maersk',
      minTemperatureC: 2,
      maxTemperatureC: 8,
      ...overrides,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

export async function moveShipmentViaApi(request, token, body) {
  const response = await request.post('/api/shipment/move', {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

export async function recordTemperatureViaApi(request, token, body) {
  const response = await request.post('/api/shipment/temperature', {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

/**
 * Puts an existing token into the browser before the app boots, so a test can
 * start from a signed-in state without replaying the sign-in form each time.
 */
export async function seedSession(page, token) {
  await page.addInitScript((value) => {
    window.localStorage.setItem('audit-trail-token', value);
  }, token);
}
