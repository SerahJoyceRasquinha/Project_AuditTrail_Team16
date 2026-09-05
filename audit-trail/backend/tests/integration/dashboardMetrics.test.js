import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, startHttp } from '../helpers/testSystem.js';
import { SHIPMENT_STATES } from '../../src/domain/shipment/events/eventTypes.js';

/**
 * Dashboard metrics.
 *
 * Every test in this file corresponds to a defect found by driving the running
 * system rather than by reading the code, and every one of them passed the
 * existing suite while the dashboard was reporting wrong numbers. The three
 * faults were:
 *
 *  1. `byState` was a hand-written literal listing three of the four states, so
 *     delivered (UNLOADED) shipments were counted in the total and then dropped
 *     from the breakdown - the buckets never summed to the total.
 *  2. The handler asked for `pageSize: 10000`, which `list()` silently clamps to
 *     `limits.maxShipmentsPerPage`, so every figure was computed over at most
 *     100 shipments while claiming to describe the whole fleet.
 *  3. The list was fetched with `view: 'active'` and then filtered by
 *     `!archived`, so `activeShipments` could never differ from
 *     `totalShipments`, and archiving a shipment made the headline total shrink.
 *
 * The assertions below are deliberately about invariants ("the buckets sum to
 * the total") rather than about specific numbers, so they keep their meaning if
 * the fixtures change.
 */

async function withServer(t) {
  const system = await createTestSystem();
  const http = await startHttp(system.app);
  t.after(async () => {
    await http.close();
    await system.teardown();
  });
  return { system, http };
}

let sequence = 0;
function containerCode() {
  sequence += 1;
  return `TEST${String(sequence).padStart(7, '0')}`;
}

async function createShipment(http, overrides = {}) {
  const response = await http.post('/api/shipment/create', {
    containerCode: containerCode(),
    estimatedDurationDays: 10,
    origin: { city: 'Chennai', countryCode: 'IN', stateCode: 'TN' },
    destination: { city: 'Rotterdam', countryCode: 'NL', stateCode: 'ZH' },
    description: 'Test cargo',
    ...overrides,
  });
  assert.equal(response.status, 201);
  return response.body.aggregateId;
}

/** Drives a shipment all the way to UNLOADED, returning its id. */
async function deliverShipment(http) {
  const id = await createShipment(http);
  await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Test',
    expectedVersion: 1,
  });
  await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'ARRIVE_AT_PORT',
    location: 'Rotterdam',
    portName: 'Port of Rotterdam',
    expectedVersion: 2,
  });
  await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'UNLOAD_FROM_SHIP',
    location: 'Rotterdam',
    expectedVersion: 3,
  });
  return id;
}

const metricsOf = async (system, http) => {
  await system.projectionWorker.catchUp();
  const response = await http.get('/api/meta/dashboard-metrics');
  assert.equal(response.status, 200);
  return response.body;
};

const sumStates = (byState) => Object.values(byState).reduce((total, count) => total + count, 0);

// --- 1. byState covers every state in the domain -----------------------------

test('the state breakdown has a bucket for every state the domain defines', async (t) => {
  const { system, http } = await withServer(t);
  await createShipment(http);

  const metrics = await metricsOf(system, http);

  assert.deepEqual(
    Object.keys(metrics.byState).sort(),
    Object.values(SHIPMENT_STATES).slice().sort(),
    'the breakdown must be derived from SHIPMENT_STATES, not from a hand-written subset'
  );
});

test('a delivered shipment is counted in the breakdown, not silently dropped', async (t) => {
  const { system, http } = await withServer(t);
  await deliverShipment(http);

  const metrics = await metricsOf(system, http);

  assert.equal(metrics.byState.UNLOADED, 1);
  assert.equal(
    sumStates(metrics.byState),
    metrics.totalShipments,
    'the buckets must account for every shipment in the total'
  );
});

test('the state buckets sum to the total across a mixed fleet', async (t) => {
  const { system, http } = await withServer(t);

  await createShipment(http); // CREATED
  const inTransit = await createShipment(http);
  await http.post('/api/shipment/move', {
    shipmentId: inTransit,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Test',
    expectedVersion: 1,
  });
  await deliverShipment(http); // UNLOADED

  const metrics = await metricsOf(system, http);

  assert.equal(metrics.totalShipments, 3);
  assert.equal(sumStates(metrics.byState), 3);
  assert.equal(metrics.byState.CREATED, 1);
  assert.equal(metrics.byState.IN_TRANSIT, 1);
  assert.equal(metrics.byState.UNLOADED, 1);
});

