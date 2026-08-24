import { MOVEMENT_TYPES } from '../events/eventTypes.js';
import { ValidationError } from '../../../shared/errors/AppError.js';
import { isValidIsoTimestamp } from '../../../shared/utils/index.js';

/**
 * Structural validation of inbound commands (roadmap 16 - Input validation).
 *
 * These functions answer "is this command well-formed?" only. Whether the
 * command is *legal right now* is a question about aggregate state, and is
 * answered by the aggregate itself. Keeping the two separate is what stops
 * business rules leaking into HTTP controllers.
 *
 * Every validator collects all problems before throwing, so a client fixing a
 * form gets the complete list in one round trip.
 */

const SHIPMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export function validateShipmentId(value, field = 'shipmentId') {
  if (typeof value !== 'string' || !SHIPMENT_ID_PATTERN.test(value)) {
    throw new ValidationError(
      `'${field}' must be 3-64 characters of letters, digits, dot, underscore or hyphen.`,
      { field, received: typeof value === 'string' ? value : typeof value }
    );
  }
  return value;
}

/**
 * `expectedVersion` is the client's claim about what it was looking at. It is
 * the entire basis of Optimistic Concurrency Control, so it is validated
 * strictly: a string "5", a float, or a negative number are all rejected rather
 * than coerced. Coercion here would turn a concurrency bug into a silent
 * overwrite.
 */
export function validateExpectedVersion(value, { required = true, minimum = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new ValidationError(
        "'expectedVersion' is required. Send the version you loaded so stale commands can be rejected.",
        { field: 'expectedVersion' }
      );
    }
    return null;
  }
  if (!Number.isInteger(value) || value < minimum) {
    throw new ValidationError(
      `'expectedVersion' must be an integer >= ${minimum}. Received ${JSON.stringify(value)}.`,
      { field: 'expectedVersion', received: value }
    );
  }
  return value;
}

function requireNonEmptyString(errors, object, field, { maxLength = 200 } = {}) {
  const value = object?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ field, message: `'${field}' is required and must be a non-empty string.` });
    return undefined;
  }
  if (value.length > maxLength) {
    errors.push({ field, message: `'${field}' must be at most ${maxLength} characters.` });
    return undefined;
  }
  return value.trim();
}

function optionalString(errors, object, field, { maxLength = 500 } = {}) {
  const value = object?.[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    errors.push({ field, message: `'${field}' must be a string when provided.` });
    return null;
  }
  if (value.length > maxLength) {
    errors.push({ field, message: `'${field}' must be at most ${maxLength} characters.` });
    return null;
  }
  return value.trim();
}

function optionalFiniteNumber(errors, object, field) {
  const value = object?.[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ field, message: `'${field}' must be a finite number when provided.` });
    return null;
  }
  return value;
}

/**
 * `occurredAt` — when the event happened in the real world, as distinct from
 * when the system recorded it.
 *
 * Needed for backfilling: importing a shipment's existing history, or seeding a
 * demonstration dataset whose events span days rather than milliseconds. Without
 * it every imported event would be stamped with the import time, which would
 * make the timeline and the time scrubber meaningless.
 *
 * It is only ever a *claim* about the past. The Event Store still records its
 * own `recordedAt` wall-clock write time on every document, so the two can
 * always be compared, and the service refuses a value that would place an event
 * before its own predecessor.
 */
function optionalOccurredAt(errors, input) {
  const value = input?.occurredAt;
  if (value === undefined || value === null || value === '') return null;
  if (!isValidIsoTimestamp(value)) {
    errors.push({ field: 'occurredAt', message: "'occurredAt' must be an ISO-8601 timestamp when provided." });
    return null;
  }
  return new Date(value).toISOString();
}

function throwIfAny(errors, message) {
  if (errors.length > 0) throw new ValidationError(message, { issues: errors });
}

