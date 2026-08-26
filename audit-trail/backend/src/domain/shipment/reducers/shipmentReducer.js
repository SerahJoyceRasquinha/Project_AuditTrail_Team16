import { AMENDABLE_FIELDS, EVENT_TYPES, SHIPMENT_STATES } from '../events/eventTypes.js';
import { toPlanDate } from '../schedule/schedulePolicy.js';
import { ValidationError } from '../../../shared/errors/AppError.js';

/**
 * The reducer: `(state, event) -> state`. Pure, synchronous, no I/O.
 *
 * This single function is the mathematical "fold" the source document asks for.
 * It is used by three different callers, which is the whole point of Event
 * Sourcing:
 *
 *   1. the command handler, to rebuild current state before validating;
 *   2. the projection worker, to build the read model incrementally;
 *   3. the historical-state query, to rebuild state as at an arbitrary instant.
 *
 * Because all three share it, they cannot disagree.
 */

export const initialShipmentState = Object.freeze({
  aggregateId: null,
  exists: false,
  version: 0,
  currentState: null,
  currentLocation: null,
  origin: null,
  destination: null,
  containerCode: null,
  cargoDescription: null,
  carrier: null,
  vesselName: null,
  voyageNumber: null,
  originLocation: null,
  destinationLocation: null,
  minTemperatureC: null,
  maxTemperatureC: null,
  latestTemperatureC: null,
  latestTemperatureAt: null,
  temperatureReadingCount: 0,
  temperatureBreachCount: 0,
  temperatureExcursion: false,
  archived: false,
  archivedAt: null,
  restoredAt: null,
  amendmentCount: 0,
  lastAmendedAt: null,
  createdAt: null,
  loadedAt: null,
  arrivedAt: null,
  unloadedAt: null,

  /**
   * Scheduling state, all of it folded from events.
   *
   * `schedule` is the plan as it stands now; `originalSchedule` is the plan as
   * first recorded and is never touched again. Keeping both means "what was
   * originally promised" is answerable from current state, not only by
   * replaying to a past instant - though replay still works, and still agrees.
   *
   * `confirmedStages` is derived from the movement events themselves rather
   * than stored separately, so a stage is confirmed if and only if its event
   * exists. There is no way for the two to disagree.
   *
   * Note what is absent: no `isOverdue`. Overdue is a question about the
   * current instant and is computed on read - see SCHEDULE_POLICY.
   */
  estimatedDurationDays: null,
  originalEstimatedDurationDays: null,
  schedule: null,
  originalSchedule: null,
  confirmedStages: {},
  schedulePlanned: false,
  scheduleRevisionCount: 0,
  scheduleExtensionCount: 0,
  totalExtensionDays: 0,
  lastScheduleChangeAt: null,

  lastEventAt: null,
  lastEventType: null,
});

/**
 * Applies one event to one state.
 *
 * `strict` (default) throws on an unknown event type. Roadmap 10.5 is explicit
 * that an unexpected event must produce a controlled error rather than being
 * silently skipped - silently skipping is how a read model quietly drifts away
 * from the truth. The projection worker passes `strict: false` only when it is
 * deliberately tolerating a forward-compatible event type it does not know yet,
 * and it records that decision in its logs.
 */
