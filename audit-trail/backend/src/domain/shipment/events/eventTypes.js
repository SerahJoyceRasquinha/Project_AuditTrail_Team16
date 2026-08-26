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
import { LIFECYCLE_STAGES, STAGE_LABELS } from '../schedule/schedulePolicy.js';

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
  SHIPMENT_SCHEDULE_PLANNED: 'SHIPMENT_SCHEDULE_PLANNED',
  SHIPMENT_SCHEDULE_REVISED: 'SHIPMENT_SCHEDULE_REVISED',
  SHIPMENT_SCHEDULE_EXTENDED: 'SHIPMENT_SCHEDULE_EXTENDED',
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
  'originLocation',
  'destinationLocation',
  'cargoDescription',
  'carrier',
  'minTemperatureC',
  'maxTemperatureC',
]);

/**
 * Fields that are *never* amendable, listed explicitly so the rule is checkable
 * rather than implied by absence from the list above.
 *
 * `shipmentId` is the stream identity - changing it would mean moving the
 * stream, not correcting it. `createdAt` is the moment the ledger opened, which
 * is the one timestamp a dispute is most likely to turn on. And
 * `estimatedDurationDays` is not immutable but is not a *correction* either: it
 * changes through SHIPMENT_SCHEDULE_EXTENDED, which records why.
 */
export const IMMUTABLE_FIELDS = Object.freeze([
  'shipmentId',
  'aggregateId',
  'createdAt',
  'estimatedDurationDays',
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
    requiredPayloadFields: ['containerCode', 'origin', 'destination', 'estimatedDurationDays'],
    optionalPayloadFields: [
      'originLocation',
      'destinationLocation',
      'cargoDescription',
      'carrier',
      'minTemperatureC',
      'maxTemperatureC',
    ],
    reducerEffect:
      'state -> CREATED; currentLocation = payload.origin; stores the temperature range, the normalised origin/destination locations, and the initial estimated duration (which fixes the planning window).',
  },
  [EVENT_TYPES.LOADED_ON_SHIP]: {
    origin: 'source',
    description: 'The container has been loaded onto a vessel and is now in transit.',
    requiredPayloadFields: ['vesselName', 'location'],
    optionalPayloadFields: ['voyageNumber', 'notes', 'plannedDate', 'varianceDays'],
    reducerEffect: 'state -> IN_TRANSIT; currentLocation = payload.location; vessel recorded.',
  },
  [EVENT_TYPES.TEMPERATURE_SPIKE]: {
    origin: 'source',
    description:
      'A sensor reading fell outside the range declared at creation. Emitted instead of TEMPERATURE_RECORDED; it never replaces or edits an earlier reading.',
    requiredPayloadFields: ['temperatureC', 'recordedAt'],
    optionalPayloadFields: ['sensorId', 'thresholdC', 'direction', 'source'],
    reducerEffect:
      'latestTemperatureC updated; breach counter incremented; temperatureExcursion flag raised. Lifecycle state is deliberately unchanged - see the design decision note below.',
  },
  [EVENT_TYPES.ARRIVED_AT_PORT]: {
    origin: 'source',
    description: 'The vessel carrying the container has arrived at a port.',
    requiredPayloadFields: ['portName', 'location'],
    optionalPayloadFields: ['berth', 'notes', 'plannedDate', 'varianceDays'],
    reducerEffect: 'state -> AT_PORT; currentLocation = payload.location; arrival timestamp recorded.',
  },
  [EVENT_TYPES.TEMPERATURE_RECORDED]: {
    origin: 'design-decision',
    description:
      'An in-range sensor reading. Added because the source requires visualising temperature *fluctuations*, which is impossible if only breaches are stored.',
    requiredPayloadFields: ['temperatureC', 'recordedAt'],
    optionalPayloadFields: ['sensorId', 'source'],
    reducerEffect: 'latestTemperatureC updated. No lifecycle change.',
  },
  [EVENT_TYPES.UNLOADED_FROM_SHIP]: {
    origin: 'design-decision',
    description: 'The container has been discharged at the port; completes the lifecycle.',
    requiredPayloadFields: ['location'],
    optionalPayloadFields: ['yardBlock', 'notes', 'plannedDate', 'varianceDays'],
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
  [EVENT_TYPES.SHIPMENT_SCHEDULE_PLANNED]: {
    origin: 'design-decision',
    description:
      'The first tentative schedule for the three lifecycle stages. It records intent, not fact: nothing has happened yet. Kept separate from SHIPMENT_SCHEDULE_REVISED so an auditor can point at one event and say "this is what was originally promised".',
    requiredPayloadFields: ['schedule'],
    optionalPayloadFields: ['note'],
    reducerEffect:
      'schedule set; originalSchedule captured (once, from this event only); scheduleVersion -> 1. No lifecycle change.',
  },
  [EVENT_TYPES.SHIPMENT_SCHEDULE_REVISED]: {
    origin: 'design-decision',
    description:
      'A change to tentative dates for stages that have not yet been confirmed. Carries the previous plan alongside the new one, so the diff is legible without replaying the stream by hand. Confirmed stages are never re-planned - their dates are historical facts.',
    requiredPayloadFields: ['schedule', 'previousSchedule', 'reason'],
    optionalPayloadFields: ['note', 'changedStages'],
    reducerEffect: 'schedule replaced; originalSchedule untouched; scheduleRevisionCount incremented.',
  },
  [EVENT_TYPES.SHIPMENT_SCHEDULE_EXTENDED]: {
    origin: 'design-decision',
    description:
      'A stage passed its tentative date without being confirmed and the schedule was formally extended. Records the extension in days, the plan before it, the plan after it and the resulting estimated duration - which is precisely what an auditor needs to say "this was originally due on X and was extended to Y, by this many days, for this reason".',
    requiredPayloadFields: ['stage', 'extensionDays', 'previousSchedule', 'schedule', 'estimatedDurationDays'],
    optionalPayloadFields: ['reason', 'previousEstimatedDurationDays'],
    reducerEffect:
      'schedule replaced; estimatedDurationDays updated; originalEstimatedDurationDays and originalSchedule untouched; scheduleExtensionCount and totalExtensionDays incremented.',
  },
});