/** POST /shipment/create */
export function validateCreateShipmentCommand(input) {
  const errors = [];
  const shipmentId = input?.shipmentId;
  try {
    validateShipmentId(shipmentId);
  } catch (error) {
    errors.push({ field: 'shipmentId', message: error.message });
  }

  const containerCode = requireNonEmptyString(errors, input, 'containerCode', { maxLength: 32 });
  const origin = requireNonEmptyString(errors, input, 'origin');
  const destination = requireNonEmptyString(errors, input, 'destination');
  const cargoDescription = optionalString(errors, input, 'cargoDescription');
  const carrier = optionalString(errors, input, 'carrier', { maxLength: 120 });
  const minTemperatureC = optionalFiniteNumber(errors, input, 'minTemperatureC');
  const maxTemperatureC = optionalFiniteNumber(errors, input, 'maxTemperatureC');

  if (
    minTemperatureC !== null &&
    maxTemperatureC !== null &&
    minTemperatureC > maxTemperatureC
  ) {
    errors.push({
      field: 'minTemperatureC',
      message: "'minTemperatureC' cannot be greater than 'maxTemperatureC'.",
    });
  }
  // Only one bound is meaningless for breach classification - reject rather
  // than quietly assuming the other side is unbounded.
  if ((minTemperatureC === null) !== (maxTemperatureC === null)) {
    errors.push({
      field: 'minTemperatureC',
      message:
        'Supply both minTemperatureC and maxTemperatureC, or neither. A one-sided range cannot classify a breach.',
    });
  }

  const occurredAt = optionalOccurredAt(errors, input);

  throwIfAny(errors, 'The create-shipment command failed validation.');

  return {
    occurredAt,
    shipmentId,
    containerCode,
    origin,
    destination,
    cargoDescription,
    carrier,
    minTemperatureC,
    maxTemperatureC,
  };
}

/** POST /shipment/move - the command named by the source document. */
export function validateMoveShipmentCommand(input) {
  const errors = [];
  const shipmentId = input?.shipmentId;
  try {
    validateShipmentId(shipmentId);
  } catch (error) {
    errors.push({ field: 'shipmentId', message: error.message });
  }

  const movementType = input?.movementType;
  if (!Object.values(MOVEMENT_TYPES).includes(movementType)) {
    errors.push({
      field: 'movementType',
      message: `'movementType' must be one of: ${Object.values(MOVEMENT_TYPES).join(', ')}.`,
    });
  }

  const location = requireNonEmptyString(errors, input, 'location');
  const vesselName = optionalString(errors, input, 'vesselName', { maxLength: 120 });
  const voyageNumber = optionalString(errors, input, 'voyageNumber', { maxLength: 60 });
  const portName = optionalString(errors, input, 'portName', { maxLength: 120 });
  const berth = optionalString(errors, input, 'berth', { maxLength: 60 });
  const notes = optionalString(errors, input, 'notes');

  if (movementType === MOVEMENT_TYPES.LOAD_ON_SHIP && !vesselName) {
    errors.push({ field: 'vesselName', message: "'vesselName' is required when loading onto a ship." });
  }
  if (movementType === MOVEMENT_TYPES.ARRIVE_AT_PORT && !portName) {
    errors.push({ field: 'portName', message: "'portName' is required when arriving at a port." });
  }

  let expectedVersion = null;
  try {
    expectedVersion = validateExpectedVersion(input?.expectedVersion, { minimum: 1 });
  } catch (error) {
    errors.push({ field: 'expectedVersion', message: error.message });
  }

  const occurredAt = optionalOccurredAt(errors, input);

  throwIfAny(errors, 'The move-shipment command failed validation.');

  return { occurredAt, shipmentId, movementType, location, vesselName, voyageNumber, portName, berth, notes, expectedVersion };
}

/** POST /shipment/temperature */
export function validateRecordTemperatureCommand(input) {
  const errors = [];
  const shipmentId = input?.shipmentId;
  try {
    validateShipmentId(shipmentId);
  } catch (error) {
    errors.push({ field: 'shipmentId', message: error.message });
  }

  const temperatureC = input?.temperatureC;
  if (typeof temperatureC !== 'number' || !Number.isFinite(temperatureC)) {
    errors.push({ field: 'temperatureC', message: "'temperatureC' must be a finite number (degrees Celsius)." });
  } else if (temperatureC < -100 || temperatureC > 150) {
    // Physically implausible for a reefer container: reject rather than store a
    // sensor fault as though it were a genuine reading.
    errors.push({
      field: 'temperatureC',
      message: "'temperatureC' must be between -100 and 150. Values outside this range indicate a sensor fault.",
    });
  }

  const recordedAt = input?.recordedAt;
  if (recordedAt !== undefined && recordedAt !== null && !isValidIsoTimestamp(recordedAt)) {
    errors.push({ field: 'recordedAt', message: "'recordedAt' must be an ISO-8601 timestamp when provided." });
  }

  const sensorId = optionalString(errors, input, 'sensorId', { maxLength: 60 });

  let expectedVersion = null;
  try {
    expectedVersion = validateExpectedVersion(input?.expectedVersion, { minimum: 1 });
  } catch (error) {
    errors.push({ field: 'expectedVersion', message: error.message });
  }

  const occurredAt = optionalOccurredAt(errors, input);

  throwIfAny(errors, 'The record-temperature command failed validation.');

  return { occurredAt, shipmentId, temperatureC, recordedAt: recordedAt ?? null, sensorId, expectedVersion };
}

