import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent,
  replay,
  initialShipmentState,
} from '../../src/domain/shipment/reducers/shipmentReducer.js';
import { EVENT_TYPES, SHIPMENT_STATES } from '../../src/domain/shipment/events/eventTypes.js';
import { ValidationError } from '../../src/shared/errors/AppError.js';

const event = (version, eventType, payload = {}, timestamp = `2026-01-0${version}T00:00:00.000Z`) => ({
  eventId: `evt-${version}`,
  aggregateId: 'SHP-1',
  aggregateType: 'Shipment',
  eventType,
  payload,
  timestamp,
  version,
  schemaVersion: 1,
});

const CREATED = event(1, EVENT_TYPES.CONTAINER_CREATED, {
  containerCode: 'MSKU1',
  origin: 'Chennai',
  destination: 'Rotterdam',
  minTemperatureC: 2,
  maxTemperatureC: 8,
});
const LOADED = event(2, EVENT_TYPES.LOADED_ON_SHIP, { location: 'Chennai Port', vesselName: 'MV Ganges' });
const SPIKE = event(3, EVENT_TYPES.TEMPERATURE_SPIKE, { temperatureC: 12.4, thresholdC: 8, direction: 'ABOVE_MAX' });
const ARRIVED = event(4, EVENT_TYPES.ARRIVED_AT_PORT, { location: 'Rotterdam', portName: 'Rotterdam' });

test('replaying only the creation event yields the CREATED state at the origin', () => {
  const state = replay([CREATED]);
  assert.equal(state.currentState, SHIPMENT_STATES.CREATED);
  assert.equal(state.currentLocation, 'Chennai');
  assert.equal(state.version, 1);
  assert.equal(state.exists, true);
});

test('creation plus loading yields IN_TRANSIT, not the arrival state', () => {
  const state = replay([CREATED, LOADED]);
  assert.equal(state.currentState, SHIPMENT_STATES.IN_TRANSIT);
  assert.equal(state.currentLocation, 'Chennai Port');
  assert.equal(state.vesselName, 'MV Ganges');
  assert.equal(state.arrivedAt, null);
});

test('a temperature spike records the breach without changing the lifecycle state', () => {
  const state = replay([CREATED, LOADED, SPIKE]);
  // This is the documented design decision: the source names the event but
  // defines no business consequence, so the aggregate records rather than acts.
  assert.equal(state.currentState, SHIPMENT_STATES.IN_TRANSIT);
  assert.equal(state.temperatureExcursion, true);
  assert.equal(state.temperatureBreachCount, 1);
  assert.equal(state.latestTemperatureC, 12.4);
});

test('the full source sequence reconstructs to AT_PORT at version 4', () => {
  const state = replay([CREATED, LOADED, SPIKE, ARRIVED]);
  assert.equal(state.currentState, SHIPMENT_STATES.AT_PORT);
  assert.equal(state.version, 4);
  assert.equal(state.currentLocation, 'Rotterdam');
  assert.equal(state.temperatureExcursion, true);
});

test('an empty stream replays to the initial state', () => {
  assert.deepEqual(replay([]), initialShipmentState);
});

test('an unknown event type raises a controlled error rather than being ignored', () => {
  assert.throws(
    () => replay([CREATED, event(2, 'NOT_A_REAL_EVENT')]),
    (error) => error instanceof ValidationError && /unknown event type/i.test(error.message)
  );
});

test('an unknown event type can be tolerated explicitly when strict mode is off', () => {
  const state = replay([CREATED, event(2, 'FUTURE_EVENT_TYPE')], { strict: false });
  assert.equal(state.version, 2);
  assert.equal(state.currentState, SHIPMENT_STATES.CREATED);
});

test('out-of-order events are rejected instead of producing a plausible wrong answer', () => {
  assert.throws(
    () => replay([CREATED, ARRIVED, LOADED]),
    (error) => error instanceof ValidationError && /ascending version order/i.test(error.message)
  );
});

test('duplicate versions are rejected', () => {
  assert.throws(() => replay([CREATED, LOADED, LOADED]), ValidationError);
});

test('an event missing a version cannot be replayed', () => {
  const malformed = { ...LOADED };
  delete malformed.version;
  assert.throws(() => replay([CREATED, malformed]), ValidationError);
});

test('replay is pure: the same input always yields the same output', () => {
  assert.deepEqual(replay([CREATED, LOADED, SPIKE, ARRIVED]), replay([CREATED, LOADED, SPIKE, ARRIVED]));
});

test('reducer output is frozen, so no caller can mutate reconstructed state', () => {
  const state = applyEvent(initialShipmentState, CREATED);
  assert.equal(Object.isFrozen(state), true);
  assert.throws(() => {
    'use strict';
    state.currentState = 'TAMPERED';
  });
});

test('an in-range reading increments the reading count but raises no excursion', () => {
  const state = replay([
    CREATED,
    event(2, EVENT_TYPES.TEMPERATURE_RECORDED, { temperatureC: 5.0 }),
  ]);
  assert.equal(state.temperatureReadingCount, 1);
  assert.equal(state.temperatureBreachCount, 0);
  assert.equal(state.temperatureExcursion, false);
});

test('replay can resume from a supplied intermediate state', () => {
  const half = replay([CREATED, LOADED]);
  const full = replay([SPIKE, ARRIVED], { initial: half });
  assert.deepEqual(full, replay([CREATED, LOADED, SPIKE, ARRIVED]));
});
