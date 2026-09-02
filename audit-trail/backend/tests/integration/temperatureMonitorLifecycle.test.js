import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createTestSystem, startHttp } from '../helpers/testSystem.js';
import { EVENT_TYPES } from '../../src/domain/shipment/events/eventTypes.js';
import { TemperatureMonitorService } from '../../src/application/services/temperatureMonitorService.js';
import { SimulatedSensorProvider } from '../../src/infrastructure/sensors/sensorGateway.js';
import { ShipmentEventBus } from '../../src/infrastructure/realtime/shipmentEventBus.js';
import { silentLogger } from '../../src/shared/logging/logger.js';

/**
 * The monitoring lifecycle.
 *
 * The file above this one asserts what gets recorded. This one asserts *when
 * monitoring runs at all*: that creating a shipment starts it, that completing
 * one stops it, and that none of the ways this system is routinely disturbed -
 * a repeated notification, a reconnecting client, a restarted backend - can
 * leave two jobs sampling one container.
 *
 * Timing is asserted two ways on purpose. Most tests drive `sweep({ now })`
 * with a fabricated instant, because a test that waits a real minute is a test
 * nobody runs. One test uses a genuinely short delay and real timers, because
 * the scheduling path is the thing being claimed and stubbing it would leave
 * the claim untested.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;

async function withSystem(t) {
  const system = await createTestSystem();
  t.after(() => system.teardown());
  return system;
}

function monitorFor(system, { firstReadingDelayMs = MINUTE, intervalMs = HOUR, eventBus = null } = {}) {
  const monitor = new TemperatureMonitorService({
    eventStore: system.eventStore,
    shipmentCommandService: system.shipmentCommandService,
    sensorProvider: new SimulatedSensorProvider(),
    logger: silentLogger,
    eventBus,
    config: {
      ...system.config,
      sensors: { ...system.config.sensors, enabled: true, firstReadingDelayMs, intervalMs },
    },
  });
  return monitor;
}

async function createShipment(system, { occurredAt } = {}) {
  return system.shipmentCommandService.createShipment({
    shipmentId: null,
    containerCode: 'MSKU7654321',
    origin: 'Chennai, Tamil Nadu, India',
    destination: 'Rotterdam, South Holland, Netherlands',
    estimatedDurationDays: 18,
    minTemperatureC: 2,
    maxTemperatureC: 8,
    ...(occurredAt ? { occurredAt } : {}),
  });
}

function readingsOf(events) {
  return events.filter((event) =>
    [EVENT_TYPES.TEMPERATURE_RECORDED, EVENT_TYPES.TEMPERATURE_SPIKE].includes(event.eventType)
  );
}

// ---------------------------------------------------------------------------
// Creation starts monitoring
// ---------------------------------------------------------------------------

test('creating a shipment puts it under monitoring, with no manual start', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);
  t.after(() => monitor.stop());

  const created = await createShipment(system);
  const outcome = await monitor.registerShipment(created.aggregateId);

  assert.equal(outcome.registered, true);
  assert.deepEqual(monitor.monitoredShipmentIds, [created.aggregateId]);

  // Scheduled for one delay after creation - not for whenever the process
  // happened to notice it.
  assert.equal(Date.parse(outcome.dueAt) - Date.parse(created.timestamp), MINUTE);
});

test('a shipment created through the API is adopted from the notification bus', async (t) => {
  const system = await withSystem(t);
  const eventBus = new ShipmentEventBus({ logger: silentLogger });
  const monitor = monitorFor(system, { eventBus });
  t.after(() => monitor.stop());

  await monitor.start();

  const created = await createShipment(system);
  // Exactly what the projection worker publishes once the projection commits.
  await monitor.handleNotification({
    aggregateId: created.aggregateId,
    eventType: EVENT_TYPES.CONTAINER_CREATED,
    version: created.version,
  });

  assert.deepEqual(monitor.monitoredShipmentIds, [created.aggregateId]);
});

test('no reading is taken before the delay has elapsed, and one is taken after', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);
  t.after(() => monitor.stop());

  const created = await createShipment(system);
  const createdAt = Date.parse(created.timestamp);

  // Half a minute in: the instrument has not reported yet, and nothing is
  // invented to fill the gap.
  await monitor.sweep({ now: new Date(createdAt + MINUTE / 2) });
  assert.equal(readingsOf(await system.eventStore.getEvents(created.aggregateId)).length, 0);

  // Just past the minute: exactly one observation, stamped at the minute mark.
  await monitor.sweep({ now: new Date(createdAt + MINUTE + 1000) });
  const readings = readingsOf(await system.eventStore.getEvents(created.aggregateId));

  assert.equal(readings.length, 1);
  assert.equal(Date.parse(readings[0].payload.recordedAt) - createdAt, MINUTE);
  assert.equal(readings[0].aggregateId, created.aggregateId, 'the reading belongs to the shipment that was sampled');
  assert.equal(readings[0].payload.source, 'SIMULATED');
  assert.ok(readings[0].payload.sensorId, 'every reading names the instrument it came from');
});

test('the first reading is taken by the scheduler itself, without a sweep', async (t) => {
  const system = await withSystem(t);
  // A short delay so the scheduling path can be exercised for real rather than
  // simulated with a fabricated clock.
  const monitor = monitorFor(system, { firstReadingDelayMs: 60 });
  t.after(() => monitor.stop());

  const created = await createShipment(system);
  await monitor.registerShipment(created.aggregateId);

  assert.equal(readingsOf(await system.eventStore.getEvents(created.aggregateId)).length, 0);

  await delay(400);

  const readings = readingsOf(await system.eventStore.getEvents(created.aggregateId));
  assert.equal(readings.length, 1, 'the scheduled timer should have recorded the first reading on its own');
});

test('later readings follow hourly, each one an hour after the last', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);
  t.after(() => monitor.stop());

  const created = await createShipment(system);
  const createdAt = Date.parse(created.timestamp);

  await monitor.sweep({ now: new Date(createdAt + MINUTE + 1000) });
  await monitor.sweep({ now: new Date(createdAt + MINUTE + 3 * HOUR) });

  const readings = readingsOf(await system.eventStore.getEvents(created.aggregateId));
  assert.equal(readings.length, 4, 'the first reading plus one for each elapsed hour');

  for (let index = 1; index < readings.length; index += 1) {
    assert.equal(
      Date.parse(readings[index].payload.recordedAt) - Date.parse(readings[index - 1].payload.recordedAt),
      HOUR
    );
  }
});

// ---------------------------------------------------------------------------
// Duplicate prevention (requirement 10)
// ---------------------------------------------------------------------------

test('registering the same shipment repeatedly never creates a second timer', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);
  t.after(() => monitor.stop());

  const created = await createShipment(system);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await monitor.registerShipment(created.aggregateId);
  }

  assert.equal(monitor.monitoredShipmentIds.length, 1);
  assert.equal(
    monitor.stats.scheduledReadings.filter((entry) => entry.aggregateId === created.aggregateId).length,
    1,
    'one shipment, one scheduled reading'
  );
  assert.ok(monitor.stats.duplicateRegistrationsIgnored >= 4);
});

test('a repeated creation notification does not produce a duplicate reading', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);
  t.after(() => monitor.stop());

  const created = await createShipment(system);
  const at = new Date(Date.parse(created.timestamp) + MINUTE + 1000);

  const notification = {
    aggregateId: created.aggregateId,
    eventType: EVENT_TYPES.CONTAINER_CREATED,
    version: 1,
  };

  // At-least-once delivery: the same notification arrives three times.
  await monitor.handleNotification(notification);
  await monitor.handleNotification(notification);
  await monitor.handleNotification(notification);

  await monitor.sweep({ now: at });
  await monitor.sweep({ now: at });

  assert.equal(readingsOf(await system.eventStore.getEvents(created.aggregateId)).length, 1);
});

test('two monitors over one store cannot double-record a slot', async (t) => {
  const system = await withSystem(t);
  // Two processes against one Event Store, which is what a restart overlapping
  // its predecessor looks like.
  const first = monitorFor(system);
  const second = monitorFor(system);
  t.after(() => Promise.all([first.stop(), second.stop()]));

  const created = await createShipment(system);
  const at = new Date(Date.parse(created.timestamp) + MINUTE + 2 * HOUR);

  await Promise.all([first.sweep({ now: at }), second.sweep({ now: at })]);
  await first.sweep({ now: at });
  await second.sweep({ now: at });

  const readings = readingsOf(await system.eventStore.getEvents(created.aggregateId));
  const instants = readings.map((reading) => reading.payload.recordedAt);

  assert.equal(new Set(instants).size, instants.length, 'no observation instant may appear twice');
  assert.equal(readings.length, 3, 'the first reading plus two hourly ones, recorded once each');
});

// ---------------------------------------------------------------------------
// Stopping (requirements 6 and 10)
// ---------------------------------------------------------------------------

test('monitoring stops when the shipment reaches its completed state', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);
  t.after(() => monitor.stop());

  const created = await createShipment(system);
  await monitor.registerShipment(created.aggregateId);
  assert.equal(monitor.monitoredShipmentIds.length, 1);

  const svc = system.shipmentCommandService;
  const loaded = await svc.moveShipment({
    shipmentId: created.aggregateId,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Test',
    expectedVersion: created.version,
  });
  const arrived = await svc.moveShipment({
    shipmentId: created.aggregateId,
    movementType: 'ARRIVE_AT_PORT',
    location: 'Rotterdam',
    portName: 'Port of Rotterdam',
    expectedVersion: loaded.version,
  });
  const unloaded = await svc.moveShipment({
    shipmentId: created.aggregateId,
    movementType: 'UNLOAD_FROM_SHIP',
    location: 'Rotterdam Yard',
    expectedVersion: arrived.version,
  });

  await monitor.handleNotification({
    aggregateId: created.aggregateId,
    eventType: EVENT_TYPES.UNLOADED_FROM_SHIP,
    version: unloaded.version,
  });

  assert.deepEqual(monitor.monitoredShipmentIds, [], 'a delivered shipment holds no timer');

  const before = (await system.eventStore.getEvents(created.aggregateId)).length;
  await monitor.sweep({ now: new Date(Date.now() + 5 * HOUR) });
  const after = (await system.eventStore.getEvents(created.aggregateId)).length;
  assert.equal(after, before, 'and it is not sampled by the sweep either');
});

test('monitoring stops when the shipment is archived, and resumes if it is restored', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);
  t.after(() => monitor.stop());

  const created = await createShipment(system);
  await monitor.registerShipment(created.aggregateId);

  const archived = await system.shipmentCommandService.archiveShipment({
    shipmentId: created.aggregateId,
    expectedVersion: created.version,
  });
  await monitor.handleNotification({
    aggregateId: created.aggregateId,
    eventType: EVENT_TYPES.SHIPMENT_ARCHIVED,
    version: archived.version,
  });
  assert.deepEqual(monitor.monitoredShipmentIds, []);

  const restored = await system.shipmentCommandService.restoreShipment({
    shipmentId: created.aggregateId,
    expectedVersion: archived.version,
  });
  await monitor.handleNotification({
    aggregateId: created.aggregateId,
    eventType: EVENT_TYPES.SHIPMENT_RESTORED,
    version: restored.version,
  });
  assert.deepEqual(monitor.monitoredShipmentIds, [created.aggregateId]);
});

test('stopping the monitor abandons no timers', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);

  const first = await createShipment(system);
  const second = await createShipment(system);
  await monitor.registerShipment(first.aggregateId);
  await monitor.registerShipment(second.aggregateId);
  assert.equal(monitor.stats.scheduledReadings.length, 2);

  await monitor.stop();

  assert.equal(monitor.stats.scheduledReadings.length, 0, 'every timer is cleared on shutdown');
});

// ---------------------------------------------------------------------------
// Restart / resume (requirement 13)
// ---------------------------------------------------------------------------

test('a restart resumes active shipments and skips completed ones', async (t) => {
  const system = await withSystem(t);
  const svc = system.shipmentCommandService;

  const active = await createShipment(system);
  const finished = await createShipment(system);

  const loaded = await svc.moveShipment({
    shipmentId: finished.aggregateId,
    movementType: 'LOAD_ON_SHIP',
    location: 'A',
    vesselName: 'V',
    expectedVersion: finished.version,
  });
  const arrived = await svc.moveShipment({
    shipmentId: finished.aggregateId,
    movementType: 'ARRIVE_AT_PORT',
    location: 'B',
    portName: 'P',
    expectedVersion: loaded.version,
  });
  await svc.moveShipment({
    shipmentId: finished.aggregateId,
    movementType: 'UNLOAD_FROM_SHIP',
    location: 'C',
    expectedVersion: arrived.version,
  });

  // A fresh monitor, as a restarted process would build.
  const restarted = monitorFor(system);
  t.after(() => restarted.stop());
  const outcome = await restarted.resumeActiveShipments();

  assert.equal(outcome.resumed, 1);
  assert.deepEqual(restarted.monitoredShipmentIds, [active.aggregateId]);
});

test('resuming after a restart does not re-record readings already on the stream', async (t) => {
  const system = await withSystem(t);
  const created = await createShipment(system);
  const at = new Date(Date.parse(created.timestamp) + MINUTE + 2 * HOUR);

  const before = monitorFor(system);
  await before.sweep({ now: at });
  const recordedBefore = readingsOf(await system.eventStore.getEvents(created.aggregateId));
  await before.stop();

  // The process dies and comes back. Its schedule is recomputed from the
  // stream, so the readings it already took are simply not due again.
  const after = monitorFor(system);
  t.after(() => after.stop());
  await after.resumeActiveShipments();
  await after.sweep({ now: at });

  const recordedAfter = readingsOf(await system.eventStore.getEvents(created.aggregateId));
  assert.equal(recordedAfter.length, recordedBefore.length);
  assert.deepEqual(
    recordedAfter.map((event) => event.payload.recordedAt),
    recordedBefore.map((event) => event.payload.recordedAt)
  );
});

// ---------------------------------------------------------------------------
// Event sourcing and realtime propagation (requirements 7 and 8)
// ---------------------------------------------------------------------------

test('an automatic reading is an ordinary event in the shipment history', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);
  t.after(() => monitor.stop());

  const created = await createShipment(system);
  await monitor.sweep({ now: new Date(Date.parse(created.timestamp) + MINUTE + 1000) });

  const events = await system.eventStore.getEvents(created.aggregateId);
  const reading = readingsOf(events)[0];

  // Identity, time, value and provenance - everything an auditor needs.
  assert.equal(reading.aggregateId, created.aggregateId);
  assert.equal(reading.version, 2, 'it takes the next version in the stream, like any other event');
  assert.equal(typeof reading.payload.temperatureC, 'number');
  assert.ok(reading.payload.recordedAt);
  assert.ok(reading.timestamp);
  assert.ok(reading.hash, 'and it joins the hash chain');

  // The chain still verifies, so the addition has not disturbed history.
  const integrity = await system.eventStore.verifyChain(created.aggregateId);
  assert.equal(integrity.intact, true);
});

test('automatic readings survive a full replay of the stream', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);
  t.after(() => monitor.stop());

  const created = await createShipment(system);
  await monitor.sweep({ now: new Date(Date.parse(created.timestamp) + MINUTE + 3 * HOUR) });

  const replayed = await system.replayService.reconstructCurrentState(created.aggregateId);
  const expected = readingsOf(await system.eventStore.getEvents(created.aggregateId)).length;

  assert.equal(replayed.state.temperatureReadingCount, expected);
  assert.ok(replayed.state.latestTemperatureC !== null);
});

test('a recorded reading is published to the realtime stream and reaches the read model', async (t) => {
  const system = await withSystem(t);
  const monitor = monitorFor(system);
  t.after(() => monitor.stop());

  const notifications = [];
  system.eventBus.subscribe((notification) => notifications.push(notification));

  const created = await createShipment(system);
  await monitor.sweep({ now: new Date(Date.parse(created.timestamp) + MINUTE + 1000) });

  // The projection worker is what publishes, after it has committed - so the
  // browser's refetch always finds a read model that can serve it.
  await system.projectionWorker.catchUp();

  const temperatureNotifications = notifications.filter((notification) =>
    [EVENT_TYPES.TEMPERATURE_RECORDED, EVENT_TYPES.TEMPERATURE_SPIKE].includes(notification.eventType)
  );

  assert.ok(temperatureNotifications.length > 0, 'a new reading must be announced on the realtime bus');
  assert.equal(temperatureNotifications[0].aggregateId, created.aggregateId);

  const projected = await system.readModelRepository.findById(created.aggregateId);
  assert.ok(projected.latestTemperatureAt, 'and the read model carries the latest reading');
});

test('the chart endpoint serves the automatic readings for a newly created shipment', async (t) => {
  const system = await withSystem(t);
  const http = await startHttp(system.app);
  const monitor = monitorFor(system);
  t.after(async () => {
    await monitor.stop();
    await http.close();
  });

  const created = await createShipment(system);
  await monitor.sweep({ now: new Date(Date.parse(created.timestamp) + MINUTE + 2 * HOUR) });

  const series = await http.get(`/api/shipment/${created.aggregateId}/sensors`);

  assert.equal(series.status, 200);
  assert.equal(series.body.readings.length, 3);
  assert.equal(series.body.unit, 'celsius');
  assert.ok(series.body.readings.every((reading) => reading.source === 'SIMULATED'));
  assert.ok(series.body.summary.firstReadingAt);
});

test('the sensor meta endpoint reports what is being monitored', async (t) => {
  const system = await withSystem(t);
  const http = await startHttp(system.app);
  t.after(() => http.close());

  const response = await http.get('/api/meta/sensors');

  assert.equal(response.status, 200);
  assert.equal(response.body.dataIsSimulated, true, 'simulated data must be declared as simulated');
  assert.ok(Array.isArray(response.body.monitor.monitoredShipmentIds));
  assert.equal(typeof response.body.monitor.firstReadingDelayMs, 'number');
});