/**
 * POST /shipment/amend
 *
 * Structural only, as everywhere else here: this asks "is this a well-formed
 * amendment?", not "does it change anything?" or "is this shipment archived?".
 * Both of those are questions about aggregate state and are answered by the
 * aggregate.
 *
 * A field the client omits is *not amended*. A field sent as an empty string is
 * also treated as not amended rather than as a request to blank it: the
 * dashboard sends whole forms, and a blank optional input must not silently
 * erase a stored value.
 */
export function validateAmendShipmentCommand(input) {
  const errors = [];
  const shipmentId = input?.shipmentId;
  try {
    validateShipmentId(shipmentId);
  } catch (error) {
    errors.push({ field: 'shipmentId', message: error.message });
  }

  const containerCode = optionalString(errors, input, 'containerCode', { maxLength: 32 });
  const origin = optionalString(errors, input, 'origin', { maxLength: 200 });
  const destination = optionalString(errors, input, 'destination', { maxLength: 200 });
  const cargoDescription = optionalString(errors, input, 'cargoDescription');
  const carrier = optionalString(errors, input, 'carrier', { maxLength: 120 });
  const minTemperatureC = optionalFiniteNumber(errors, input, 'minTemperatureC');
  const maxTemperatureC = optionalFiniteNumber(errors, input, 'maxTemperatureC');
  const reason = optionalString(errors, input, 'reason', { maxLength: 300 });

  if (minTemperatureC !== null && maxTemperatureC !== null && minTemperatureC > maxTemperatureC) {
    errors.push({
      field: 'minTemperatureC',
      message: "'minTemperatureC' cannot be greater than 'maxTemperatureC'.",
    });
  }

  const supplied = [containerCode, origin, destination, cargoDescription, carrier, minTemperatureC, maxTemperatureC];
  if (supplied.every((value) => value === null)) {
    errors.push({
      field: 'amendment',
      message:
        'An amendment must carry at least one field to change. Send the corrected value for at least one of: containerCode, origin, destination, cargoDescription, carrier, minTemperatureC, maxTemperatureC.',
    });
  }

  let expectedVersion = null;
  try {
    expectedVersion = validateExpectedVersion(input?.expectedVersion, { minimum: 1 });
  } catch (error) {
    errors.push({ field: 'expectedVersion', message: error.message });
  }

  const occurredAt = optionalOccurredAt(errors, input);

  throwIfAny(errors, 'The amend-shipment command failed validation.');

  return {
    occurredAt,
    shipmentId,
    containerCode,
    origin,
    destination,
    cargoDescription,
    carrier,
    minTemperatureC,
    maxTemperatureC,
    reason,
    expectedVersion,
  };
}

/** POST /shipment/archive and POST /shipment/restore - identical shapes. */
function validateArchivalCommand(input, commandLabel) {
  const errors = [];
  const shipmentId = input?.shipmentId;
  try {
    validateShipmentId(shipmentId);
  } catch (error) {
    errors.push({ field: 'shipmentId', message: error.message });
  }

  const reason = optionalString(errors, input, 'reason', { maxLength: 300 });

  let expectedVersion = null;
  try {
    expectedVersion = validateExpectedVersion(input?.expectedVersion, { minimum: 1 });
  } catch (error) {
    errors.push({ field: 'expectedVersion', message: error.message });
  }

  const occurredAt = optionalOccurredAt(errors, input);

  throwIfAny(errors, `The ${commandLabel} command failed validation.`);

  return { occurredAt, shipmentId, reason, expectedVersion };
}

export const validateArchiveShipmentCommand = (input) =>
  validateArchivalCommand(input, 'archive-shipment');

export const validateRestoreShipmentCommand = (input) =>
  validateArchivalCommand(input, 'restore-shipment');

/** Query-side validation for the state-scrubbing endpoint. */
export function validateHistoricalStateQuery({ shipmentId, at }) {
  validateShipmentId(shipmentId);
  if (at === undefined || at === null || at === '') {
    throw new ValidationError("The 'at' query parameter is required (ISO-8601 timestamp).", { field: 'at' });
  }
  if (!isValidIsoTimestamp(at)) {
    throw new ValidationError(
      `The 'at' query parameter must be a valid ISO-8601 timestamp. Received '${at}'.`,
      { field: 'at' }
    );
  }
  return { shipmentId, at: new Date(at).toISOString() };
}
