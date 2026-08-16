import test from 'node:test';
import assert from 'node:assert/strict';

import { ShipmentAggregate } from '../../src/domain/shipment/aggregate/shipmentAggregate.js';
import { EVENT_TYPES } from '../../src/domain/shipment/events/eventTypes.js';
import {
  AggregateNotFoundError,
  DomainRuleViolationError,
} from '../../src/shared/errors/AppError.js';

const CREATE = {
  shipmentId: 'SHP-1',
  containerCode: 'MSKU1',
  origin: 'Chennai',
  destination: 'Rotterdam',
  minTemperatureC: 2,
  maxTemperatureC: 8,
};

const context = { timestamp: '2026-01-01T00:00:00.000Z', correlationId: 'corr-1', causationId: null };

function aggregateAfter(commands) {
  let aggregate = new ShipmentAggregate();
  const events = [];
  for (const run of commands) {
    const event = run(aggregate);
    events.push(event);
    aggregate = ShipmentAggregate.fromHistory(events);
  }
  return { aggregate, events };
}

test('creating a shipment produces CONTAINER_CREATED at version 1', () => {
  const event = new ShipmentAggregate().create(CREATE, context);
  assert.equal(event.eventType, EVENT_TYPES.CONTAINER_CREATED);
  assert.equal(event.version, 1);
  assert.equal(event.aggregateId, 'SHP-1');
  assert.equal(event.payload.origin, 'Chennai');
});

test('a stream can never contain a second creation event', () => {
  const { aggregate } = aggregateAfter([(a) => a.create(CREATE, context)]);
  assert.throws(() => aggregate.create(CREATE, context), DomainRuleViolationError);
});

test('commands against a non-existent aggregate are refused', () => {
  const aggregate = new ShipmentAggregate();
  assert.throws(
    () => aggregate.move({ shipmentId: 'SHP-1', movementType: 'LOAD_ON_SHIP', location: 'X' }, context),
    AggregateNotFoundError
  );
  assert.throws(
    () => aggregate.recordTemperature({ shipmentId: 'SHP-1', temperatureC: 4 }, context),
    AggregateNotFoundError
  );
});

test('loading a shipment produces LOADED_ON_SHIP at the next version', () => {
  const { aggregate } = aggregateAfter([(a) => a.create(CREATE, context)]);
  const event = aggregate.move(
    { shipmentId: 'SHP-1', movementType: 'LOAD_ON_SHIP', location: 'Chennai Port', vesselName: 'MV Ganges' },
    context
  );
  assert.equal(event.eventType, EVENT_TYPES.LOADED_ON_SHIP);
  assert.equal(event.version, 2);
});

test('a shipment already in transit cannot be loaded again', () => {
  const { aggregate } = aggregateAfter([
    (a) => a.create(CREATE, context),
    (a) => a.move({ shipmentId: 'SHP-1', movementType: 'LOAD_ON_SHIP', location: 'P', vesselName: 'V' }, context),
  ]);
  assert.throws(
    () => aggregate.move({ shipmentId: 'SHP-1', movementType: 'LOAD_ON_SHIP', location: 'P', vesselName: 'V' }, context),
    DomainRuleViolationError
  );
});

test('a shipment cannot arrive at a port before it was ever loaded', () => {
  const { aggregate } = aggregateAfter([(a) => a.create(CREATE, context)]);
  assert.throws(
    () => aggregate.move({ shipmentId: 'SHP-1', movementType: 'ARRIVE_AT_PORT', location: 'R', portName: 'R' }, context),
    // History must not be able to describe a physically impossible journey.
    DomainRuleViolationError
  );
});

test('a shipment cannot be unloaded before it has arrived', () => {
  const { aggregate } = aggregateAfter([
    (a) => a.create(CREATE, context),
    (a) => a.move({ shipmentId: 'SHP-1', movementType: 'LOAD_ON_SHIP', location: 'P', vesselName: 'V' }, context),
  ]);
  assert.throws(
    () => aggregate.move({ shipmentId: 'SHP-1', movementType: 'UNLOAD_FROM_SHIP', location: 'Y' }, context),
    DomainRuleViolationError
  );
});

test('a reading above the declared maximum is classified as a spike at write time', () => {
  const { aggregate } = aggregateAfter([(a) => a.create(CREATE, context)]);
  const event = aggregate.recordTemperature({ shipmentId: 'SHP-1', temperatureC: 12.4 }, context);
  assert.equal(event.eventType, EVENT_TYPES.TEMPERATURE_SPIKE);
  assert.equal(event.payload.direction, 'ABOVE_MAX');
  assert.equal(event.payload.thresholdC, 8);
});

test('a reading below the declared minimum is also a spike', () => {
  const { aggregate } = aggregateAfter([(a) => a.create(CREATE, context)]);
  const event = aggregate.recordTemperature({ shipmentId: 'SHP-1', temperatureC: -3 }, context);
  assert.equal(event.eventType, EVENT_TYPES.TEMPERATURE_SPIKE);
  assert.equal(event.payload.direction, 'BELOW_MIN');
});

test('a reading inside the range is an ordinary recorded reading', () => {
  const { aggregate } = aggregateAfter([(a) => a.create(CREATE, context)]);
  const event = aggregate.recordTemperature({ shipmentId: 'SHP-1', temperatureC: 5 }, context);
  assert.equal(event.eventType, EVENT_TYPES.TEMPERATURE_RECORDED);
  assert.equal(event.payload.thresholdC, undefined);
});

test('with no declared range, no breach is ever inferred', () => {
  // Roadmap 26 is explicit that a threshold must not be silently assumed.
  const { aggregate } = aggregateAfter([
    (a) => a.create({ ...CREATE, minTemperatureC: null, maxTemperatureC: null }, context),
  ]);
  const event = aggregate.recordTemperature({ shipmentId: 'SHP-1', temperatureC: 95 }, context);
  assert.equal(event.eventType, EVENT_TYPES.TEMPERATURE_RECORDED);
});

test('the aggregate returns events but never persists them', () => {
  const aggregate = new ShipmentAggregate();
  const event = aggregate.create(CREATE, context);
  // Deciding does not advance the aggregate; only replaying stored history does.
  assert.equal(aggregate.version, 0);
  assert.equal(event.version, 1);
});

test('produced events carry the full required envelope', () => {
  const event = new ShipmentAggregate().create(CREATE, context);
  for (const field of ['aggregateId', 'eventType', 'payload', 'timestamp', 'version']) {
    assert.ok(event[field] !== undefined, `missing required field ${field}`);
  }
  assert.equal(event.aggregateType, 'Shipment');
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.correlationId, 'corr-1');
});

test('null optional fields are stripped rather than stored as explicit nulls', () => {
  const event = new ShipmentAggregate().create(
    { ...CREATE, cargoDescription: null, carrier: null },
    context
  );
  assert.equal('cargoDescription' in event.payload, false);
  assert.equal('carrier' in event.payload, false);
});
