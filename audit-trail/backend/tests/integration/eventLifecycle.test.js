import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestSystem, seedCanonicalShipment } from '../helpers/testSystem.js';
import { AggregateNotFoundError } from '../../src/shared/errors/AppError.js';

/**
 * The full lifecycle (roadmap 15.2):
 *
 *   Command -> Event Store -> Event -> Worker -> Projection -> Query
 *
 * These tests are the ones that would catch a break in the seam between two
 * layers that each pass their own unit tests.
 */

test('a command travels the whole pipeline and surfaces in the query side', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await system.commandHandlers.createShipmentCommandHandler.handle({
    shipmentId: 'SHP-FLOW',
    containerCode: 'MSKU9',
    origin: 'Chennai',
    destination: 'Rotterdam',
    minTemperatureC: 2,
    maxTemperatureC: 8,
  });

  const events = await system.eventStore.getEvents('SHP-FLOW');
  assert.equal(events.length, 1);

  await system.projectionWorker.catchUp();

  const result = await system.queryHandlers.getShipmentQueryHandler.handle({ shipmentId: 'SHP-FLOW' });
  assert.equal(result.shipment.currentState, 'CREATED');
  assert.equal(result.consistency.source, 'read-model');
  assert.equal(result.consistency.projected, true);
});

test('before the worker runs, the query side reports eventual-consistency lag honestly', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await seedCanonicalShipment(system.container, 'SHP-LAG');

  // The worker has deliberately not run. Roadmap 12.6: the API must not claim
  // the command failed, nor silently serve nothing.
  const result = await system.queryHandlers.getShipmentQueryHandler.handle({ shipmentId: 'SHP-LAG' });
  assert.equal(result.consistency.projected, false);
  assert.equal(result.consistency.source, 'event-store-replay');
  assert.equal(result.consistency.lagVersions, 4);
  // The data served is still correct, because it came from the authoritative store.
  assert.equal(result.shipment.currentState, 'AT_PORT');

  await system.projectionWorker.catchUp();
  const after = await system.queryHandlers.getShipmentQueryHandler.handle({ shipmentId: 'SHP-LAG' });
  assert.equal(after.consistency.projected, true);
  assert.equal(after.consistency.lagVersions, 0);
});

test('the projection matches a fresh replay of the same events', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await seedCanonicalShipment(system.container, 'SHP-MATCH');
  await system.projectionWorker.catchUp();

  const report = await system.reconciliationService.reconcileOne('SHP-MATCH');
  assert.equal(report.consistent, true, JSON.stringify(report.discrepancies));
});

test('processing the same events twice leaves the projection unchanged', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await seedCanonicalShipment(system.container, 'SHP-IDEM');
  await system.projectionWorker.catchUp();
  const first = await system.readModelRepository.findById('SHP-IDEM');

  // Rewind the checkpoint and reprocess the entire stream, simulating an
  // at-least-once redelivery.
  await system.checkpointRepository.reset(system.config.worker.name);
  await system.projectionWorker.catchUp();
  const second = await system.readModelRepository.findById('SHP-IDEM');

  assert.equal(second.currentVersion, first.currentVersion);
  assert.equal(second.temperatureBreachCount, first.temperatureBreachCount);
  assert.equal(second.currentState, first.currentState);
});

test('a worker restarting from a lost checkpoint converges to the same projection', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await seedCanonicalShipment(system.container, 'SHP-RESTART');
  await system.projectionWorker.catchUp();
  const expected = await system.readModelRepository.findById('SHP-RESTART');

  await system.readModelRepository.deleteAll();
  await system.checkpointRepository.reset(system.config.worker.name);
  await system.projectionWorker.catchUp();

  const rebuilt = await system.readModelRepository.findById('SHP-RESTART');
  assert.equal(rebuilt.currentVersion, expected.currentVersion);
  assert.equal(rebuilt.currentState, expected.currentState);
});

test('a version gap is healed from the Event Store rather than applied out of order', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await seedCanonicalShipment(system.container, 'SHP-GAP');

  // Project only the first event, then jump the checkpoint past events 2 and 3
  // so the worker next sees version 4 against a projection at version 1.
  const events = await system.eventStore.getEvents('SHP-GAP');
  await system.checkpointRepository.reset(system.config.worker.name);
  await system.checkpointRepository.save(system.config.worker.name, { lastSequence: events[0].sequence - 1 });
  await system.projectionWorker.runOnce();

  const healed = await system.readModelRepository.findById('SHP-GAP');
  assert.equal(healed.currentVersion, 4);
  // The breach from event 3 must be present: it would be missing if the worker
  // had simply applied version 4 on top of version 1.
  assert.equal(healed.temperatureBreachCount, 1);
  assert.equal(healed.currentState, 'AT_PORT');
});

test('a rebuild reproduces the read model exactly from history', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await seedCanonicalShipment(system.container, 'SHP-RB-1');
  await seedCanonicalShipment(system.container, 'SHP-RB-2');
  await system.projectionWorker.catchUp();

  const before = await system.readModelRepository.findById('SHP-RB-1');
  const { rebuilt } = await system.reconciliationService.rebuildAll();
  const after = await system.readModelRepository.findById('SHP-RB-1');

  assert.equal(rebuilt, 2);
  assert.equal(after.currentVersion, before.currentVersion);
  assert.equal(after.currentState, before.currentState);
});