export function applyEvent(state, event, { strict = true } = {}) {
  if (!event || typeof event !== 'object') {
    throw new ValidationError('Cannot apply a non-object event.');
  }

  const base = {
    ...state,
    aggregateId: state.aggregateId ?? event.aggregateId,
    version: event.version,
    lastEventAt: event.timestamp,
    lastEventType: event.eventType,
  };
  const payload = event.payload ?? {};

  switch (event.eventType) {
    case EVENT_TYPES.CONTAINER_CREATED:
      return Object.freeze({
        ...base,
        exists: true,
        currentState: SHIPMENT_STATES.CREATED,
        containerCode: payload.containerCode ?? null,
        origin: payload.origin ?? null,
        destination: payload.destination ?? null,
        cargoDescription: payload.cargoDescription ?? null,
        carrier: payload.carrier ?? null,
        currentLocation: payload.origin ?? null,
        originLocation: payload.originLocation ?? null,
        destinationLocation: payload.destinationLocation ?? null,
        minTemperatureC: numberOrNull(payload.minTemperatureC),
        maxTemperatureC: numberOrNull(payload.maxTemperatureC),
        estimatedDurationDays: integerOrNull(payload.estimatedDurationDays),
        // Captured at creation and never written again. Every later change to
        // the duration goes through SHIPMENT_SCHEDULE_EXTENDED, which leaves
        // this alone - so "originally estimated" survives any number of delays.
        originalEstimatedDurationDays: integerOrNull(payload.estimatedDurationDays),
        createdAt: event.timestamp,
      });

    case EVENT_TYPES.LOADED_ON_SHIP:
      return Object.freeze({
        ...base,
        currentState: SHIPMENT_STATES.IN_TRANSIT,
        currentLocation: payload.location ?? base.currentLocation,
        vesselName: payload.vesselName ?? base.vesselName,
        voyageNumber: payload.voyageNumber ?? base.voyageNumber,
        loadedAt: event.timestamp,
        confirmedStages: confirmStage(base, 'LOAD_ON_SHIP', event, payload),
      });

    case EVENT_TYPES.ARRIVED_AT_PORT:
      return Object.freeze({
        ...base,
        currentState: SHIPMENT_STATES.AT_PORT,
        currentLocation: payload.location ?? payload.portName ?? base.currentLocation,
        arrivedAt: event.timestamp,
        confirmedStages: confirmStage(base, 'ARRIVE_AT_PORT', event, payload),
      });

    case EVENT_TYPES.UNLOADED_FROM_SHIP:
      return Object.freeze({
        ...base,
        currentState: SHIPMENT_STATES.UNLOADED,
        currentLocation: payload.location ?? base.currentLocation,
        unloadedAt: event.timestamp,
        confirmedStages: confirmStage(base, 'UNLOAD_FROM_SHIP', event, payload),
      });

    case EVENT_TYPES.TEMPERATURE_RECORDED:
      return Object.freeze({
        ...base,
        latestTemperatureC: numberOrNull(payload.temperatureC),
        latestTemperatureAt: payload.recordedAt ?? event.timestamp,
        temperatureReadingCount: base.temperatureReadingCount + 1,
      });

    case EVENT_TYPES.TEMPERATURE_SPIKE:
      // Deliberately does not touch `currentState`. See TEMPERATURE_POLICY.
      return Object.freeze({
        ...base,
        latestTemperatureC: numberOrNull(payload.temperatureC),
        latestTemperatureAt: payload.recordedAt ?? event.timestamp,
        temperatureReadingCount: base.temperatureReadingCount + 1,
        temperatureBreachCount: base.temperatureBreachCount + 1,
        temperatureExcursion: true,
      });

    /**
     * A manifest correction. Only the fields present in the payload move; an
     * absent field means "not amended", never "cleared". That is what lets the
     * event stay small enough to read as a diff in the timeline.
     */
    case EVENT_TYPES.SHIPMENT_DETAILS_AMENDED: {
      const amended = { ...base };

      for (const field of AMENDABLE_FIELDS) {
        if (payload[field] === undefined) continue;
        amended[field] =
          field === 'minTemperatureC' || field === 'maxTemperatureC'
            ? numberOrNull(payload[field])
            : payload[field];
      }

      // A corrected origin is still "where it is" only while nothing has moved
      // it. After any movement, location belongs to the movement events.
      if (payload.origin !== undefined && base.currentState === SHIPMENT_STATES.CREATED) {
        amended.currentLocation = payload.origin;
      }

      return Object.freeze({
        ...amended,
        amendmentCount: base.amendmentCount + 1,
        lastAmendedAt: event.timestamp,
      });
    }

    /**
     * The first plan. `originalSchedule` is captured here and by nothing else,
     * which is what guarantees it means "as originally planned" no matter how
     * many revisions follow.
     */
    case EVENT_TYPES.SHIPMENT_SCHEDULE_PLANNED:
      return Object.freeze({
        ...base,
        schedule: payload.schedule ?? null,
        originalSchedule: base.originalSchedule ?? payload.schedule ?? null,
        schedulePlanned: true,
        lastScheduleChangeAt: event.timestamp,
      });

    case EVENT_TYPES.SHIPMENT_SCHEDULE_REVISED:
      return Object.freeze({
        ...base,
        schedule: payload.schedule ?? base.schedule,
        // originalSchedule deliberately untouched.
        scheduleRevisionCount: base.scheduleRevisionCount + 1,
        lastScheduleChangeAt: event.timestamp,
      });

    /**
     * A delay. Both the schedule and the estimated duration move; both
     * `originalSchedule` and `originalEstimatedDurationDays` stay exactly where
     * they were, so the difference between promise and outcome is always
     * readable.
     */
    case EVENT_TYPES.SHIPMENT_SCHEDULE_EXTENDED:
      return Object.freeze({
        ...base,
        schedule: payload.schedule ?? base.schedule,
        estimatedDurationDays: integerOrNull(payload.estimatedDurationDays) ?? base.estimatedDurationDays,
        scheduleExtensionCount: base.scheduleExtensionCount + 1,
        totalExtensionDays: base.totalExtensionDays + (integerOrNull(payload.extensionDays) ?? 0),
        lastScheduleChangeAt: event.timestamp,
      });

    // Neither of the next two touches `currentState`: archival is an
    // administrative fact about the ledger, not a physical fact about the
    // container. See LIFECYCLE_POLICY.
    case EVENT_TYPES.SHIPMENT_ARCHIVED:
      return Object.freeze({
        ...base,
        archived: true,
        archivedAt: event.timestamp,
      });

    case EVENT_TYPES.SHIPMENT_RESTORED:
      return Object.freeze({
        ...base,
        archived: false,
        archivedAt: null,
        restoredAt: event.timestamp,
      });

    default:
      if (strict) {
        throw new ValidationError(
          `Cannot replay unknown event type '${event.eventType}' on shipment '${event.aggregateId}'.`,
          { eventType: event.eventType, aggregateId: event.aggregateId, version: event.version }
        );
      }
      return Object.freeze(base);
  }
}

