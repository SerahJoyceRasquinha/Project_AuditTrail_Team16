import { ShipmentAggregate } from '../../domain/shipment/aggregate/shipmentAggregate.js';
import { ConcurrencyConflictError, ValidationError } from '../../shared/errors/AppError.js';
import { newId, nowIso } from '../../shared/utils/index.js';

/**
 * The write-side service (roadmap 5.1, steps 3-4).
 *
 * The sequence is always the same, and it is the sequence that makes this Event
 * Sourcing rather than CRUD-with-a-log:
 *
 *   load history -> fold to current state -> check expected version
 *   -> ask the aggregate to decide -> append the resulting event
 *
 * State is never read from the read model here. The read model is eventually
 * consistent, and validating a command against possibly-stale data is how an
 * event-sourced system quietly loses its guarantees ("Mistake 7").
 */
export class ShipmentCommandService {
  #eventStore;
  #logger;

  constructor({ eventStore, logger }) {
    this.#eventStore = eventStore;
    this.#logger = logger;
  }

  /** Rebuilds an aggregate from its full stream. */
  async #load(shipmentId) {
    const events = await this.#eventStore.getEvents(shipmentId);
    return { aggregate: ShipmentAggregate.fromHistory(events), events };
  }

  /**
   * Shared execution path for every command.
   *
   * `decide` receives the loaded aggregate and returns exactly one event. It is
   * a callback rather than a switch statement so that adding a command means
   * adding a handler, not editing this method.
   */
  async #execute({ shipmentId, expectedVersion, requireExisting, decide, commandName, correlationId, command }) {
    const startedAt = Date.now();
    const correlation = correlationId ?? newId();
    const log = this.#logger.child({ correlationId: correlation, command: commandName, aggregateId: shipmentId });

    const { aggregate } = await this.#load(shipmentId);
    const currentVersion = aggregate.version;

    // OCC pre-check (roadmap 13.1). The authoritative check happens again
    // inside the Event Store against the unique index; this one exists to give
    // a precise, actionable error in the ordinary case.
    if (expectedVersion !== null && expectedVersion !== undefined && expectedVersion !== currentVersion) {
      log.warn('Command rejected: optimistic concurrency conflict.', {
        expectedVersion,
        currentVersion,
        conflict: true,
      });
      throw new ConcurrencyConflictError({ aggregateId: shipmentId, expectedVersion, currentVersion });
    }

    if (requireExisting && !aggregate.exists) {
      log.warn('Command rejected: no such aggregate.');
    }

    /**
     * Event time.
     *
     * Defaults to now. A command may supply `occurredAt` to record when
     * something actually happened — needed when backfilling an existing
     * history or seeding a dataset that spans days.
     *
     * It is refused if it would place the event before its own predecessor.
     * Version already fixes the order events are replayed in, but a timestamp
     * that contradicts that order would corrupt every time-based reading of the
     * ledger: the scrubber, the chart, and any dispute about when something
     * happened. So chronology is enforced rather than assumed.
     */
    const timestamp = command?.occurredAt ?? nowIso();
    const previousAt = aggregate.state.lastEventAt;

    if (command?.occurredAt && previousAt && Date.parse(timestamp) < Date.parse(previousAt)) {
      throw new ValidationError(
        `'occurredAt' (${timestamp}) is earlier than the previous event on this shipment (${previousAt}). Events cannot be inserted into the past.`,
        { field: 'occurredAt', occurredAt: timestamp, previousEventAt: previousAt }
      );
    }

    const event = decide(aggregate, { timestamp, correlationId: correlation, causationId: null });

    const stored = await this.#eventStore.append(event, { expectedVersion: currentVersion });

    log.info('Command accepted.', {
      eventId: stored.eventId,
      eventType: stored.eventType,
      version: stored.version,
      expectedVersion,
      durationMs: Date.now() - startedAt,
      result: 'accepted',
    });

    return {
      accepted: true,
      aggregateId: stored.aggregateId,
      eventId: stored.eventId,
      eventType: stored.eventType,
      version: stored.version,
      timestamp: stored.timestamp,
      correlationId: correlation,
      hash: stored.hash,
      /**
       * Roadmap 12.6: a successful command does NOT mean the read model has
       * caught up. Saying so explicitly in the response is what lets the UI
       * show "synchronising" instead of pretending the query side is current.
       */
      readModelConsistency: 'eventual',
    };
  }

  async createShipment(command, { correlationId } = {}) {
    return this.#execute({
      shipmentId: command.shipmentId,
      // Creation asserts version 0: "I believe this stream does not exist yet."
      expectedVersion: 0,
      requireExisting: false,
      commandName: 'CreateShipment',
      correlationId,
      command,
      decide: (aggregate, context) => aggregate.create(command, context),
    });
  }

  async moveShipment(command, { correlationId } = {}) {
    return this.#execute({
      shipmentId: command.shipmentId,
      expectedVersion: command.expectedVersion,
      requireExisting: true,
      commandName: 'MoveShipment',
      correlationId,
      command,
      decide: (aggregate, context) => aggregate.move(command, context),
    });
  }

  async recordTemperature(command, { correlationId } = {}) {
    return this.#execute({
      shipmentId: command.shipmentId,
      expectedVersion: command.expectedVersion,
      requireExisting: true,
      commandName: 'RecordTemperature',
      correlationId,
      command,
      decide: (aggregate, context) => aggregate.recordTemperature(command, context),
    });
  }
}
