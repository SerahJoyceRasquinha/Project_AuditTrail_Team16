import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestSystem, startHttp, seedCanonicalShipment } from '../helpers/testSystem.js';

/**
 * The command rate limit must not be spent by the query side.
 *
 * Both routers are mounted on `/api`, so every request - including every read -
 * enters the command router before falling through to the query router. A
 * limiter attached with `router.use` therefore counts reads against a budget
 * that exists to throttle writes. These tests pin the boundary: commands share
 * one budget, queries are never charged to it.
 */
async function withServer(t, overrides = {}) {
  const system = await createTestSystem({
    rateLimit: { enabled: true, windowMs: 60_000, maxRequests: 3 },
    ...overrides,
  });
  const http = await startHttp(system.app);
  t.after(async () => {
    await http.close();
    await system.teardown();
  });
  return { system, http };
}

test('queries are not counted against the command rate limit', async (t) => {
  const { system, http } = await withServer(t);
  await seedCanonicalShipment(system.container ?? system, 'SHP-RATE-1');
  await system.projectionWorker.catchUp();

  // Far more reads than the command budget of 3.
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    const response = await http.get('/api/shipments');
    statuses.push(response.status);
  }

  assert.ok(
    statuses.every((status) => status === 200),
    `every read should succeed, received: ${statuses.join(',')}`
  );

  // A mixture of read endpoints, all still serving after the burst above.
  for (const path of [
    '/api/shipment/SHP-RATE-1',
    '/api/shipment/SHP-RATE-1/events',
    '/api/shipment/SHP-RATE-1/integrity',
    '/api/meta/dashboard-metrics',
  ]) {
    const response = await http.get(path);
    assert.equal(response.status, 200, `${path} should not be rate limited`);
  }
});

test('commands are still rate limited, and share one budget across endpoints', async (t) => {
  const { http } = await withServer(t);

  const create = (suffix) =>
    http.post('/api/shipment/create', {
      shipmentId: `SHP-RATE-C${suffix}`,
      containerCode: `MSKU000000${suffix}`,
      origin: 'Chennai',
      destination: 'Rotterdam',
      estimatedDurationDays: 21,
    });

  assert.equal((await create(1)).status, 201);
  assert.equal((await create(2)).status, 201);
  assert.equal((await create(3)).status, 201);

  // Fourth command exceeds the budget of 3.
  const refused = await create(4);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, 'RATE_LIMITED');

  /**
   * The budget is a limit on *commanding*, not a separate allowance per
   * endpoint: a different command route must see the same exhausted bucket.
   */
  const otherCommand = await http.post('/api/shipment/move', {
    shipmentId: 'SHP-RATE-C1',
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Test',
    expectedVersion: 1,
  });
  assert.equal(otherCommand.status, 429);
});

test('reads keep working once the command budget is exhausted', async (t) => {
  const { system, http } = await withServer(t);
  await seedCanonicalShipment(system.container ?? system, 'SHP-RATE-2');
  await system.projectionWorker.catchUp();

  for (let i = 0; i < 5; i += 1) {
    await http.post('/api/shipment/create', {
      shipmentId: `SHP-RATE-D${i}`,
      containerCode: `MSKU111111${i}`,
      origin: 'Chennai',
      destination: 'Rotterdam',
      estimatedDurationDays: 21,
    });
  }

  // Commands are now refused...
  const refused = await http.post('/api/shipment/create', {
    shipmentId: 'SHP-RATE-D9',
    containerCode: 'MSKU9999999',
    origin: 'Chennai',
    destination: 'Rotterdam',
    estimatedDurationDays: 21,
  });
  assert.equal(refused.status, 429);

  // ...but the dashboard can still read. This is the property that matters:
  // a throttled write surface must not blind the audit surface.
  const list = await http.get('/api/shipments');
  assert.equal(list.status, 200);

  const events = await http.get('/api/shipment/SHP-RATE-2/events');
  assert.equal(events.status, 200);
  assert.ok(events.body.events.length > 0);
});
