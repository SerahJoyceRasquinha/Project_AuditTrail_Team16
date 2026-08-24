import {
  AMENDABLE_FIELDS,
  EVENT_TYPES,
  MOVEMENT_TO_EVENT,
  MOVEMENT_TYPES,
  SHIPMENT_STATES,
} from '../events/eventTypes.js';
import { createEvent } from '../events/eventFactory.js';
import { replay, initialShipmentState } from '../reducers/shipmentReducer.js';
import { AggregateNotFoundError, DomainRuleViolationError } from '../../../shared/errors/AppError.js';

/**
 * The Shipment aggregate.
 *
 * Every function here has the same shape: `(state, command) -> event`. They are
 * pure - no database, no clock beyond the timestamp passed in, no I/O - which
 * is why the domain rules can be unit-tested without any infrastructure at all.
 *
 * The aggregate never writes. Persisting the returned event is the command
 * handler's job, and appending it is the Event Store's job. That separation is
 * what keeps "decide" and "record" from collapsing into an UPDATE
 * (roadmap "Mistake 1").
 */
export class ShipmentAggregate {
  #state;

  constructor(state = initialShipmentState) {
    this.#state = state;
  }

  /** Rebuilds an aggregate by folding its event history. */
  static fromHistory(events) {
    return new ShipmentAggregate(replay(events));
  }

  get state() {
    return this.#state;
  }

  get version() {
    return this.#state.version;
  }

  get exists() {
    return this.#state.exists;
  }

  #assertExists() {
    if (!this.#state.exists) {
      throw new AggregateNotFoundError(this.#state.aggregateId ?? 'unknown');
    }
  }

  /**
   * An archived shipment has been withdrawn from the active fleet, so recording
   * new facts against it would be recording facts about something nobody is
   * operating. It stays fully readable; it just stops accepting commands until
   * it is restored.
   */
  #assertNotArchived(action) {
    if (this.#state.archived) {
      throw new DomainRuleViolationError(
        `Shipment '${this.#state.aggregateId}' is archived and cannot ${action}. Restore it first; its history is intact and unchanged.`,
        { aggregateId: this.#state.aggregateId, archived: true, archivedAt: this.#state.archivedAt }
      );
    }
  }