test('reconciliation reports drift when the projection is corrupted', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await seedCanonicalShipment(system.container, 'SHP-DRIFT');
  await system.projectionWorker.catchUp();

  await system.db
    .collection('shipment_read_model')
    .updateOne({ aggregateId: 'SHP-DRIFT' }, { $set: { currentLocation: 'Nowhere' } });

  const report = await system.reconciliationService.reconcileOne('SHP-DRIFT');
  assert.equal(report.consistent, false);
  assert.ok(report.discrepancies.some((d) => d.field === 'currentLocation'));

  // The remedy is always to rebuild the derived data, never to touch history.
  await system.reconciliationService.rebuildAll();
  assert.equal((await system.reconciliationService.reconcileOne('SHP-DRIFT')).consistent, true);
});

test('querying an unknown shipment raises a not-found error', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await assert.rejects(
    () => system.queryHandlers.getShipmentQueryHandler.handle({ shipmentId: 'SHP-NOPE' }),
    AggregateNotFoundError
  );
});

test('the sensor series is derived from the same events as the timeline', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-SENSOR');
  const series = await system.sensorService.getTemperatureSeries(shipmentId);
  const events = await system.eventStore.getEvents(shipmentId);

  assert.equal(series.readings.length, 1);
  assert.equal(series.readings[0].isBreach, true);
  // Every point carries the eventId of the event it came from, which is what
  // lets the chart and the timeline highlight in lockstep without any
  // timestamp matching in the browser.
  const spike = events.find((event) => event.eventType === 'TEMPERATURE_SPIKE');
  assert.equal(series.readings[0].eventId, spike.eventId);
  assert.equal(series.markers.length, 3);
});

test('occurredAt records when an event happened, not when it was written', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  // Backfilling: the whole history happened days ago, but is being imported now.
  const created = await system.shipmentCommandService.createShipment({
    occurredAt: '2026-03-01T08:00:00.000Z',
    shipmentId: 'SHP-BACKFILL',
    containerCode: 'MSKU1',
    origin: 'Chennai',
    destination: 'Rotterdam',
  });
  await system.shipmentCommandService.moveShipment({
    occurredAt: '2026-03-02T08:00:00.000Z',
    shipmentId: 'SHP-BACKFILL',
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: created.version,
  });

  const events = await system.eventStore.getEvents('SHP-BACKFILL');
  assert.equal(events[0].timestamp, '2026-03-01T08:00:00.000Z');
  assert.equal(events[1].timestamp, '2026-03-02T08:00:00.000Z');

  // The store still records its own wall-clock write time, so the claimed event
  // time and the actual write time can always be compared.
  assert.ok(Date.parse(events[0].recordedAt) > Date.parse(events[0].timestamp));
});

test('an occurredAt earlier than the previous event is refused', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const created = await system.shipmentCommandService.createShipment({
    occurredAt: '2026-03-05T08:00:00.000Z',
    shipmentId: 'SHP-CHRONO',
    containerCode: 'MSKU1',
    origin: 'Chennai',
    destination: 'Rotterdam',
  });

  // A timestamp that contradicts version order would corrupt every time-based
  // reading of the ledger, so chronology is enforced rather than assumed.
  await assert.rejects(
    () =>
      system.shipmentCommandService.moveShipment({
        occurredAt: '2026-03-01T08:00:00.000Z',
        shipmentId: 'SHP-CHRONO',
        movementType: 'LOAD_ON_SHIP',
        location: 'Chennai Port',
        vesselName: 'MV Ganges Star',
        expectedVersion: created.version,
      }),
    (error) => error.code === 'VALIDATION_ERROR' && /earlier than the previous event/.test(error.message)
  );

  assert.equal(await system.eventStore.countEvents('SHP-CHRONO'), 1);
});

test('backfilled events give the scrubber a usable time range', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const created = await system.shipmentCommandService.createShipment({
    occurredAt: '2026-03-01T08:00:00.000Z',
    shipmentId: 'SHP-RANGE',
    containerCode: 'MSKU1',
    origin: 'Chennai',
    destination: 'Rotterdam',
    minTemperatureC: 2,
    maxTemperatureC: 8,
  });
  await system.shipmentCommandService.recordTemperature({
    occurredAt: '2026-03-04T08:00:00.000Z',
    shipmentId: 'SHP-RANGE',
    temperatureC: 12.4,
    recordedAt: '2026-03-04T08:00:00.000Z',
    expectedVersion: created.version,
  });

  const result = await system.queryHandlers.getShipmentEventsQueryHandler.handle({
    shipmentId: 'SHP-RANGE',
  });

  // Without occurredAt these would land milliseconds apart and the scrubber
  // would have nothing to move across.
  const spanMs = Date.parse(result.bounds.lastEventAt) - Date.parse(result.bounds.firstEventAt);
  assert.equal(spanMs, 3 * 24 * 3600 * 1000);

  // And the chart marker shares that coordinate system rather than sitting at
  // the moment the seed happened to run.
  const series = await system.sensorService.getTemperatureSeries('SHP-RANGE');
  assert.equal(series.markers[0].timestamp, '2026-03-01T08:00:00.000Z');
  assert.equal(series.readings[0].timestamp, '2026-03-04T08:00:00.000Z');
});