/**
 * Folds an ordered event list into a state.
 *
 * Ordering is asserted rather than assumed: the caller is responsible for
 * sorting by version, and if it gets that wrong the replay fails loudly instead
 * of producing a plausible-looking wrong answer. Roadmap "Mistake 5".
 */
export function replay(events, { strict = true, initial = initialShipmentState } = {}) {
  if (!Array.isArray(events)) throw new ValidationError('replay() expects an array of events.');

  let state = initial;
  let previousVersion = initial.version ?? 0;

  for (const event of events) {
    if (!Number.isInteger(event.version)) {
      throw new ValidationError('Every event must carry an integer version to be replayed.', {
        eventId: event.eventId,
      });
    }
    if (event.version <= previousVersion) {
      throw new ValidationError(
        `Events supplied to replay() are not in ascending version order (saw version ${event.version} after ${previousVersion}).`,
        { aggregateId: event.aggregateId, version: event.version, previousVersion }
      );
    }
    state = applyEvent(state, event, { strict });
    previousVersion = event.version;
  }

  return state;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

/**
 * Records that a lifecycle stage has been confirmed.
 *
 * `plannedDate` is copied from the event payload, not looked up from the
 * current schedule: the plan may be revised after the fact, and "was this
 * confirmation late?" must be answered against the plan that was in force when
 * it happened.
 */
function confirmStage(state, stage, event, payload) {
  return {
    ...state.confirmedStages,
    [stage]: {
      confirmedAt: event.timestamp,
      confirmedOn: toPlanDate(event.timestamp),
      plannedDate: payload.plannedDate ?? state.schedule?.[stage]?.plannedDate ?? null,
      varianceDays: Number.isInteger(payload.varianceDays) ? payload.varianceDays : null,
      /**
       * Version, not eventId.
       *
       * `version` identifies the confirming event deterministically within its
       * stream; `eventId` is a random UUID minted per event. Putting the UUID
       * in reduced state would mean two databases fed the identical command
       * sequence reconstruct states that differ - which would break the
       * determinism the reconstruction test rightly pins down, and with it the
       * claim that state is a pure function of history.
       */
      version: event.version,
    },
  };
}
