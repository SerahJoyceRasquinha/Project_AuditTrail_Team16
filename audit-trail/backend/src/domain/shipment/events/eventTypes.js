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
  SHIPMENT_DETAILS_AMENDED: 'SHIPMENT_DETAILS_AMENDED',
  SHIPMENT_ARCHIVED: 'SHIPMENT_ARCHIVED',
  SHIPMENT_RESTORED: 'SHIPMENT_RESTORED',
});

/**
 * The manifest fields a SHIPMENT_DETAILS_AMENDED event may carry.
 *
 * Deliberately a subset of the CONTAINER_CREATED payload. `shipmentId` is the
 * aggregate identity and can never be amended - changing it would mean moving
 * the stream, not correcting it - and lifecycle facts (location, state, vessel)
 * are movement-derived and belong to movement events.
 */
export const AMENDABLE_FIELDS = Object.freeze([
  'containerCode',
  'origin',
  'destination',
  'cargoDescription',
  'carrier',
  'minTemperatureC',
  'maxTemperatureC',
]);

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
  [EVENT_TYPES.SHIPMENT_DETAILS_AMENDED]: {
    origin: 'design-decision',
    description:
      'A correction to the manifest details declared at creation. This is how "editing a shipment" is expressed in an event-sourced ledger: the CONTAINER_CREATED event is never touched, and the amendment is appended as a new fact with its own timestamp and version. The payload carries only the fields that actually changed, so the event answers "what was corrected, and when" rather than restating the whole record.',
    requiredPayloadFields: [],
    optionalPayloadFields: [...AMENDABLE_FIELDS, 'reason'],
    reducerEffect:
      'Overlays the supplied fields onto the current state. Lifecycle state is never changed. currentLocation follows an amended origin only while the shipment is still in CREATED - see the design decision note below.',
  },
  [EVENT_TYPES.SHIPMENT_ARCHIVED]: {
    origin: 'design-decision',
    description:
      'The shipment is withdrawn from the active fleet. This is what "delete" means here. Nothing is removed: the stream, its hash chain and every historical event survive intact, and the shipment remains fully readable, replayable and scrubbable by ID. Only its presence in the default active listing changes.',
    requiredPayloadFields: [],
    optionalPayloadFields: ['reason'],
    reducerEffect: 'archived -> true; archivedAt recorded. Lifecycle state is deliberately unchanged.',
  },
  [EVENT_TYPES.SHIPMENT_RESTORED]: {
    origin: 'design-decision',
    description:
      'Reverses an archival by appending a new fact rather than by removing the SHIPMENT_ARCHIVED event. An archive that could be undone by deletion would defeat the entire point of the ledger.',
    requiredPayloadFields: [],
    optionalPayloadFields: ['reason'],
    reducerEffect: 'archived -> false; restoredAt recorded; archivedAt cleared from the projected state.',
  },
});

/**
 * Design decision - what "update" and "delete" mean in this ledger
 * (the two operations Event Sourcing has no native verb for):
 *
 * **Update.** A shipment's manifest details are corrected by appending
 * SHIPMENT_DETAILS_AMENDED. The original CONTAINER_CREATED payload stays
 * exactly as written, so a dispute about what was *originally* declared is
 * still answerable, and the time scrubber still shows the pre-correction values
 * at any instant before the amendment. An amendment that would change nothing
 * is rejected rather than appended: an audit trail full of no-op events is
 * harder to read and proves nothing.
 *
 * A corrected `origin` moves `currentLocation` only while the shipment is still
 * in CREATED - i.e. it has never physically moved, so its location is still
 * just "where it started". Once a movement event exists, location is a
 * movement-derived fact and a manifest correction must not overwrite it.
 *
 * **Delete.** There is no delete. SHIPMENT_ARCHIVED removes a shipment from the
 * active listing and nothing more; the events, the chain and every query
 * against them remain available. The read model carries the flag, so
 * "active shipments" is a projection concern - which is correct, because
 * archival status is derived state like everything else in the read model.
 *
 * Neither event touches the lifecycle state, for the same reason
 * TEMPERATURE_SPIKE does not: the source document defines no lifecycle
 * consequence for them, and inventing one would put unsourced business rules
 * into the audit trail.
 */
export const LIFECYCLE_POLICY = Object.freeze({
  update: 'SHIPMENT_DETAILS_AMENDED - appended; never edits CONTAINER_CREATED.',
  delete: 'SHIPMENT_ARCHIVED - a listing concern only; no event is ever removed.',
  undelete: 'SHIPMENT_RESTORED - appended; never removes SHIPMENT_ARCHIVED.',
  archivedShipments:
    'Reject further movement, temperature and amendment commands until restored. Remain fully readable, replayable and scrubbable.',
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
