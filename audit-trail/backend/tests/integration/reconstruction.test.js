import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestSystem } from '../helpers/testSystem.js';
import { SHIPMENT_STATES } from '../../src/domain/shipment/events/eventTypes.js';

/**
 * The Reconstruction Check (roadmap 11.2) and state scrubbing (roadmap 12.8).
 *
 * Roadmap 11.2 requires that every derived assumption be removed from the test:
 * these tests read raw events and replay them, never consulting the read model.
 * The worker is never run here, which makes that guarantee structural rather
 * than a matter of discipline.
 */

const T = {
  created: '2026-03-01T08:00:00.000Z',
  loaded: '2026-03-02T08:00:00.000Z',
  spike: '2026-03-03T08:00:00.000Z',
  arrived: '2026-03-04T08:00:00.000Z',
};

async function seedWithFixedTimestamps(system, shipmentId = 'SHP-HIST') {
  const { eventStore } = system;
  const { createEvent } = await import('../../src/domain/shipment/events/eventFactory.js');

  await eventStore.append(
    createEvent({
      aggregateId: shipmentId,
      eventType: 'CONTAINER_CREATED',
      version: 1,
      timestamp: T.created,
      payload: { containerCode: 'C1', origin: 'Chennai', destination: 'Rotterdam', minTemperatureC: 2, maxTemperatureC: 8 },
    })
  );
  await eventStore.append(
    createEvent({
      aggregateId: shipmentId,
      eventType: 'LOADED_ON_SHIP',
      version: 2,
      timestamp: T.loaded,
      payload: { location: 'Chennai Port', vesselName: 'MV Ganges Star' },
    })
  );
  await eventStore.append(
    createEvent({
      aggregateId: shipmentId,
      eventType: 'TEMPERATURE_SPIKE',
      version: 3,
      timestamp: T.spike,
      payload: { temperatureC: 12.4, recordedAt: T.spike, thresholdC: 8, direction: 'ABOVE_MAX' },
    })
  );
  await eventStore.append(
    createEvent({
      aggregateId: shipmentId,
      eventType: 'ARRIVED_AT_PORT',
      version: 4,
      timestamp: T.arrived,
      payload: { location: 'Rotterdam', portName: 'Port of Rotterdam' },
    })
  );
  return shipmentId;
}

test('RECONSTRUCTION: replaying the raw stream produces the expected final state', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const { state, eventCount, replayedFrom } = await system.replayService.reconstructCurrentState(id);

  assert.equal(replayedFrom, 'event-store');
  assert.equal(eventCount, 4);
  assert.equal(state.currentState, SHIPMENT_STATES.AT_PORT);
  assert.equal(state.version, 4);
  assert.equal(state.currentLocation, 'Rotterdam');
  assert.equal(state.temperatureBreachCount, 1);
});

test('RECONSTRUCTION: the expected state after every single version is verified', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const steps = await system.replayService.reconstructStepByStep(id);

  assert.equal(steps.length, 4);
  assert.equal(steps[0].stateAfter.currentState, SHIPMENT_STATES.CREATED);
  assert.equal(steps[1].stateAfter.currentState, SHIPMENT_STATES.IN_TRANSIT);
  assert.equal(steps[2].stateAfter.currentState, SHIPMENT_STATES.IN_TRANSIT);
  assert.equal(steps[2].stateAfter.temperatureExcursion, true);
  assert.equal(steps[3].stateAfter.currentState, SHIPMENT_STATES.AT_PORT);
});

test('HISTORICAL: replaying only v1+v2 gives the loaded state, not the arrival state', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const result = await system.replayService.reconstructStateAt(id, '2026-03-02T12:00:00.000Z');

  assert.equal(result.appliedEventCount, 2);
  assert.equal(result.state.currentState, SHIPMENT_STATES.IN_TRANSIT);
  // The critical assertion: history at this instant must not know about the
  // temperature spike that had not happened yet.
  assert.equal(result.state.temperatureExcursion, false);
  assert.equal(result.state.arrivedAt, null);
});

