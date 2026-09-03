import { test, expect } from '@playwright/test';
import { uniqueUsername, PASSWORD, registerViaApi, signIn } from './helpers.js';

/**
 * Authentication and authorisation, driven through a real browser.
 *
 * The backend suites already prove these rules over HTTP. What a browser adds is
 * the half those tests cannot reach: that the pages wire the rules up correctly —
 * that registering really does leave you signed out, that a refresh restores a
 * session from the token alone, and that a read-only account is not shown
 * affordances it would be refused for using.
 */

test('an unauthenticated visitor is sent to the sign-in page', async ({ page }) => {
  await page.goto('/shipments');

  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Sign in to Audit Trail' })).toBeVisible();
});

test('registering does not sign the new account in', async ({ page }) => {
  const username = uniqueUsername('reg');

  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  /**
   * The whole point of the fix this pins: the browser must land on the sign-in
   * page, not the ledger. An account that is authenticated the instant the form
   * submits was never checked against the password that was stored.
   */
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Sign in to Audit Trail' })).toBeVisible();

  // The username is offered back as a convenience; the password never is.
  await expect(page.getByLabel('Username')).toHaveValue(username);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');

  // And nothing that could pass for a session was kept.
  const stored = await page.evaluate(() => JSON.stringify(window.localStorage));
  expect(stored).not.toContain('token');
});

test('a wrong password is refused and does not open the ledger', async ({ page, request }) => {
  const username = uniqueUsername('bad');
  await registerViaApi(request, username, 'operator');

  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill('WrongPassword999');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('an operator signs in, reaches the ledger, and survives a refresh', async ({ page, request }) => {
  const username = uniqueUsername('op');
  await registerViaApi(request, username, 'operator');
  await signIn(page, username);

  await expect(page).toHaveURL(/\/shipments/);
  await expect(page.getByRole('button', { name: 'New shipment' })).toBeVisible();

  /**
   * A reload proves identity is re-derived from the token by `GET /auth/me`
   * rather than read back out of whatever the browser cached.
   */
  await page.reload();
  await expect(page.getByRole('button', { name: 'New shipment' })).toBeVisible();
});

test('a read-only account is not offered the command affordances', async ({ page, request }) => {
  const username = uniqueUsername('viewer');
  await registerViaApi(request, username, 'user');
  await signIn(page, username);

  await expect(page).toHaveURL(/\/shipments/);

  // The ledger is readable...
  await expect(page.getByLabel('Search shipments')).toBeVisible();
  // ...but nothing offers to append an event.
  await expect(page.getByRole('button', { name: 'New shipment' })).toHaveCount(0);
});

test('a read-only account is refused by the backend, not merely by the UI', async ({ page, request }) => {
  const username = uniqueUsername('viewerapi');
  await registerViaApi(request, username, 'user');
  await signIn(page, username);

  /**
   * Hiding the button is a courtesy. The control is the server, so this posts a
   * command from inside the authenticated page — exactly what someone with the
   * developer console open would do — and asserts a 403.
   */
  const status = await page.evaluate(async () => {
    const token = window.localStorage.getItem('audit-trail-token');
    const response = await fetch('/api/shipment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        containerCode: 'HACK1234567',
        origin: { countryCode: 'IN', stateCode: 'KA', city: 'Bengaluru' },
        destination: { countryCode: 'US', stateCode: 'CA', city: 'Los Angeles' },
        estimatedDurationDays: 7,
      }),
    });
    return response.status;
  });

  expect(status).toBe(403);
});
