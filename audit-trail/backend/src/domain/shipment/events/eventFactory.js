import { AGGREGATE_TYPE, isKnownEventType } from './eventTypes.js';
import { ValidationError } from '../../../shared/errors/AppError.js';
import { newId, nowIso, deepFreeze } from '../../../shared/utils/index.js';

/**
 * Current schema version of the event envelope.
 *
 * Roadmap 19 asks for an event-versioning strategy. Every stored event carries
 * `schemaVersion`, so a future change to a payload shape can be handled by
 * upcasting on read rather than by rewriting history - which would violate
 * immutability.
 */
export const EVENT_SCHEMA_VERSION = 1;

/**
 * Builds an event envelope. The factory is the *only* place events are
 * constructed, which is what guarantees every event in the store has the five
 * fields the source requires (aggregateId, eventType, payload, timestamp,
 * version) plus the recommended metadata.
 *
 * Note what is absent: no `hash`, no `sequence`. Those are assigned by the
 * Event Store at append time, because they depend on what is already persisted.
 * The domain layer must not know about storage ordering.
 */
export function createEvent({
  aggregateId,
  eventType,
  payload = {},
  version,
  timestamp = nowIso(),
  correlationId = newId(),
  causationId = null,
  actor = null,
}) {
  if (typeof aggregateId !== 'string' || aggregateId.trim() === '') {
    throw new ValidationError('An event requires a non-empty aggregateId.');
  }
  if (!isKnownEventType(eventType)) {
    throw new ValidationError(`Unknown event type '${eventType}'.`, { eventType });
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError('An event version must be an integer >= 1.', { version });
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('An event payload must be an object.');
  }

  return deepFreeze({
    eventId: newId(),
    aggregateId,
    aggregateType: AGGREGATE_TYPE,
    eventType,
    payload,
    timestamp,
    version,
    schemaVersion: EVENT_SCHEMA_VERSION,
    correlationId,
    causationId,
    // Recorded for the audit trail; null until authentication is introduced
    // (roadmap 26 explicitly leaves auth out of scope).
    actor,
  });
}