// --- 2. no silent truncation at the page limit -------------------------------

test('metrics cover every shipment, not just one page of the read model', async (t) => {
  const { system, http } = await withServer(t);

  // Deliberately more than `limits.maxShipmentsPerPage` (100), which is the
  // ceiling the old single-call fetch was silently clamped to.
  const count = system.config.limits.maxShipmentsPerPage + 15;
  for (let i = 0; i < count; i += 1) {
    await createShipment(http);
  }

  const metrics = await metricsOf(system, http);
  const listed = await http.get('/api/shipments?view=all&pageSize=1');

  assert.equal(listed.body.pagination.total, count);
  assert.equal(
    metrics.totalShipments,
    count,
    'the total must reflect the whole read model, not the first page of it'
  );
  assert.equal(sumStates(metrics.byState), count);
});

// --- 3. archived shipments are partitioned, not erased -----------------------

test('archiving moves a shipment from active to archived without changing the total', async (t) => {
  const { system, http } = await withServer(t);

  await createShipment(http);
  const doomed = await createShipment(http);

  const before = await metricsOf(system, http);
  assert.equal(before.totalShipments, 2);
  assert.equal(before.activeShipments, 2);
  assert.equal(before.archivedShipments, 0);

  const archived = await http.post('/api/shipment/archive', {
    shipmentId: doomed,
    reason: 'closed out after customs clearance',
    expectedVersion: 1,
  });
  assert.equal(archived.status, 200);

  const after = await metricsOf(system, http);

  assert.equal(after.totalShipments, 2, 'archiving files a shipment away; it does not delete it');
  assert.equal(after.activeShipments, 1);
  assert.equal(after.archivedShipments, 1);
});

test('the active and archived counts always partition the total', async (t) => {
  const { system, http } = await withServer(t);

  await createShipment(http);
  await createShipment(http);
  const doomed = await createShipment(http);
  await http.post('/api/shipment/archive', {
    shipmentId: doomed,
    reason: 'closed out after customs clearance',
    expectedVersion: 1,
  });

  const metrics = await metricsOf(system, http);

  assert.equal(metrics.activeShipments + metrics.archivedShipments, metrics.totalShipments);
  assert.notEqual(
    metrics.activeShipments,
    metrics.totalShipments,
    'active must be able to differ from the total, or it is not measuring anything'
  );
});

test('a restored shipment returns to the active count', async (t) => {
  const { system, http } = await withServer(t);

  const id = await createShipment(http);
  await http.post('/api/shipment/archive', {
    shipmentId: id,
    reason: 'closed out after customs clearance',
    expectedVersion: 1,
  });
  await http.post('/api/shipment/restore', {
    shipmentId: id,
    reason: 'reopened for a customs query',
    expectedVersion: 2,
  });

  const metrics = await metricsOf(system, http);

  assert.equal(metrics.totalShipments, 1);
  assert.equal(metrics.activeShipments, 1);
  assert.equal(metrics.archivedShipments, 0);
});

// --- breach figures still behave -------------------------------------------

test('a breach on an archived shipment is still counted, because it still happened', async (t) => {
  const { system, http } = await withServer(t);

  const id = await createShipment(http, { minTemperatureC: 2, maxTemperatureC: 8 });
  const spike = await http.post('/api/shipment/temperature', {
    shipmentId: id,
    temperatureC: 19.5,
    expectedVersion: 1,
  });
  assert.equal(spike.body.eventType, 'TEMPERATURE_SPIKE');

  await http.post('/api/shipment/archive', {
    shipmentId: id,
    reason: 'filed after the excursion was investigated',
    expectedVersion: 2,
  });

  const metrics = await metricsOf(system, http);

  assert.equal(metrics.withBreaches, 1);
  assert.equal(metrics.totalBreaches, 1);
  assert.equal(metrics.overallTemperatureCompliance, 0);
});

test('a shipment with no declared thresholds cannot breach', async (t) => {
  const { system, http } = await withServer(t);

  const id = await createShipment(http);
  const reading = await http.post('/api/shipment/temperature', {
    shipmentId: id,
    temperatureC: 19.5,
    expectedVersion: 1,
  });

  assert.equal(reading.body.eventType, 'TEMPERATURE_RECORDED');

  const metrics = await metricsOf(system, http);
  assert.equal(metrics.withBreaches, 0);
  assert.equal(metrics.overallTemperatureCompliance, 100);
});
