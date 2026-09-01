import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCreateShipmentCommand,
  validateMoveShipmentCommand,
  validateRecordTemperatureCommand,
  validateHistoricalStateQuery,
  validateExpectedVersion,
} from '../../src/domain/shipment/validators/commandValidators.js';
import { loadConfig } from '../../src/config/env.js';
import { ValidationError } from '../../src/shared/errors/AppError.js';

const VALID_CREATE = {
  shipmentId: 'SHP-1001',
  containerCode: 'MSKU1234567',
  origin: 'Chennai',
  destination: 'Rotterdam',
  estimatedDurationDays: 14,
};

test('the default config binds to the documented API port', () => {
  const previous = process.env.PORT;
  delete process.env.PORT;

  try {
    const config = loadConfig();
    assert.equal(config.port, 4001);
  } finally {
    if (previous === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previous;
    }
  }
});

test('a well-formed create command passes and is normalised', () => {
  const command = validateCreateShipmentCommand({ ...VALID_CREATE, origin: '  Chennai  ' });
  assert.equal(command.origin, 'Chennai');
  assert.equal(command.minTemperatureC, null);
});

test('an omitted shipment id is allowed, so the server can allocate SHP-N', () => {
  // Omitting the id is how the dashboard creates a shipment: the identifier is
  // assigned by the server from an atomic counter rather than typed by a user.
  const command = validateCreateShipmentCommand({ ...VALID_CREATE, shipmentId: undefined });
  assert.equal(command.shipmentId, null);
});

test('a supplied shipment id must still be well-formed', () => {
  // Backfill and seeding may name their own streams, but not with anything.
  assert.throws(() => validateCreateShipmentCommand({ ...VALID_CREATE, shipmentId: '!!' }), ValidationError);
});

test('an injection-shaped shipment id is rejected by the id pattern', () => {
  assert.throws(() => validateCreateShipmentCommand({ ...VALID_CREATE, shipmentId: '{"$ne":null}' }), ValidationError);
});

test('all validation problems are collected in one response', () => {
  try {
    validateCreateShipmentCommand({ shipmentId: 'ok-id', origin: '', destination: '' });
    assert.fail('expected a validation error');
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    // A user fixing a form should see every problem at once, not one per retry.
    assert.ok(error.details.issues.length >= 3);
  }
});

test('a one-sided temperature range is rejected as unclassifiable', () => {
  assert.throws(
    () => validateCreateShipmentCommand({ ...VALID_CREATE, minTemperatureC: 2 }),
    ValidationError
  );
});

test('an inverted temperature range is rejected', () => {
  assert.throws(
    () => validateCreateShipmentCommand({ ...VALID_CREATE, minTemperatureC: 10, maxTemperatureC: 2 }),
    ValidationError
  );
});

test('a complete temperature range is accepted', () => {
  const command = validateCreateShipmentCommand({ ...VALID_CREATE, minTemperatureC: 2, maxTemperatureC: 8 });
  assert.equal(command.minTemperatureC, 2);
  assert.equal(command.maxTemperatureC, 8);
});

test('a move command requires a known movement type', () => {
  assert.throws(
    () => validateMoveShipmentCommand({ shipmentId: 'SHP-1', movementType: 'TELEPORT', location: 'X', expectedVersion: 1 }),
    ValidationError
  );
});

test('loading requires a vessel name and arriving requires a port name', () => {
  assert.throws(
    () => validateMoveShipmentCommand({ shipmentId: 'SHP-1', movementType: 'LOAD_ON_SHIP', location: 'X', expectedVersion: 1 }),
    ValidationError
  );
  assert.throws(
    () => validateMoveShipmentCommand({ shipmentId: 'SHP-1', movementType: 'ARRIVE_AT_PORT', location: 'X', expectedVersion: 1 }),
    ValidationError
  );
});

test('expectedVersion is mandatory on a move command', () => {
  assert.throws(
    () =>
      validateMoveShipmentCommand({
        shipmentId: 'SHP-1',
        movementType: 'LOAD_ON_SHIP',
        location: 'X',
        vesselName: 'V',
      }),
    ValidationError
  );
});

test('a string expectedVersion is rejected rather than coerced', () => {
  // Coercion here would turn a concurrency bug into a silent overwrite.
  assert.throws(() => validateExpectedVersion('5'), ValidationError);
  assert.throws(() => validateExpectedVersion(1.5), ValidationError);
  assert.throws(() => validateExpectedVersion(-1), ValidationError);
  assert.equal(validateExpectedVersion(5), 5);
});

test('a non-numeric temperature is rejected', () => {
  assert.throws(
    () => validateRecordTemperatureCommand({ shipmentId: 'SHP-1', temperatureC: 'cold', expectedVersion: 1 }),
    ValidationError
  );
});

test('a physically implausible temperature is rejected as a sensor fault', () => {
  assert.throws(
    () => validateRecordTemperatureCommand({ shipmentId: 'SHP-1', temperatureC: 5000, expectedVersion: 1 }),
    ValidationError
  );
});

test('an invalid recordedAt timestamp is rejected', () => {
  assert.throws(
    () =>
      validateRecordTemperatureCommand({
        shipmentId: 'SHP-1',
        temperatureC: 4,
        recordedAt: 'yesterday afternoon',
        expectedVersion: 1,
      }),
    ValidationError
  );
});

test('a valid temperature command passes', () => {
  const command = validateRecordTemperatureCommand({
    shipmentId: 'SHP-1',
    temperatureC: 4.5,
    recordedAt: '2026-01-01T10:00:00.000Z',
    expectedVersion: 3,
  });
  assert.equal(command.temperatureC, 4.5);
  assert.equal(command.expectedVersion, 3);
});

test('the historical-state query requires a valid ISO timestamp', () => {
  assert.throws(() => validateHistoricalStateQuery({ shipmentId: 'SHP-1', at: undefined }), ValidationError);
  assert.throws(() => validateHistoricalStateQuery({ shipmentId: 'SHP-1', at: 'not-a-date' }), ValidationError);
  const query = validateHistoricalStateQuery({ shipmentId: 'SHP-1', at: '2026-01-01T00:00:00Z' });
  assert.equal(query.at, '2026-01-01T00:00:00.000Z');
});
