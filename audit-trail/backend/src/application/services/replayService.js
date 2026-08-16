import { replay, initialShipmentState } from '../../domain/shipment/reducers/shipmentReducer.js';
import { AggregateNotFoundError } from '../../shared/errors/AppError.js';
import { toEpoch } from '../../shared/utils/index.js';

/**
 * Replay service (roadmap 10.5, 10.6, 12.8).
 *
 * This is the read path that bypasses the read model entirely and goes straight
 * to history. It backs three things: the mid-project reconstruction check, the
 * state scrubber, and the reconciliation job that decides whether the read
 * model has drifted.
 */
export class ReplayService {
  #eventStore;
  #logger;

  constructor({ eventStore, logger }) {
    this.#eventStore = eventStore;
    this.#logger = logger;
  }

  /** Current state, rebuilt from raw events only. */
  async reconstructCurrentState(aggregateId) {
    const events = await this.#eventStore.getEvents(aggregateId);
    if (events.length === 0) throw new AggregateNotFoundError(aggregateId);

    const startedAt = Date.now();
    const state = replay(events);
    this.#logger.debug('Reconstructed current state from events.', {
      aggregateId,
      eventCount: events.length,
      durationMs: Date.now() - startedAt,
    });

    return { state, eventCount: events.length, replayedFrom: 'event-store' };
  }

  /**
   * State as at an instant - the engine behind the time scrubber.
   *
   * The boundary cases from roadmap 12.9 are all handled here and each one
   * returns a distinguishable answer, because "no state yet" and "state with
   * empty fields" must not look the same to the UI:
   *
   *   before the first event -> existedAt: false
   *   exactly on an event    -> that event IS included (inclusive boundary)
   *   between events         -> state after the most recent preceding event
   *   after the last event   -> current state, flagged as such
   */
  async reconstructStateAt(aggregateId, isoTimestamp) {
    const allEvents = await this.#eventStore.getEvents(aggregateId);
    if (allEvents.length === 0) throw new AggregateNotFoundError(aggregateId);

    const boundary = toEpoch(isoTimestamp);
    const firstEventAt = toEpoch(allEvents[0].timestamp);
    const lastEventAt = toEpoch(allEvents[allEvents.length - 1].timestamp);

    const included = allEvents.filter((event) => toEpoch(event.timestamp) <= boundary);

    if (included.length === 0) {
      return {
        aggregateId,
        at: isoTimestamp,
        existedAt: false,
        state: null,
        appliedEventCount: 0,
        totalEventCount: allEvents.length,
        boundary: 'BEFORE_FIRST_EVENT',
        message: 'No shipment state existed at this instant; the first event had not yet occurred.',
        timeline: { firstEventAt: allEvents[0].timestamp, lastEventAt: allEvents[allEvents.length - 1].timestamp },
      };
    }

    const state = replay(included);
    const isExactlyOnEvent = included.some((event) => toEpoch(event.timestamp) === boundary);

    let boundaryKind = 'BETWEEN_EVENTS';
    if (boundary >= lastEventAt) boundaryKind = 'AT_OR_AFTER_LAST_EVENT';
    else if (isExactlyOnEvent) boundaryKind = 'EXACTLY_ON_EVENT';
    else if (boundary < firstEventAt) boundaryKind = 'BEFORE_FIRST_EVENT';

    return {
      aggregateId,
      at: isoTimestamp,
      existedAt: true,
      state,
      appliedEventCount: included.length,
      totalEventCount: allEvents.length,
      boundary: boundaryKind,
      isCurrent: included.length === allEvents.length,
      lastAppliedEvent: {
        eventId: included[included.length - 1].eventId,
        eventType: included[included.length - 1].eventType,
        version: included[included.length - 1].version,
        timestamp: included[included.length - 1].timestamp,
      },
      timeline: { firstEventAt: allEvents[0].timestamp, lastEventAt: allEvents[allEvents.length - 1].timestamp },
    };
  }

  /** Every intermediate state, used by the reconstruction-check tooling. */
  async reconstructStepByStep(aggregateId) {
    const events = await this.#eventStore.getEvents(aggregateId);
    if (events.length === 0) throw new AggregateNotFoundError(aggregateId);

    const steps = [];
    let state = initialShipmentState;
    for (const event of events) {
      state = replay([event], { initial: state });
      steps.push({
        version: event.version,
        eventType: event.eventType,
        timestamp: event.timestamp,
        stateAfter: state,
      });
    }
    return steps;
  }
}
