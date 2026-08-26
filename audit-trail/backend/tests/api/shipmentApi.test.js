import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestSystem, startHttp, seedCanonicalShipment } from '../helpers/testSystem.js';

async function withServer(t) {
  const system = await createTestSystem();
  const http = await startHttp(system.app);
  t.after(async () => {
    await http.close();
    await system.teardown();
  });
  return { system, http };
}

test('the health endpoint reports service and persistence status', async (t) => {
  const { http } = await withServer(t);
  const response = await http.get('/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.database, 'connected');
});

test('an unknown route returns a structured 404', async (t) => {
  const { http } = await withServer(t);
  const response = await http.get('/api/not-a-route');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'ROUTE_NOT_FOUND');
});

test('commands and queries are served by separate routers', async (t) => {
  const { http } = await withServer(t);

  const command = await http.post('/api/shipment/create', {
    shipmentId: 'SHP-API-1',
    containerCode: 'MSKU1',
    estimatedDurationDays: 21,
    origin: 'Chennai',
    destination: 'Rotterdam',
  });
  assert.equal(command.status, 201);
  assert.equal(command.headers.get('x-cqrs-side'), 'command');

  const query = await http.get('/api/shipment/SHP-API-1');
  assert.equal(query.status, 200);
  assert.equal(query.headers.get('x-cqrs-side'), 'query');
});

test('a command route rejects a GET, and a query route rejects a POST', async (t) => {
  const { http } = await withServer(t);
  assert.equal((await http.get('/api/shipment/create')).status, 404);
  assert.equal((await http.post('/api/shipments', {})).status, 404);
});

