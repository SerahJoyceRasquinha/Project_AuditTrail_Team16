import { EVENT_TYPES, SHIPMENT_STATES } from '../events/eventTypes.js';
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
  minTemperatureC: null,
  maxTemperatureC: null,
  latestTemperatureC: null,
  latestTemperatureAt: null,
  temperatureReadingCount: 0,
  temperatureBreachCount: 0,
  temperatureExcursion: false,
  createdAt: null,
  loadedAt: null,
  arrivedAt: null,
  unloadedAt: null,
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
        minTemperatureC: numberOrNull(payload.minTemperatureC),
        maxTemperatureC: numberOrNull(payload.maxTemperatureC),
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
      });

    case EVENT_TYPES.ARRIVED_AT_PORT:
      return Object.freeze({
        ...base,
        currentState: SHIPMENT_STATES.AT_PORT,
        currentLocation: payload.location ?? payload.portName ?? base.currentLocation,
        arrivedAt: event.timestamp,
      });

    case EVENT_TYPES.UNLOADED_FROM_SHIP:
      return Object.freeze({
        ...base,
        currentState: SHIPMENT_STATES.UNLOADED,
        currentLocation: payload.location ?? base.currentLocation,
        unloadedAt: event.timestamp,
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