/**
 * Design decision - how scheduling stays event-sourced
 * ----------------------------------------------------
 * Three rules govern everything above, and they are what keep a *planning*
 * feature from quietly turning this back into a CRUD application:
 *
 * 1. **A plan is a fact about a decision, not a mutable field.** Changing a
 *    tentative date appends SHIPMENT_SCHEDULE_REVISED carrying both the old and
 *    the new plan. Nothing is overwritten, so `GET /shipment/:id/state?at=...`
 *    before the revision still shows what was planned then.
 *
 * 2. **"Overdue" is derived, never stored.** No event sets an overdue flag and
 *    no field holds one. A stage is overdue if its planned date has passed and
 *    its confirming event is absent - computed from the stream and the current
 *    instant by `deriveStageStatuses`. A stored flag would be wrong the moment
 *    the clock moved, and would need a mutation to correct.
 *
 * 3. **Confirmation is a movement, not a checkbox.** Ticking a stage in the UI
 *    dispatches MoveShipment, which the aggregate validates against the stream
 *    (prerequisite present, not already confirmed, version current) before any
 *    event exists. The three confirming events are the source document's own
 *    LOADED_ON_SHIP / ARRIVED_AT_PORT / UNLOADED_FROM_SHIP - the schedule layer
 *    added planning around them, it did not replace them.
 */
export const SCHEDULE_POLICY = Object.freeze({
  stages: LIFECYCLE_STAGES,
  stageLabels: STAGE_LABELS,
  order: 'LOAD_ON_SHIP -> ARRIVE_AT_PORT -> UNLOAD_FROM_SHIP. Enforced by the aggregate, not by the UI.',
  plannedDateFormat: 'YYYY-MM-DD (UTC calendar day). Actual confirmations are full ISO-8601 UTC instants.',
  planningWindow:
    'Opens on the creation day, closes on creation + estimatedDurationDays. Widened only by SHIPMENT_SCHEDULE_EXTENDED.',
  overdue: 'Derived on read from (plannedDate < today) AND (confirming event absent). Never stored.',
  durationRule: 'estimatedDurationDays is a positive whole number of days. Zero, negatives and fractions are rejected.',
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