test('the full command sequence from the source document works over HTTP', async (t) => {
  const { system, http } = await withServer(t);

  const created = await http.post('/api/shipment/create', {
    shipmentId: 'SHP-API-2',
    containerCode: 'MSKU2',
    estimatedDurationDays: 21,
    origin: 'Chennai',
    destination: 'Rotterdam',
    minTemperatureC: 2,
    maxTemperatureC: 8,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.eventType, 'CONTAINER_CREATED');

  const loaded = await http.post('/api/shipment/move', {
    shipmentId: 'SHP-API-2',
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: created.body.version,
  });
  assert.equal(loaded.body.eventType, 'LOADED_ON_SHIP');

  const spike = await http.post('/api/shipment/temperature', {
    shipmentId: 'SHP-API-2',
    temperatureC: 12.4,
    expectedVersion: loaded.body.version,
  });
  assert.equal(spike.body.eventType, 'TEMPERATURE_SPIKE');

  const arrived = await http.post('/api/shipment/move', {
    shipmentId: 'SHP-API-2',
    movementType: 'ARRIVE_AT_PORT',
    location: 'Rotterdam',
    portName: 'Port of Rotterdam',
    expectedVersion: spike.body.version,
  });
  assert.equal(arrived.body.eventType, 'ARRIVED_AT_PORT');

  await system.projectionWorker.catchUp();
  const shipment = await http.get('/api/shipment/SHP-API-2');
  assert.equal(shipment.body.shipment.currentState, 'AT_PORT');
  assert.equal(shipment.body.shipment.currentVersion, 4);
});

test('the events endpoint returns the raw chronological stream', async (t) => {
  const { system, http } = await withServer(t);
  await seedCanonicalShipment(system.container, 'SHP-API-3');

  const response = await http.get('/api/shipment/SHP-API-3/events');
  assert.equal(response.status, 200);
  assert.equal(response.body.eventCount, 4);
  assert.deepEqual(
    response.body.events.map((event) => event.eventType),
    ['CONTAINER_CREATED', 'LOADED_ON_SHIP', 'TEMPERATURE_SPIKE', 'ARRIVED_AT_PORT']
  );
  assert.ok(response.body.bounds.firstEventAt);
});

test('the historical-state endpoint reconstructs a past state', async (t) => {
  const { system, http } = await withServer(t);
  const seeded = await seedCanonicalShipment(system.container, 'SHP-API-4');
  const events = await system.eventStore.getEvents('SHP-API-4');

  const at = events[1].timestamp;
  const response = await http.get(`/api/shipment/SHP-API-4/state?at=${encodeURIComponent(at)}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.existedAt, true);
  assert.equal(response.body.state.currentState, 'IN_TRANSIT');
  assert.equal(seeded.arrived.version, 4);
});

test('an invalid timestamp on the historical endpoint returns 400', async (t) => {
  const { system, http } = await withServer(t);
  await seedCanonicalShipment(system.container, 'SHP-API-5');

  const response = await http.get('/api/shipment/SHP-API-5/state?at=tomorrow');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');

  assert.equal((await http.get('/api/shipment/SHP-API-5/state')).status, 400);
});

test('the sensor endpoint returns readings, markers and a summary', async (t) => {
  const { system, http } = await withServer(t);
  await seedCanonicalShipment(system.container, 'SHP-API-6');

  const response = await http.get('/api/shipment/SHP-API-6/sensors');
  assert.equal(response.status, 200);
  assert.equal(response.body.unit, 'celsius');
  assert.equal(response.body.summary.breachCount, 1);
  assert.equal(response.body.range.maxTemperatureC, 8);
});

test('a stale command over HTTP returns 409 with remediation detail', async (t) => {
  const { system, http } = await withServer(t);
  await seedCanonicalShipment(system.container, 'SHP-API-7');

  const response = await http.post('/api/shipment/temperature', {
    shipmentId: 'SHP-API-7',
    temperatureC: 5,
    expectedVersion: 2,
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'CONCURRENCY_CONFLICT');
  assert.equal(response.body.error.details.currentVersion, 4);
  assert.equal(response.body.error.details.applied, false);
  assert.ok(response.body.error.details.remediation);
});

test('an unknown shipment returns 404 on every query route', async (t) => {
  const { http } = await withServer(t);
  for (const path of [
    '/api/shipment/SHP-MISSING',
    '/api/shipment/SHP-MISSING/events',
    '/api/shipment/SHP-MISSING/sensors',
    '/api/shipment/SHP-MISSING/integrity',
    '/api/shipment/SHP-MISSING/state?at=2026-01-01T00:00:00.000Z',
  ]) {
    const response = await http.get(path);
    assert.equal(response.status, 404, `expected 404 for ${path}`);
    assert.equal(response.body.error.code, 'AGGREGATE_NOT_FOUND');
  }
});

test('malformed JSON returns a clean 400 rather than a stack trace', async (t) => {
  const { http } = await withServer(t);
  const response = await http.raw('POST', '/api/shipment/create', '{"shipmentId": ');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'MALFORMED_JSON');
  assert.equal(response.raw.includes('at Object'), false, 'no stack trace may leak to the client');
});

test('a missing required field returns a 400 listing every problem', async (t) => {
  const { http } = await withServer(t);
  const response = await http.post('/api/shipment/create', { shipmentId: 'SHP-API-8' });
  assert.equal(response.status, 400);
  assert.ok(response.body.error.details.issues.length >= 3);
});

test('a domain rule violation returns 409, distinct from a concurrency conflict', async (t) => {
  const { http } = await withServer(t);
  const created = await http.post('/api/shipment/create', {
    shipmentId: 'SHP-API-9',
    containerCode: 'C',
    estimatedDurationDays: 21,
    origin: 'A',
    destination: 'B',
  });

  const response = await http.post('/api/shipment/move', {
    shipmentId: 'SHP-API-9',
    movementType: 'ARRIVE_AT_PORT',
    location: 'B',
    portName: 'B',
    expectedVersion: created.body.version,
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'DOMAIN_RULE_VIOLATION');
});

test('the integrity endpoint reports an intact chain', async (t) => {
  const { system, http } = await withServer(t);
  await seedCanonicalShipment(system.container, 'SHP-API-10');

  const response = await http.get('/api/shipment/SHP-API-10/integrity');
  assert.equal(response.status, 200);
  assert.equal(response.body.intact, true);
  assert.equal(response.body.eventCount, 4);
});

test('the shipments list is paginated and searchable', async (t) => {
  const { system, http } = await withServer(t);
  await seedCanonicalShipment(system.container, 'SHP-LIST-1');
  await seedCanonicalShipment(system.container, 'SHP-LIST-2');
  await system.projectionWorker.catchUp();

  const all = await http.get('/api/shipments');
  assert.equal(all.body.pagination.total, 2);

  const filtered = await http.get('/api/shipments?search=LIST-1');
  assert.equal(filtered.body.items.length, 1);

  const paged = await http.get('/api/shipments?page=1&pageSize=1');
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.pagination.totalPages, 2);
});

test('every response carries a correlation id for tracing', async (t) => {
  const { http } = await withServer(t);
  const response = await http.get('/api/shipments');
  assert.ok(response.headers.get('x-correlation-id'));
});

test('the event catalog is served from the same constants the reducer uses', async (t) => {
  const { http } = await withServer(t);
  const response = await http.get('/api/meta/event-catalog');
  assert.equal(response.status, 200);
  assert.equal(response.body.eventTypes.CONTAINER_CREATED, 'CONTAINER_CREATED');
  assert.equal(response.body.catalog.TEMPERATURE_SPIKE.origin, 'source');
  assert.ok(response.body.temperaturePolicy.thresholdSource);
});

test('the worker status endpoint exposes projection lag', async (t) => {
  const { system, http } = await withServer(t);
  await seedCanonicalShipment(system.container, 'SHP-API-11');

  const behind = await http.get('/api/meta/worker');
  assert.ok(behind.body.lag.behindBy > 0);

  await system.projectionWorker.catchUp();
  const caughtUp = await http.get('/api/meta/worker');
  assert.equal(caughtUp.body.lag.behindBy, 0);
});
