import { MOVEMENT_TYPES } from '../events/eventTypes.js';
import { resolveLocation } from '../reference/locations.js';
import {
  LIFECYCLE_STAGES,
  REVISION_REASONS,
  STAGE_LABELS,
  isPlanDate,
  validateWholeDays,
} from '../schedule/schedulePolicy.js';
import { ValidationError } from '../../../shared/errors/AppError.js';
import { isValidIsoTimestamp } from '../../../shared/utils/index.js';

/**
 * Container-code normalisation (requirement 4).
 *
 * Applied on the *backend*, not only in the input field, and applied before the
 * value ever reaches the aggregate. That ordering is what actually prevents the
 * failure the requirement describes: if normalisation lived only in the
 * browser, a client posting `msku7845123` directly would create a second,
 * conflicting record for a container the ledger already knows as
 * `MSKU7845123` - and in an append-only store, that mistake cannot be tidied up
 * afterwards.
 *
 * Whitespace is stripped for the same reason casing is: the difference is
 * invisible to a human reading a manifest and fatal to a query.
 */
export function normaliseContainerCode(value) {
  if (typeof value !== 'string') return value;
  return value.trim().replace(/\s+/g, '').toUpperCase();
}

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

/**
 * POST /shipment/create
 *
 * `shipmentId` is **optional**. Omitting it - which is what the dashboard does -
 * asks the server to allocate the next `SHP-N` from an atomic counter. Supplying
 * one is still permitted, because backfilling a real history and seeding a
 * demonstration dataset both need to name their own streams, and refusing that
 * would mean the import path could not reproduce an existing ledger.
 *
 * Either way the identifier is fixed at creation: it is the stream identity, it
 * is absent from AMENDABLE_FIELDS, and no command can change it afterwards.
 */
export function validateCreateShipmentCommand(input) {
  const errors = [];
  const shipmentId = input?.shipmentId ?? null;
  if (shipmentId !== null && shipmentId !== undefined && shipmentId !== '') {
    try {
      validateShipmentId(shipmentId);
    } catch (error) {
      errors.push({ field: 'shipmentId', message: error.message });
    }
  }

  const rawContainerCode = requireNonEmptyString(errors, input, 'containerCode', { maxLength: 32 });
  const containerCode = rawContainerCode === undefined ? undefined : normaliseContainerCode(rawContainerCode);
  if (containerCode !== undefined && containerCode === '') {
    errors.push({ field: 'containerCode', message: "'containerCode' cannot be only whitespace." });
  }

  /**
   * Origin and destination.
   *
   * Structured `{ city, countryCode, stateCode }` is the intended input and is
   * resolved against the shared country/subdivision catalogue - the same one
   * the dropdowns are built from, so the UI and the validator cannot disagree.
   *
   * A plain string is still accepted for the backfill and seed paths described
   * above. When one is given, the free-text value is stored as-is and no
   * normalised location object is produced; the PDF then shows the location as
   * "as recorded" rather than implying a validated country/state pair it never
   * had.
   */
  const { display: origin, location: originLocation } = resolveAddress(errors, input, 'origin');
  const { display: destination, location: destinationLocation } = resolveAddress(
    errors,
    input,
    'destination'
  );

  const durationCheck = validateWholeDays(input?.estimatedDurationDays, {
    field: 'estimatedDurationDays',
  });
  if (!durationCheck.ok) errors.push(durationCheck.issue);
  const estimatedDurationDays = durationCheck.ok ? durationCheck.value : null;

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
    originLocation,
    destinationLocation,
    estimatedDurationDays,
    cargoDescription,
    carrier,
    minTemperatureC,
    maxTemperatureC,
  };
}

/**
 * Accepts either a structured location or a legacy free-text string for an
 * address field, and reports which it got.
 */