  /**
   * CreateShipment -> CONTAINER_CREATED.
   *
   * A stream may only ever have one creation event; re-creating would give the
   * aggregate two origins and make replay ambiguous.
   */
  create(command, { timestamp, correlationId, causationId } = {}) {
    if (this.#state.exists) {
      throw new DomainRuleViolationError(
        `Shipment '${command.shipmentId}' already exists (currently at version ${this.#state.version}). A stream can contain only one CONTAINER_CREATED event.`,
        { aggregateId: command.shipmentId, currentVersion: this.#state.version }
      );
    }

    return createEvent({
      aggregateId: command.shipmentId,
      eventType: EVENT_TYPES.CONTAINER_CREATED,
      version: 1,
      timestamp,
      correlationId,
      causationId,
      payload: stripNulls({
        containerCode: command.containerCode,
        origin: command.origin,
        destination: command.destination,
        cargoDescription: command.cargoDescription,
        carrier: command.carrier,
        minTemperatureC: command.minTemperatureC,
        maxTemperatureC: command.maxTemperatureC,
      }),
    });
  }

  /**
   * MoveShipment -> LOADED_ON_SHIP | ARRIVED_AT_PORT | UNLOADED_FROM_SHIP.
   *
   * The lifecycle rules below are design decisions (the source names the events
   * but not the legal transitions), chosen so that the recorded history cannot
   * describe a physically impossible journey - a container cannot arrive at a
   * port before it was ever loaded.
   */
  move(command, { timestamp, correlationId, causationId } = {}) {
    this.#assertExists();
    this.#assertNotArchived('record a movement');

    const current = this.#state.currentState;
    const eventType = MOVEMENT_TO_EVENT[command.movementType];

    switch (command.movementType) {
      case MOVEMENT_TYPES.LOAD_ON_SHIP:
        if (current === SHIPMENT_STATES.IN_TRANSIT) {
          throw new DomainRuleViolationError(
            `Shipment '${command.shipmentId}' is already in transit and cannot be loaded again.`,
            { aggregateId: command.shipmentId, currentState: current }
          );
        }
        break;

      case MOVEMENT_TYPES.ARRIVE_AT_PORT:
        if (current !== SHIPMENT_STATES.IN_TRANSIT) {
          throw new DomainRuleViolationError(
            `Shipment '${command.shipmentId}' cannot arrive at a port from state '${current}'. It must be IN_TRANSIT.`,
            { aggregateId: command.shipmentId, currentState: current, requiredState: SHIPMENT_STATES.IN_TRANSIT }
          );
        }
        break;

      case MOVEMENT_TYPES.UNLOAD_FROM_SHIP:
        if (current !== SHIPMENT_STATES.AT_PORT) {
          throw new DomainRuleViolationError(
            `Shipment '${command.shipmentId}' cannot be unloaded from state '${current}'. It must be AT_PORT.`,
            { aggregateId: command.shipmentId, currentState: current, requiredState: SHIPMENT_STATES.AT_PORT }
          );
        }
        break;

      default:
        throw new DomainRuleViolationError(`Unsupported movement type '${command.movementType}'.`);
    }

    return createEvent({
      aggregateId: command.shipmentId,
      eventType,
      version: this.#state.version + 1,
      timestamp,
      correlationId,
      causationId,
      payload: stripNulls({
        location: command.location,
        vesselName: command.vesselName,
        voyageNumber: command.voyageNumber,
        portName: command.portName,
        berth: command.berth,
        notes: command.notes,
      }),
    });
  }

  /**
   * RecordTemperature -> TEMPERATURE_RECORDED | TEMPERATURE_SPIKE.
   *
   * Which of the two is emitted is decided *here*, at write time, against the
   * range declared when the container was created. That matters: the
   * classification becomes part of the immutable record, so re-reading history
   * later cannot silently reclassify past readings if someone changes a
   * threshold constant.
   */
  recordTemperature(command, { timestamp, correlationId, causationId } = {}) {
    this.#assertExists();
    this.#assertNotArchived('accept a temperature reading');

    const { minTemperatureC, maxTemperatureC } = this.#state;
    const hasRange = minTemperatureC !== null && maxTemperatureC !== null;

    let isBreach = false;
    let direction = null;
    let thresholdC = null;

    if (hasRange) {
      if (command.temperatureC > maxTemperatureC) {
        isBreach = true;
        direction = 'ABOVE_MAX';
        thresholdC = maxTemperatureC;
      } else if (command.temperatureC < minTemperatureC) {
        isBreach = true;
        direction = 'BELOW_MIN';
        thresholdC = minTemperatureC;
      }
    }

    return createEvent({
      aggregateId: command.shipmentId,
      eventType: isBreach ? EVENT_TYPES.TEMPERATURE_SPIKE : EVENT_TYPES.TEMPERATURE_RECORDED,
      version: this.#state.version + 1,
      timestamp,
      correlationId,
      causationId,
      payload: stripNulls({
        temperatureC: command.temperatureC,
        recordedAt: command.recordedAt ?? timestamp,
        sensorId: command.sensorId,
        ...(isBreach ? { thresholdC, direction } : {}),
      }),
    });
  }

  /**
   * AmendShipmentDetails -> SHIPMENT_DETAILS_AMENDED.
   *
   * This is the event-sourced answer to "edit this shipment". The original
   * CONTAINER_CREATED event is not touched, is not re-read, and cannot be
   * reached from here - the aggregate only ever returns new events.
   *
   * Two rules worth their weight:
   *
   *   1. Only fields that genuinely *differ* from current state are carried, so
   *      the stored event reads as a diff and the timeline shows exactly what
   *      was corrected.
   *   2. If nothing differs, the command is refused. Appending an event that
   *      changes nothing pollutes an audit trail whose entire value is that
   *      every entry means something.
   */
  amendDetails(command, { timestamp, correlationId, causationId } = {}) {
    this.#assertExists();
    this.#assertNotArchived('be amended');

    const changes = {};
    for (const field of AMENDABLE_FIELDS) {
      const proposed = command[field];
      if (proposed === undefined || proposed === null) continue;
      if (proposed === this.#state[field]) continue;
      changes[field] = proposed;
    }

    if (Object.keys(changes).length === 0) {
      throw new DomainRuleViolationError(
        `The amendment for shipment '${command.shipmentId}' would change nothing. No event was appended; an audit trail should not carry entries that record no change.`,
        { aggregateId: command.shipmentId, currentVersion: this.#state.version }
      );
    }

    /**
     * The declared range classifies every future reading, so the two bounds are
     * only meaningful together. If either is amended, both are written, taking
     * the unamended side from current state - otherwise a stream could end up
     * with a half-declared range that the reducer cannot use.
     */
    if (changes.minTemperatureC !== undefined || changes.maxTemperatureC !== undefined) {
      const min = changes.minTemperatureC ?? this.#state.minTemperatureC;
      const max = changes.maxTemperatureC ?? this.#state.maxTemperatureC;

      if (min === null || max === null) {
        throw new DomainRuleViolationError(
          `Amending the temperature range on shipment '${command.shipmentId}' requires both bounds. A one-sided range cannot classify a breach.`,
          { aggregateId: command.shipmentId, minTemperatureC: min, maxTemperatureC: max }
        );
      }
      if (min > max) {
        throw new DomainRuleViolationError(
          `'minTemperatureC' (${min}) cannot be greater than 'maxTemperatureC' (${max}).`,
          { aggregateId: command.shipmentId, minTemperatureC: min, maxTemperatureC: max }
        );
      }

      changes.minTemperatureC = min;
      changes.maxTemperatureC = max;
    }

    return createEvent({
      aggregateId: command.shipmentId,
      eventType: EVENT_TYPES.SHIPMENT_DETAILS_AMENDED,
      version: this.#state.version + 1,
      timestamp,
      correlationId,
      causationId,
      payload: stripNulls({ ...changes, reason: command.reason }),
    });
  }

  /**
   * ArchiveShipment -> SHIPMENT_ARCHIVED.
   *
   * The closest this system has to "delete", and deliberately not close at all:
   * it appends a fact, and every earlier event remains readable, hashable and
   * replayable afterwards.
   */
  archive(command, { timestamp, correlationId, causationId } = {}) {
    this.#assertExists();

    if (this.#state.archived) {
      throw new DomainRuleViolationError(
        `Shipment '${command.shipmentId}' is already archived (since ${this.#state.archivedAt}).`,
        { aggregateId: command.shipmentId, archivedAt: this.#state.archivedAt }
      );
    }

    return createEvent({
      aggregateId: command.shipmentId,
      eventType: EVENT_TYPES.SHIPMENT_ARCHIVED,
      version: this.#state.version + 1,
      timestamp,
      correlationId,
      causationId,
      payload: stripNulls({ reason: command.reason }),
    });
  }

  /** RestoreShipment -> SHIPMENT_RESTORED. Undo by appending, never by deleting. */
  restore(command, { timestamp, correlationId, causationId } = {}) {
    this.#assertExists();

    if (!this.#state.archived) {
      throw new DomainRuleViolationError(
        `Shipment '${command.shipmentId}' is not archived, so there is nothing to restore.`,
        { aggregateId: command.shipmentId, archived: false }
      );
    }

    return createEvent({
      aggregateId: command.shipmentId,
      eventType: EVENT_TYPES.SHIPMENT_RESTORED,
      version: this.#state.version + 1,
      timestamp,
      correlationId,
      causationId,
      payload: stripNulls({ reason: command.reason }),
    });
  }
}

/** Keeps stored payloads free of explicit nulls, so absence is unambiguous. */
function stripNulls(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined)
  );
}
