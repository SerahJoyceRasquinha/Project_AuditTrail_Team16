import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestSystem, startHttp } from '../helpers/testSystem.js';
import { EVENT_TYPES } from '../../src/domain/shipment/events/eventTypes.js';
import { TemperatureMonitorService } from '../../src/application/services/temperatureMonitorService.js';
import {
  SimulatedSensorProvider,
  NullSensorProvider,
} from '../../src/infrastructure/sensors/sensorGateway.js';
import { buildShipmentReport } from '../../src/application/queries/shipmentReport.js';
import { silentLogger } from '../../src/shared/logging/logger.js';

const HOUR = 3_600_000;

async function withSystem(t) {
  const system = await createTestSystem();
  t.after(() => system.teardown());
  return system;
}

function monitorFor(system, { provider, intervalMs = HOUR, maxCatchUpReadings = 48 } = {}) {
  return new TemperatureMonitorService({
    eventStore: system.eventStore,
    shipmentCommandService: system.shipmentCommandService,
    sensorProvider: provider ?? new SimulatedSensorProvider(),
    logger: silentLogger,
    config: {
      ...system.config,
      sensors: { ...system.config.sensors, intervalMs, maxCatchUpReadings },
    },
  });
}

/** A shipment whose creation is backdated, so hourly slots are already due. */
async function shipmentCreatedHoursAgo(system, hours, overrides = {}) {
  const occurredAt = new Date(Date.now() - hours * HOUR).toISOString();
  const created = await system.shipmentCommandService.createShipment({
    shipmentId: null,
    containerCode: 'MSKU9000001',
    origin: 'Chennai, Tamil Nadu, India',
    destination: 'Rotterdam, South Holland, Netherlands',
    estimatedDurationDays: 20,
    minTemperatureC: 2,
    maxTemperatureC: 8,
    occurredAt,
    ...overrides,
  });
  return created;
}

// ---------------------------------------------------------------------------
// Automatic hourly monitoring (requirement 6)
// ---------------------------------------------------------------------------

test('the monitor records readings automatically, with no operator input', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 5);

  const monitor = monitorFor(system);
  const result = await monitor.sweep();

  assert.ok(result.recorded > 0, 'the sweep should record readings without anyone entering one');

  const events = await system.eventStore.getEvents(created.aggregateId);
  const readings = events.filter((event) =>
    [EVENT_TYPES.TEMPERATURE_RECORDED, EVENT_TYPES.TEMPERATURE_SPIKE].includes(event.eventType)
  );
  assert.ok(readings.length > 0);
});

test('readings land on hourly boundaries', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 6);
  await monitorFor(system).sweep();

  const events = await system.eventStore.getEvents(created.aggregateId);
  const readings = events.filter((event) =>
    [EVENT_TYPES.TEMPERATURE_RECORDED, EVENT_TYPES.TEMPERATURE_SPIKE].includes(event.eventType)
  );

  for (const reading of readings) {
    assert.equal(
      Date.parse(reading.payload.recordedAt) % HOUR,
      0,
      'each observation should sit on an hour boundary'
    );
  }
});

test('every automatic reading is permanently labelled as simulated', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 4);
  await monitorFor(system).sweep();

  const events = await system.eventStore.getEvents(created.aggregateId);
  const readings = events.filter((event) =>
    [EVENT_TYPES.TEMPERATURE_RECORDED, EVENT_TYPES.TEMPERATURE_SPIKE].includes(event.eventType)
  );

  // Invented data must never be able to pass itself off as measurement.
  assert.ok(readings.length > 0);
  assert.ok(readings.every((reading) => reading.payload.source === 'SIMULATED'));
});

test('with no sensor source configured, nothing is fabricated', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 8);

  const monitor = monitorFor(system, { provider: new NullSensorProvider() });
  const result = await monitor.sweep();

  assert.equal(result.recorded, 0);
  const events = await system.eventStore.getEvents(created.aggregateId);
  assert.equal(events.length, 1, 'only the creation event should exist');
});

test('a second sweep does not duplicate readings for slots already recorded', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 5);
  const monitor = monitorFor(system);

  await monitor.sweep();
  const afterFirst = (await system.eventStore.getEvents(created.aggregateId)).length;
  await monitor.sweep();
  const afterSecond = (await system.eventStore.getEvents(created.aggregateId)).length;

  assert.equal(afterFirst, afterSecond, 're-sweeping must not re-record the same hours');
});