function resolveAddress(errors, input, field) {
  const structured = input?.[`${field}Location`] ?? (isPlainObject(input?.[field]) ? input[field] : null);

  if (structured) {
    const { location, issues } = resolveLocation(structured, { fieldPrefix: field });
    if (issues.length > 0) {
      issues.forEach((issue) => errors.push({ field: issue.field, message: issue.message, code: issue.code }));
      return { display: undefined, location: null };
    }
    return { display: location.display, location };
  }

  const text = input?.[field];
  if (typeof text !== 'string' || text.trim() === '') {
    errors.push({
      field: `${field}.countryCode`,
      code: 'COUNTRY_REQUIRED',
      message: `Select a country for the ${field}.`,
    });
    return { display: undefined, location: null };
  }
  if (text.length > 200) {
    errors.push({ field, message: `'${field}' must be at most 200 characters.` });
    return { display: undefined, location: null };
  }
  return { display: text.trim(), location: null };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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

  /**
   * Provenance. Defaults to MANUAL because a reading arriving through the API
   * without stating where it came from *is* a hand-entered one - and a reading
   * whose origin is unknown must never be allowed to pass itself off as sensor
   * data in the audit trail.
   */
  const allowedSources = ['MANUAL', 'SIMULATED', 'EXTERNAL'];
  const rawSource = input?.source ?? 'MANUAL';
  if (!allowedSources.includes(rawSource)) {
    errors.push({
      field: 'source',
      message: `'source' must be one of: ${allowedSources.join(', ')}.`,
    });
  }

  let expectedVersion = null;
  try {
    expectedVersion = validateExpectedVersion(input?.expectedVersion, { minimum: 1 });
  } catch (error) {
    errors.push({ field: 'expectedVersion', message: error.message });
  }

  const occurredAt = optionalOccurredAt(errors, input);

  throwIfAny(errors, 'The record-temperature command failed validation.');

  return {
    occurredAt,
    shipmentId,
    temperatureC,
    recordedAt: recordedAt ?? null,
    sensorId,
    source: rawSource,
    expectedVersion,
  };
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

  const rawContainerCode = optionalString(errors, input, 'containerCode', { maxLength: 32 });
  // Normalised on amendment too - otherwise an "edit" could reintroduce exactly
  // the casing inconsistency creation was careful to prevent.
  const containerCode = rawContainerCode === null ? null : normaliseContainerCode(rawContainerCode);

  const originAmendment = optionalAddressAmendment(errors, input, 'origin');
  const destinationAmendment = optionalAddressAmendment(errors, input, 'destination');
  const origin = originAmendment.display;
  const destination = destinationAmendment.display;
  const originLocation = originAmendment.location;
  const destinationLocation = destinationAmendment.location;
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
    originLocation,
    destinationLocation,
    cargoDescription,
    carrier,
    minTemperatureC,
    maxTemperatureC,
    reason,
    expectedVersion,
  };
}

/** An address field on an amendment: absent means "not amended", as everywhere else. */
function optionalAddressAmendment(errors, input, field) {
  const structured = input?.[`${field}Location`];
  if (isPlainObject(structured)) {
    const { location, issues } = resolveLocation(structured, { fieldPrefix: field });
    if (issues.length > 0) {
      issues.forEach((issue) => errors.push({ field: issue.field, message: issue.message, code: issue.code }));
      return { display: null, location: null };
    }
    return { display: location.display, location };
  }
  const text = optionalString(errors, input, field, { maxLength: 200 });
  return { display: text, location: null };
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

// ---------------------------------------------------------------------------
// Schedule commands
// ---------------------------------------------------------------------------

/**
 * Shared shape validation for a proposed schedule.
 *
 * Deliberately *structural only*, like every other validator here. Whether the
 * dates fall inside the shipment's planning window and respect stage ordering
 * are questions about aggregate state, so they belong to the aggregate - which
 * answers them with `validatePlannedDates` against the real creation date and
 * real confirmed stages. Duplicating those checks here would create two rule
 * sets to keep in step, and the one further from the state would eventually be
 * wrong.
 */
function validateScheduleShape(errors, input) {
  const raw = input?.schedule;
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({
      field: 'schedule',
      code: 'SCHEDULE_REQUIRED',
      message: "'schedule' must be an object keyed by lifecycle stage.",
    });
    return null;
  }

  const schedule = {};
  for (const stage of LIFECYCLE_STAGES) {
    const entry = raw[stage];
    if (entry === undefined || entry === null) {
      errors.push({
        field: `schedule.${stage}`,
        code: 'STAGE_MISSING',
        message: `A plan for ${STAGE_LABELS[stage]} is required.`,
      });
      continue;
    }

    const plannedDate = typeof entry === 'string' ? entry : entry.plannedDate;
    if (!isPlanDate(plannedDate)) {
      errors.push({
        field: `schedule.${stage}.plannedDate`,
        code: 'PLANNED_DATE_INVALID',
        message: `The tentative date for ${STAGE_LABELS[stage]} must be a calendar date (YYYY-MM-DD).`,
      });
      continue;
    }

    const details = typeof entry === 'object' && isPlainObject(entry.details) ? entry.details : null;
    if (details) {
      for (const [key, value] of Object.entries(details)) {
        if (value === null || value === undefined || value === '') continue;
        if (typeof value !== 'string') {
          errors.push({
            field: `schedule.${stage}.details.${key}`,
            message: 'Stage details must be text.',
          });
        } else if (value.length > 300) {
          errors.push({
            field: `schedule.${stage}.details.${key}`,
            message: 'Stage details must be at most 300 characters.',
          });
        }
      }
    }

    schedule[stage] = { plannedDate, details };
  }

  return schedule;
}