test('HISTORICAL: replaying v1..v3 exposes the temperature information', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const result = await system.replayService.reconstructStateAt(id, '2026-03-03T20:00:00.000Z');

  assert.equal(result.appliedEventCount, 3);
  assert.equal(result.state.temperatureExcursion, true);
  assert.equal(result.state.latestTemperatureC, 12.4);
  assert.equal(result.state.currentState, SHIPMENT_STATES.IN_TRANSIT);
});

test('BOUNDARY: before the first event, no state existed', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const result = await system.replayService.reconstructStateAt(id, '2026-02-01T00:00:00.000Z');

  assert.equal(result.existedAt, false);
  assert.equal(result.state, null);
  assert.equal(result.boundary, 'BEFORE_FIRST_EVENT');
  // "No state yet" and "state with empty fields" must be distinguishable.
});

test('BOUNDARY: an instant exactly on an event includes that event', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const result = await system.replayService.reconstructStateAt(id, T.loaded);

  // The documented rule is an inclusive boundary (roadmap 12.9).
  assert.equal(result.appliedEventCount, 2);
  assert.equal(result.state.currentState, SHIPMENT_STATES.IN_TRANSIT);
  assert.equal(result.boundary, 'EXACTLY_ON_EVENT');
});

test('BOUNDARY: exactly on the temperature spike, the breach is already visible', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const result = await system.replayService.reconstructStateAt(id, T.spike);
  assert.equal(result.appliedEventCount, 3);
  assert.equal(result.state.temperatureExcursion, true);
});

test('BOUNDARY: between events, state is that of the most recent preceding event', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const result = await system.replayService.reconstructStateAt(id, '2026-03-03T20:00:00.000Z');
  assert.equal(result.boundary, 'BETWEEN_EVENTS');
  assert.equal(result.lastAppliedEvent.version, 3);
});

test('BOUNDARY: after the latest event, the current state is returned and flagged', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const result = await system.replayService.reconstructStateAt(id, '2027-01-01T00:00:00.000Z');

  assert.equal(result.boundary, 'AT_OR_AFTER_LAST_EVENT');
  assert.equal(result.isCurrent, true);
  assert.equal(result.state.currentState, SHIPMENT_STATES.AT_PORT);
});

test('BOUNDARY: exactly on the last event counts as current', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const result = await system.replayService.reconstructStateAt(id, T.arrived);
  assert.equal(result.isCurrent, true);
  assert.equal(result.appliedEventCount, 4);
});

test('HISTORICAL: the sensor series can be truncated to the same instant as the state', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const id = await seedWithFixedTimestamps(system);
  const before = await system.sensorService.getTemperatureSeries(id, { at: '2026-03-02T12:00:00.000Z' });
  const after = await system.sensorService.getTemperatureSeries(id, { at: '2026-03-04T00:00:00.000Z' });

  // Without this, the chart would show the current temperature alongside a
  // historical state - the exact confusion roadmap 13.6 warns about.
  assert.equal(before.readings.length, 0);
  assert.equal(after.readings.length, 1);
});

test('replaying after a fresh start reproduces the identical state', async (t) => {
  const systemA = await createTestSystem();
  const systemB = await createTestSystem();
  t.after(() => Promise.all([systemA.teardown(), systemB.teardown()]));

  const idA = await seedWithFixedTimestamps(systemA, 'SHP-CLEAN');
  const idB = await seedWithFixedTimestamps(systemB, 'SHP-CLEAN');

  const a = await systemA.replayService.reconstructCurrentState(idA);
  const b = await systemB.replayService.reconstructCurrentState(idB);

  // Ignoring the ids that are random per event, the reconstructed state must
  // be identical from a clean database.
  assert.deepEqual(a.state, b.state);
});