test('one reading produces exactly one event, so an alert is never duplicated', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 4);

  // The simulator tracks whatever range is declared, so a breach is forced by
  // turning the excursion rate up rather than by declaring an odd range.
  await monitorFor(system, { provider: new SimulatedSensorProvider({ excursionChance: 1 }) }).sweep();
  const events = await system.eventStore.getEvents(created.aggregateId);

  const spikes = events.filter((event) => event.eventType === EVENT_TYPES.TEMPERATURE_SPIKE);
  const recorded = events.filter((event) => event.eventType === EVENT_TYPES.TEMPERATURE_RECORDED);

  assert.ok(spikes.length > 0, 'out-of-range readings must raise alerts');
  assert.equal(recorded.length, 0);

  // No two alerts may describe the same observation instant.
  const instants = spikes.map((spike) => spike.payload.recordedAt);
  assert.equal(new Set(instants).size, instants.length);
});

test('a breach is recorded as an immutable alert event, not a mutable flag', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 3);
  await monitorFor(system, { provider: new SimulatedSensorProvider({ excursionChance: 1 }) }).sweep();

  const events = await system.eventStore.getEvents(created.aggregateId);
  const spike = events.find((event) => event.eventType === EVENT_TYPES.TEMPERATURE_SPIKE);

  assert.ok(spike, 'the breach exists as its own event in the timeline');
  assert.ok(spike.payload.thresholdC !== undefined);
  assert.ok(spike.payload.direction);
  // The moment of the spike is answerable - the source document's core use case.
  assert.ok(spike.payload.recordedAt);
});

test('monitoring stops once the shipment has been unloaded', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 10);
  const svc = system.shipmentCommandService;
  const id = created.aggregateId;

  const loaded = await svc.moveShipment({
    shipmentId: id, movementType: 'LOAD_ON_SHIP', location: 'A', vesselName: 'V',
    expectedVersion: created.version,
  });
  const arrived = await svc.moveShipment({
    shipmentId: id, movementType: 'ARRIVE_AT_PORT', location: 'B', portName: 'P',
    expectedVersion: loaded.version,
  });
  await svc.moveShipment({
    shipmentId: id, movementType: 'UNLOAD_FROM_SHIP', location: 'C',
    expectedVersion: arrived.version,
  });

  const before = (await system.eventStore.getEvents(id)).length;
  const result = await monitorFor(system).sweep();
  const after = (await system.eventStore.getEvents(id)).length;

  assert.equal(result.recorded, 0);
  assert.equal(before, after, 'a delivered shipment is outside its monitoring window');
});

test('an archived shipment is not sampled', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 6);
  await system.shipmentCommandService.archiveShipment({
    shipmentId: created.aggregateId,
    expectedVersion: created.version,
  });

  const before = (await system.eventStore.getEvents(created.aggregateId)).length;
  await monitorFor(system).sweep();
  const after = (await system.eventStore.getEvents(created.aggregateId)).length;
  assert.equal(before, after);
});

test('catch-up after downtime is bounded so a restart cannot flood a stream', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 500);

  const monitor = monitorFor(system, { maxCatchUpReadings: 10 });
  const result = await monitor.sweep();

  assert.ok(result.recorded <= 10, 'catch-up must respect its ceiling');
});

test('the simulator is deterministic, so a demonstration is reproducible', async (t) => {
  const provider = new SimulatedSensorProvider();
  const args = {
    aggregateId: 'SHP-1',
    at: '2026-03-01T10:00:00.000Z',
    minTemperatureC: 2,
    maxTemperatureC: 8,
  };
  const a = await provider.read(args);
  const b = await provider.read(args);
  assert.equal(a.temperatureC, b.temperatureC);
});

test('automatic readings appear in the sensor series for the chart', async (t) => {
  const system = await withSystem(t);
  const http = await startHttp(system.app);
  t.after(() => http.close());

  const created = await shipmentCreatedHoursAgo(system, 5);
  await monitorFor(system).sweep();

  const series = await http.get(`/api/shipment/${created.aggregateId}/sensors`);
  assert.equal(series.status, 200);
  assert.ok(series.body.readings.length > 0);
  assert.equal(series.body.range.minTemperatureC, 2);
  assert.equal(series.body.range.maxTemperatureC, 8);
});

