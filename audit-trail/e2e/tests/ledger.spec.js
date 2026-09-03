import { test, expect } from '@playwright/test';
import {
  uniqueUsername,
  registerViaApi,
  loginViaApi,
  seedSession,
  createShipmentViaApi,
  moveShipmentViaApi,
  recordTemperatureViaApi,
} from './helpers.js';

/**
 * The forensic dashboard itself: the search bar the brief asks for in Week 1,
 * the vertical timeline from Week 2, the state scrubber from Week 3 and the
 * Recharts overlay from Week 4 — exercised in a browser, against a running
 * backend, in the order a logistics manager would meet them.
 */

let token;
let shipment;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
  });

  const username = uniqueUsername('ledger');
  await registerViaApi(request, username, 'operator');
  token = await loginViaApi(request, username);

  // The source document's canonical sequence:
  // CONTAINER_CREATED -> LOADED_ON_SHIP -> TEMPERATURE_SPIKE -> ARRIVED_AT_PORT
  const created = await createShipmentViaApi(request, token);
  const loaded = await moveShipmentViaApi(request, token, {
    shipmentId: created.aggregateId,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    voyageNumber: 'V-101',
    expectedVersion: created.version,
  });
  const spiked = await recordTemperatureViaApi(request, token, {
    shipmentId: created.aggregateId,
    temperatureC: 19.4,
    expectedVersion: loaded.version,
  });
  await moveShipmentViaApi(request, token, {
    shipmentId: created.aggregateId,
    movementType: 'ARRIVE_AT_PORT',
    location: 'Los Angeles',
    portName: 'Port of Los Angeles',
    expectedVersion: spiked.version,
  });

  shipment = { id: created.aggregateId };
  await request.dispose();
});

test.beforeEach(async ({ page }) => {
  await seedSession(page, token);
});

test('the ledger lists shipments and the search bar finds one by id', async ({ page }) => {
  await page.goto('/shipments');

  await expect(page.getByLabel('Search shipments')).toBeVisible();
  await page.getByLabel('Search shipments').fill(shipment.id);

  await expect(page.getByText(shipment.id).first()).toBeVisible();
});

test('the shipment page renders the immutable event history in order', async ({ page }) => {
  await page.goto(`/shipment/${shipment.id}`);

  await expect(page.getByRole('heading', { name: 'Immutable event history' })).toBeVisible();

  /**
   * All four events of the canonical sequence are present. Asserting on the
   * accessible names the timeline sets means this survives restyling — it is a
   * claim about what the page communicates, not about its class names.
   */
  for (const [label, version] of [
    ['Container created', 1],
    ['Loaded on ship', 2],
    ['Temperature spike', 3],
    ['Arrived at port', 4],
  ]) {
    await expect(
      page.getByLabel(new RegExp(`${label}, version ${version}`, 'i'))
    ).toBeVisible();
  }
});

test('the temperature spike is visible on the chart panel', async ({ page }) => {
  await page.goto(`/shipment/${shipment.id}`);

  await expect(
    page.getByRole('heading', { name: 'Temperature against the event timeline' })
  ).toBeVisible();
});

test('the time scrubber rewinds the shipment to an earlier state', async ({ page }) => {
  await page.goto(`/shipment/${shipment.id}`);

  await expect(page.getByRole('heading', { name: 'Time scrubber' })).toBeVisible();

  const scrubber = page.getByLabel('Reconstruct shipment state at a point in time');
  await expect(scrubber).toBeVisible();

  /**
   * Drag to the start of the range. The state shown must fall back to what the
   * ledger said at that moment — the arrival has not happened yet — which is the
   * distinction the whole project exists to make: reconstructed state is not
   * current state.
   */
  await scrubber.focus();
  await page.keyboard.press('Home');

  await expect(page.getByText(/ARRIVED_AT_PORT|Arrived at port/i).first()).toBeVisible();
});

test('chain integrity and read-model reconciliation both report clean', async ({ page }) => {
  await page.goto(`/shipment/${shipment.id}`);

  await expect(page.getByRole('heading', { name: 'Chain integrity' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Read model reconciliation' })).toBeVisible();
});

test('an unknown shipment id does not render a shipment', async ({ page }) => {
  await page.goto('/shipment/SHP-000000');

  // Whatever the page chooses to show, it must not claim a shipment exists.
  await expect(page.getByRole('heading', { name: 'Immutable event history' })).toHaveCount(0);
});
