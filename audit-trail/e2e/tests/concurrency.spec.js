import { test, expect } from '@playwright/test';
import {
  uniqueUsername,
  registerViaApi,
  loginViaApi,
  seedSession,
  createShipmentViaApi,
  moveShipmentViaApi,
} from './helpers.js';

/**
 * Optimistic Concurrency Control, seen from a browser.
 *
 * `tests/concurrency/optimisticConcurrency.test.js` already proves the rule
 * itself under a real ten-way race. This covers the part that only exists in a
 * browser: the roadmap's Week 4 scenario is specifically about a *user* whose
 * page went stale, so the thing worth checking here is that a page which loaded
 * version N and submits against it is refused rather than silently overwriting
 * whatever arrived in between.
 */

test('a command built against a stale version is refused with a conflict', async ({ page, playwright }) => {
  const request = await playwright.request.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
  });

  const username = uniqueUsername('occ');
  await registerViaApi(request, username, 'operator');
  const token = await loginViaApi(request, username);
  const created = await createShipmentViaApi(request, token);

  await seedSession(page, token);
  await page.goto(`/shipment/${created.aggregateId}`);
  await expect(page.getByRole('heading', { name: 'Immutable event history' })).toBeVisible();

  /**
   * Somebody else moves the shipment while this page is open. The page is now
   * looking at version 1; the store is at version 2.
   */
  await moveShipmentViaApi(request, token, {
    shipmentId: created.aggregateId,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Interloper',
    expectedVersion: created.version,
  });

  // The stale page submits against the version it loaded.
  const result = await page.evaluate(async ({ id, staleVersion }) => {
    const authToken = window.localStorage.getItem('audit-trail-token');
    const response = await fetch('/api/shipment/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        shipmentId: id,
        movementType: 'LOAD_ON_SHIP',
        location: 'Somewhere else',
        vesselName: 'MV Stale',
        expectedVersion: staleVersion,
      }),
    });
    return { status: response.status, body: await response.json() };
  }, { id: created.aggregateId, staleVersion: created.version });

  expect(result.status).toBe(409);
  expect(result.body.error.code).toBe('CONCURRENCY_CONFLICT');

  /**
   * The refusal must be total. `applied: false` is the claim the API makes, and
   * the event stream is where it is either true or not.
   */
  expect(result.body.error.details.applied).toBe(false);

  const events = await request.get(`/api/shipment/${created.aggregateId}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { events: stream } = await events.json();
  expect(stream).toHaveLength(2);
  expect(stream.map((event) => event.version)).toEqual([1, 2]);

  await request.dispose();
});
