import {
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
}

/** Keeps stored payloads free of explicit nulls, so absence is unambiguous. */
function stripNulls(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined)
  );
}
