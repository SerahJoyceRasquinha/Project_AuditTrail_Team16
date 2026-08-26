import {
  AMENDABLE_FIELDS,
  EVENT_TYPES,
  MOVEMENT_TO_EVENT,
  MOVEMENT_TYPES,
  SHIPMENT_STATES,
} from '../events/eventTypes.js';
import {
  LIFECYCLE_STAGES,
  REVISION_REASONS,
  STAGE_LABELS,
  applyExtension,
  daysBetween,
  planningWindow,
  toPlanDate,
  validatePlannedDates,
} from '../schedule/schedulePolicy.js';
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
  create(command, { timestamp, correlationId, causationId, actor } = {}) {
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
      actor,
      payload: stripNulls({
        containerCode: command.containerCode,
        origin: command.origin,
        destination: command.destination,
        // The normalised country/state pair. Stored alongside the display
        // string rather than instead of it: codes are what queries and
        // comparisons should use, the string is what a human reads in a PDF
        // three years from now.
        originLocation: command.originLocation,
        destinationLocation: command.destinationLocation,
        cargoDescription: command.cargoDescription,
        carrier: command.carrier,
        minTemperatureC: command.minTemperatureC,
        maxTemperatureC: command.maxTemperatureC,
        // The initial planned duration. It fixes the planning window, and it is
        // never edited - only extended, by an event that says why.
        estimatedDurationDays: command.estimatedDurationDays,
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
  move(command, { timestamp, correlationId, causationId, actor } = {}) {
    this.#assertExists();
    this.#assertNotArchived('record a movement');

    const current = this.#state.currentState;
    const eventType = MOVEMENT_TO_EVENT[command.movementType];

    switch (command.movementType) {
      /**
       * Loading is legal only from CREATED.
       *
       * The earlier rule refused only IN_TRANSIT, which left a hole: a
       * container that had already arrived - or been discharged - could be
       * loaded a second time, producing a stream that describes a journey no
       * physical container took. A stage that has happened cannot happen again.
       */
      case MOVEMENT_TYPES.LOAD_ON_SHIP:
        if (current !== SHIPMENT_STATES.CREATED) {
          throw new DomainRuleViolationError(
            current === SHIPMENT_STATES.IN_TRANSIT
              ? `${STAGE_LABELS.LOAD_ON_SHIP} has already been confirmed for shipment '${command.shipmentId}'.`
              : `${STAGE_LABELS.LOAD_ON_SHIP} cannot be confirmed for shipment '${command.shipmentId}' from state '${current}'. This stage has already passed.`,
            { aggregateId: command.shipmentId, currentState: current, requiredState: SHIPMENT_STATES.CREATED }
          );
        }
        break;

      case MOVEMENT_TYPES.ARRIVE_AT_PORT:
        if (current !== SHIPMENT_STATES.IN_TRANSIT) {
          throw new DomainRuleViolationError(
            current === SHIPMENT_STATES.CREATED
              ? `${STAGE_LABELS.ARRIVE_AT_PORT} cannot be confirmed before ${STAGE_LABELS.LOAD_ON_SHIP}.`
              : `${STAGE_LABELS.ARRIVE_AT_PORT} has already been confirmed for shipment '${command.shipmentId}'.`,
            { aggregateId: command.shipmentId, currentState: current, requiredState: SHIPMENT_STATES.IN_TRANSIT }
          );
        }
        break;

      case MOVEMENT_TYPES.UNLOAD_FROM_SHIP:
        if (current !== SHIPMENT_STATES.AT_PORT) {
          throw new DomainRuleViolationError(
            current === SHIPMENT_STATES.UNLOADED
              ? `${STAGE_LABELS.UNLOAD_FROM_SHIP} has already been confirmed for shipment '${command.shipmentId}'.`
              : `${STAGE_LABELS.UNLOAD_FROM_SHIP} cannot be confirmed before ${STAGE_LABELS.ARRIVE_AT_PORT}.`,
            { aggregateId: command.shipmentId, currentState: current, requiredState: SHIPMENT_STATES.AT_PORT }
          );
        }
        break;

      default:
        throw new DomainRuleViolationError(`Unsupported movement type '${command.movementType}'.`);
    }

    const plannedDate = this.#state.schedule?.[command.movementType]?.plannedDate ?? null;
    const varianceDays = plannedDate ? daysBetween(plannedDate, timestamp) : null;

    return createEvent({
      aggregateId: command.shipmentId,
      eventType,
      version: this.#state.version + 1,
      timestamp,
      correlationId,
      causationId,
      actor,
      payload: stripNulls({
        location: command.location,
        vesselName: command.vesselName,
        voyageNumber: command.voyageNumber,
        portName: command.portName,
        berth: command.berth,
        notes: command.notes,
        /**
         * The tentative date this confirmation was measured against, and how
         * far off it landed. Copied into the event rather than looked up later
         * because the plan can be revised afterwards: an auditor asking "was
         * this late?" must get the answer as it stood *at the moment of
         * confirmation*, not as the plan reads today.
         */
        plannedDate,
        varianceDays,
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
  recordTemperature(command, { timestamp, correlationId, causationId, actor } = {}) {
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
        // Written into the immutable payload so a simulated reading can never
        // later be mistaken for a measured one.
        source: command.source ?? 'MANUAL',
        ...(isBreach ? { thresholdC, direction } : {}),
      }),
    });
  }

  /**
   * PlanShipmentSchedule -> SHIPMENT_SCHEDULE_PLANNED.
   *
   * The first tentative schedule for the three lifecycle stages. It records an
   * intention, not an occurrence - which is exactly why it needs to be an event
   * rather than a field. Six weeks later, when the container is three days
   * late, the question an auditor asks is "what did you originally say?", and
   * only an immutable record can answer it.
   *
   * A stream may hold only one of these. Subsequent changes are revisions, and
   * they carry the previous plan with them.
   */
  planSchedule(command, { timestamp, correlationId, causationId } = {}) {
    this.#assertExists();
    this.#assertNotArchived('be scheduled');

    if (this.#state.schedulePlanned) {
      throw new DomainRuleViolationError(
        `Shipment '${command.shipmentId}' already has a schedule. Revise it instead - the original plan must stay on the record.`,
        { aggregateId: command.shipmentId, scheduleRevisionCount: this.#state.scheduleRevisionCount }
      );
    }

    const schedule = this.#validateSchedule(command.schedule, command.shipmentId);

    return createEvent({
      aggregateId: command.shipmentId,
      eventType: EVENT_TYPES.SHIPMENT_SCHEDULE_PLANNED,
      version: this.#state.version + 1,
      timestamp,
      correlationId,
      causationId,
      payload: stripNulls({ schedule, note: command.note }),
    });
  }

  /**
   * ReviseShipmentSchedule -> SHIPMENT_SCHEDULE_REVISED.
   *
   * Changes tentative dates for stages that have not yet happened. Two rules do
   * the real work here:
   *
   *   1. A confirmed stage can never be re-planned. Its date is a historical
   *      fact, and rewriting it would be editing the past through a side door.
   *      `validatePlannedDates` refuses it.
   *   2. The event carries `previousSchedule` as well as the new one. An
   *      auditor should be able to read a single event and see the change,
   *      without folding the whole stream by hand to work out what it replaced.
   *
   * A revision that changes nothing is refused, for the same reason a no-op
   * amendment is: an audit trail whose entries do not each mean something is
   * harder to read and proves less.
   */
  reviseSchedule(command, { timestamp, correlationId, causationId } = {}) {
    this.#assertExists();
    this.#assertNotArchived('have its schedule revised');

    if (!this.#state.schedulePlanned) {
      throw new DomainRuleViolationError(
        `Shipment '${command.shipmentId}' has no schedule to revise yet. Plan one first.`,
        { aggregateId: command.shipmentId }
      );
    }

    const schedule = this.#validateSchedule(command.schedule, command.shipmentId);
    const previousSchedule = this.#state.schedule;

    const changedStages = LIFECYCLE_STAGES.filter(
      (stage) => schedule[stage]?.plannedDate !== previousSchedule?.[stage]?.plannedDate
        || JSON.stringify(schedule[stage]?.details ?? null) !== JSON.stringify(previousSchedule?.[stage]?.details ?? null)
    );

    if (changedStages.length === 0) {
      throw new DomainRuleViolationError(
        `The revision for shipment '${command.shipmentId}' would change nothing. No event was appended.`,
        { aggregateId: command.shipmentId }
      );
    }

    return createEvent({
      aggregateId: command.shipmentId,
      eventType: EVENT_TYPES.SHIPMENT_SCHEDULE_REVISED,
      version: this.#state.version + 1,
      timestamp,
      correlationId,
      causationId,
      payload: stripNulls({
        schedule,
        previousSchedule,
        changedStages,
        reason: command.reason ?? REVISION_REASONS.REPLAN,
        note: command.note,
      }),
    });
  }

  /**
   * ExtendShipmentSchedule -> SHIPMENT_SCHEDULE_EXTENDED.
   *
   * The overdue path. A stage passed its tentative date without being
   * confirmed, and the operator formally books more time.
   *
   * The recalculation is done by `applyExtension` (a pure policy function, so
   * it is testable on its own): the overdue stage moves by `extensionDays`,
   * every later *unconfirmed* stage shifts with it - preserving the gaps the
   * planner originally chose rather than compressing the rest of the voyage -
   * and the estimated duration grows so the plan still fits inside its window.
   *
   * The emitted event carries the plan before, the plan after, the number of
   * days and the reason. That combination is what lets an auditor state, from
   * one record, that the shipment was originally expected to finish on one date
   * and was later extended to another.
   */
  extendSchedule(command, { timestamp, correlationId, causationId } = {}) {
    this.#assertExists();
    this.#assertNotArchived('have its schedule extended');

    if (!this.#state.schedulePlanned) {
      throw new DomainRuleViolationError(
        `Shipment '${command.shipmentId}' has no schedule to extend yet. Plan one first.`,
        { aggregateId: command.shipmentId }
      );
    }

    const stage = command.stage;
    if (!LIFECYCLE_STAGES.includes(stage)) {
      throw new DomainRuleViolationError(`'${stage}' is not a lifecycle stage.`, {
        aggregateId: command.shipmentId,
        stage,
      });
    }

    if (this.#state.confirmedStages?.[stage]) {
      throw new DomainRuleViolationError(
        `${STAGE_LABELS[stage]} has already been confirmed, so its schedule cannot be extended.`,
        { aggregateId: command.shipmentId, stage }
      );
    }

    if (!this.#state.schedule?.[stage]?.plannedDate) {
      throw new DomainRuleViolationError(
        `${STAGE_LABELS[stage]} has no tentative date to extend.`,
        { aggregateId: command.shipmentId, stage }
      );
    }

    const previousSchedule = this.#state.schedule;
    const previousEstimatedDurationDays = this.#state.estimatedDurationDays;

    const extended = applyExtension({
      schedule: previousSchedule,
      confirmedStages: this.#state.confirmedStages ?? {},
      stage,
      extensionDays: command.extensionDays,
      createdAt: this.#state.createdAt,
      estimatedDurationDays: previousEstimatedDurationDays,
    });

    return createEvent({
      aggregateId: command.shipmentId,
      eventType: EVENT_TYPES.SHIPMENT_SCHEDULE_EXTENDED,
      version: this.#state.version + 1,
      timestamp,
      correlationId,
      causationId,
      payload: stripNulls({
        stage,
        extensionDays: command.extensionDays,
        previousSchedule,
        schedule: extended.schedule,
        previousEstimatedDurationDays,
        estimatedDurationDays: extended.estimatedDurationDays,
        reason: command.reason,
      }),
    });
  }

  /**
   * Shared schedule validation.
   *
   * Runs the same pure policy the browser's calendar uses to narrow its ranges.
   * That symmetry is the point: the UI stops most mistakes before a round trip,
   * and a client that skips the UI entirely hits this and is refused anyway.
   */
  #validateSchedule(proposed, shipmentId) {
    const window = planningWindow({
      createdAt: this.#state.createdAt,
      estimatedDurationDays: this.#state.estimatedDurationDays,
    });

    const result = validatePlannedDates(proposed, {
      window,
      confirmedStages: this.#state.confirmedStages ?? {},
    });

    if (!result.ok) {
      throw new DomainRuleViolationError(
        `The schedule for shipment '${shipmentId}' is not valid.`,
        { aggregateId: shipmentId, issues: result.issues, window }
      );
    }

    // Normalised into the canonical stage-keyed shape, so every stored schedule
    // - planned, revised or extended - has an identical structure and the
    // reducer never has to guess which variant it is folding.
    const normalised = {};
    for (const stage of LIFECYCLE_STAGES) {
      const incoming = proposed?.[stage] ?? {};
      const existingOriginal = this.#state.schedule?.[stage]?.originalPlannedDate ?? null;
      normalised[stage] = stripNulls({
        plannedDate: result.dates[stage],
        // Set once, on the first plan, and carried forward untouched by every
        // later revision. This is what makes "originally planned" answerable
        // from current state as well as from history.
        originalPlannedDate: existingOriginal ?? result.dates[stage],
        details: incoming.details ?? this.#state.schedule?.[stage]?.details ?? null,
      });
    }
    return normalised;
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
