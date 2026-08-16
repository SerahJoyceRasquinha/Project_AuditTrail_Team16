/**
 * Event catalog for the Shipment aggregate (roadmap 10.1).
 *
 * Aggregate naming decision (roadmap 26): the source document uses "shipment"
 * and "shipping container" interchangeably. This codebase settles on
 * **Shipment** as the aggregate name everywhere - code, API and docs - while
 * keeping the source's literal event names (CONTAINER_CREATED etc.), which are
 * named requirements.
 *
 * Each entry records whether the event type came from the source document or is
 * a documented design decision, so a reviewer can see at a glance what was
 * required and what was added. This object is also served by
 * `GET /api/meta/event-catalog`, which keeps the documentation honest: it is
 * generated from the same constant the reducer validates against.
 */
export const AGGREGATE_TYPE = 'Shipment';

export const EVENT_TYPES = Object.freeze({
  CONTAINER_CREATED: 'CONTAINER_CREATED',
  LOADED_ON_SHIP: 'LOADED_ON_SHIP',
  TEMPERATURE_SPIKE: 'TEMPERATURE_SPIKE',
  ARRIVED_AT_PORT: 'ARRIVED_AT_PORT',
  TEMPERATURE_RECORDED: 'TEMPERATURE_RECORDED',
  UNLOADED_FROM_SHIP: 'UNLOADED_FROM_SHIP',
});

/** Lifecycle states produced by the reducer. */
export const SHIPMENT_STATES = Object.freeze({
  CREATED: 'CREATED',
  IN_TRANSIT: 'IN_TRANSIT',
  AT_PORT: 'AT_PORT',
  UNLOADED: 'UNLOADED',
});

/**
 * Movement types accepted by `POST /shipment/move`.
 *
 * The source specifies the endpoint but not its vocabulary, so the mapping from
 * movement type to emitted event is a design decision - recorded here rather
 * than buried in a handler.
 */
export const MOVEMENT_TYPES = Object.freeze({
  LOAD_ON_SHIP: 'LOAD_ON_SHIP',
  ARRIVE_AT_PORT: 'ARRIVE_AT_PORT',
  UNLOAD_FROM_SHIP: 'UNLOAD_FROM_SHIP',
});

export const MOVEMENT_TO_EVENT = Object.freeze({
  [MOVEMENT_TYPES.LOAD_ON_SHIP]: EVENT_TYPES.LOADED_ON_SHIP,
  [MOVEMENT_TYPES.ARRIVE_AT_PORT]: EVENT_TYPES.ARRIVED_AT_PORT,
  [MOVEMENT_TYPES.UNLOAD_FROM_SHIP]: EVENT_TYPES.UNLOADED_FROM_SHIP,
});

export const EVENT_CATALOG = Object.freeze({
  [EVENT_TYPES.CONTAINER_CREATED]: {
    origin: 'source',
    description:
      'A shipping container enters the ledger. Always version 1 of a stream; a stream can never contain a second one.',
    requiredPayloadFields: ['containerCode', 'origin', 'destination'],
    optionalPayloadFields: [
      'cargoDescription',
      'carrier',
      'minTemperatureC',
      'maxTemperatureC',
    ],
    reducerEffect: 'state -> CREATED; currentLocation = payload.origin; stores the temperature range if supplied.',
  },
  [EVENT_TYPES.LOADED_ON_SHIP]: {
    origin: 'source',
    description: 'The container has been loaded onto a vessel and is now in transit.',
    requiredPayloadFields: ['vesselName', 'location'],
    optionalPayloadFields: ['voyageNumber', 'notes'],
    reducerEffect: 'state -> IN_TRANSIT; currentLocation = payload.location; vessel recorded.',
  },
  [EVENT_TYPES.TEMPERATURE_SPIKE]: {
    origin: 'source',
    description:
      'A sensor reading fell outside the range declared at creation. Emitted instead of TEMPERATURE_RECORDED; it never replaces or edits an earlier reading.',
    requiredPayloadFields: ['temperatureC', 'recordedAt'],
    optionalPayloadFields: ['sensorId', 'thresholdC', 'direction'],
    reducerEffect:
      'latestTemperatureC updated; breach counter incremented; temperatureExcursion flag raised. Lifecycle state is deliberately unchanged - see the design decision note below.',
  },
  [EVENT_TYPES.ARRIVED_AT_PORT]: {
    origin: 'source',
    description: 'The vessel carrying the container has arrived at a port.',
    requiredPayloadFields: ['portName', 'location'],
    optionalPayloadFields: ['berth', 'notes'],
    reducerEffect: 'state -> AT_PORT; currentLocation = payload.location; arrival timestamp recorded.',
  },
  [EVENT_TYPES.TEMPERATURE_RECORDED]: {
    origin: 'design-decision',
    description:
      'An in-range sensor reading. Added because the source requires visualising temperature *fluctuations*, which is impossible if only breaches are stored.',
    requiredPayloadFields: ['temperatureC', 'recordedAt'],
    optionalPayloadFields: ['sensorId'],
    reducerEffect: 'latestTemperatureC updated. No lifecycle change.',
  },
  [EVENT_TYPES.UNLOADED_FROM_SHIP]: {
    origin: 'design-decision',
    description: 'The container has been discharged at the port; completes the lifecycle.',
    requiredPayloadFields: ['location'],
    optionalPayloadFields: ['yardBlock', 'notes'],
    reducerEffect: 'state -> UNLOADED; currentLocation = payload.location.',
  },
});

/**
 * Design decision, stated explicitly because the roadmap forbids inventing it
 * silently (roadmap 10.1 / 26 "Temperature rules"):
 *
 * A TEMPERATURE_SPIKE does **not** change the shipment's lifecycle state. The
 * source names the event and requires it to be visible in the timeline and the
 * chart, but defines no business consequence - no quarantine, no rejection, no
 * status transition. Inventing one would put unsourced business rules into the
 * audit trail. Instead the aggregate records the breach (count, latest value,
 * excursion flag) and leaves interpretation to the logistics manager, which is
 * exactly the forensic posture the project is arguing for.
 *
 * The threshold itself is never assumed. It is supplied per shipment in the
 * CONTAINER_CREATED payload (minTemperatureC / maxTemperatureC). If a shipment
 * was created without a range, readings are always recorded as
 * TEMPERATURE_RECORDED and no breach is ever inferred.
 */
export const TEMPERATURE_POLICY = Object.freeze({
  thresholdSource: 'CONTAINER_CREATED.payload.minTemperatureC / maxTemperatureC',
  whenUnset: 'All readings are classified as TEMPERATURE_RECORDED. No breach is inferred.',
  lifecycleEffect: 'None. A breach is recorded, not acted upon.',
  unit: 'degrees Celsius',
});

export const ALL_EVENT_TYPES = Object.freeze(Object.values(EVENT_TYPES));

export const isKnownEventType = (eventType) => ALL_EVENT_TYPES.includes(eventType);