// ---------------------------------------------------------------------------
// Report model and export (requirement 1)
// ---------------------------------------------------------------------------

test('the report translates internal event types into business language', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 2);
  const events = await system.eventStore.getEvents(created.aggregateId);
  const integrity = await system.eventStore.verifyChain(created.aggregateId);

  const report = buildShipmentReport({ events, integrity });

  assert.equal(report.history[0].label, 'Shipment opened');
  // The internal type is retained alongside, because a dispute turns on it.
  assert.equal(report.history[0].eventType, 'CONTAINER_CREATED');
  assert.match(report.history[0].summary, /opened for carriage/i);
});

test('the report separates original estimate from current estimate', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 1);
  const id = created.aggregateId;

  const planned = await system.shipmentCommandService.planSchedule({
    shipmentId: id,
    schedule: {
      LOAD_ON_SHIP: { plannedDate: nextDays(created.timestamp, 2) },
      ARRIVE_AT_PORT: { plannedDate: nextDays(created.timestamp, 12) },
      UNLOAD_FROM_SHIP: { plannedDate: nextDays(created.timestamp, 14) },
    },
    expectedVersion: created.version,
  });

  await system.shipmentCommandService.extendSchedule({
    shipmentId: id,
    stage: 'UNLOAD_FROM_SHIP',
    extensionDays: 10,
    reason: 'Storm delay',
    expectedVersion: planned.version,
  });

  const events = await system.eventStore.getEvents(id);
  const report = buildShipmentReport({
    events,
    integrity: await system.eventStore.verifyChain(id),
  });

  assert.equal(report.duration.originalEstimateDays, 20);
  assert.ok(report.duration.currentEstimateDays > 20);
  assert.equal(report.duration.wasExtended, true);
  assert.equal(report.duration.totalExtensionDays, 10);
  // The change itself is itemised for the auditor.
  assert.equal(report.scheduleChanges.length, 2);
  assert.match(report.scheduleChanges[1].label, /Delay recorded/i);
});

test('the report marks simulated readings as not measured', async (t) => {
  const system = await withSystem(t);
  const created = await shipmentCreatedHoursAgo(system, 4);
  await monitorFor(system).sweep();

  const events = await system.eventStore.getEvents(created.aggregateId);
  const report = buildShipmentReport({
    events,
    integrity: await system.eventStore.verifyChain(created.aggregateId),
  });

  assert.ok(report.temperature.sources.includes('Simulated (not measured)'));
});

test('the report states that current status is reconstructed, not stored', async (t) => {
  const system = await withSystem(t);
  const http = await startHttp(system.app);
  t.after(() => http.close());

  const created = await shipmentCreatedHoursAgo(system, 1);
  const csv = await http.get(`/api/shipment/${created.aggregateId}/export?format=csv`);

  assert.equal(csv.status, 200);
  assert.match(csv.raw, /Reconstructed by replaying/i);
  assert.match(csv.raw, /not stored as editable state/i);
});

test('the PDF report is produced as a valid PDF stream', async (t) => {
  const system = await withSystem(t);
  const http = await startHttp(system.app);
  t.after(() => http.close());

  const created = await shipmentCreatedHoursAgo(system, 6);
  await monitorFor(system).sweep();

  const response = await http.get(`/api/shipment/${created.aggregateId}/export?format=pdf`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.ok(response.raw.startsWith('%PDF-'), 'the body should be a real PDF');
});

test('the PDF stays readable with a long history and many readings', async (t) => {
  const system = await withSystem(t);
  const http = await startHttp(system.app);
  t.after(() => http.close());

  // 300 hourly slots: enough to exercise pagination and the thinning rule.
  const created = await shipmentCreatedHoursAgo(system, 320);
  await monitorFor(system, { maxCatchUpReadings: 300 }).sweep();

  const events = await system.eventStore.getEvents(created.aggregateId);
  assert.ok(events.length > 100, 'the fixture should produce a genuinely long history');

  const response = await http.get(`/api/shipment/${created.aggregateId}/export?format=pdf`);
  assert.equal(response.status, 200);
  assert.ok(response.raw.startsWith('%PDF-'));
  assert.ok(response.raw.length > 5000, 'a long history should produce a substantial document');
});

function nextDays(from, days) {
  const date = new Date(from);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days))
    .toISOString()
    .slice(0, 10);
}