/** POST /shipment/schedule/plan -> SHIPMENT_SCHEDULE_PLANNED */
export function validatePlanScheduleCommand(input) {
  const errors = [];
  const shipmentId = input?.shipmentId;
  try {
    validateShipmentId(shipmentId);
  } catch (error) {
    errors.push({ field: 'shipmentId', message: error.message });
  }

  const schedule = validateScheduleShape(errors, input);
  const note = optionalString(errors, input, 'note', { maxLength: 300 });

  let expectedVersion = null;
  try {
    expectedVersion = validateExpectedVersion(input?.expectedVersion, { minimum: 1 });
  } catch (error) {
    errors.push({ field: 'expectedVersion', message: error.message });
  }

  const occurredAt = optionalOccurredAt(errors, input);
  throwIfAny(errors, 'The plan-schedule command failed validation.');

  return { occurredAt, shipmentId, schedule, note, expectedVersion };
}

/** POST /shipment/schedule/revise -> SHIPMENT_SCHEDULE_REVISED */
export function validateReviseScheduleCommand(input) {
  const errors = [];
  const shipmentId = input?.shipmentId;
  try {
    validateShipmentId(shipmentId);
  } catch (error) {
    errors.push({ field: 'shipmentId', message: error.message });
  }

  const schedule = validateScheduleShape(errors, input);
  const note = optionalString(errors, input, 'note', { maxLength: 300 });

  const reason = input?.reason ?? REVISION_REASONS.REPLAN;
  if (!Object.values(REVISION_REASONS).includes(reason)) {
    errors.push({
      field: 'reason',
      message: `'reason' must be one of: ${Object.values(REVISION_REASONS).join(', ')}.`,
    });
  }

  let expectedVersion = null;
  try {
    expectedVersion = validateExpectedVersion(input?.expectedVersion, { minimum: 1 });
  } catch (error) {
    errors.push({ field: 'expectedVersion', message: error.message });
  }

  const occurredAt = optionalOccurredAt(errors, input);
  throwIfAny(errors, 'The revise-schedule command failed validation.');

  return { occurredAt, shipmentId, schedule, reason, note, expectedVersion };
}

/**
 * POST /shipment/schedule/extend -> SHIPMENT_SCHEDULE_EXTENDED
 *
 * `extensionDays` runs through the same whole-day validator the estimated
 * duration uses, so zero, negatives, decimals and text are refused identically
 * in both places. One rule, one implementation, one error message.
 */
export function validateExtendScheduleCommand(input) {
  const errors = [];
  const shipmentId = input?.shipmentId;
  try {
    validateShipmentId(shipmentId);
  } catch (error) {
    errors.push({ field: 'shipmentId', message: error.message });
  }

  const stage = input?.stage;
  if (!LIFECYCLE_STAGES.includes(stage)) {
    errors.push({
      field: 'stage',
      message: `'stage' must be one of: ${LIFECYCLE_STAGES.join(', ')}.`,
    });
  }

  const extension = validateWholeDays(input?.extensionDays, { field: 'extensionDays', max: 365 });
  if (!extension.ok) errors.push(extension.issue);

  const reason = optionalString(errors, input, 'reason', { maxLength: 300 });

  let expectedVersion = null;
  try {
    expectedVersion = validateExpectedVersion(input?.expectedVersion, { minimum: 1 });
  } catch (error) {
    errors.push({ field: 'expectedVersion', message: error.message });
  }

  const occurredAt = optionalOccurredAt(errors, input);
  throwIfAny(errors, 'The extend-schedule command failed validation.');

  return {
    occurredAt,
    shipmentId,
    stage,
    extensionDays: extension.ok ? extension.value : null,
    reason,
    expectedVersion,
  };
}
