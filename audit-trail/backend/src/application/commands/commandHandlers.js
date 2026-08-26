import {
  validateAmendShipmentCommand,
  validateArchiveShipmentCommand,
  validateCreateShipmentCommand,
  validateMoveShipmentCommand,
  validateRecordTemperatureCommand,
  validateRestoreShipmentCommand,
  validatePlanScheduleCommand,
  validateReviseScheduleCommand,
  validateExtendScheduleCommand,
} from '../../domain/shipment/validators/commandValidators.js';

/**
 * Command handlers - the write half of CQRS (roadmap 9.4).
 *
 * Each handler does three things and nothing else: validate the raw input,
 * hand the clean command to the service, shape the result. No HTTP, no
 * database, no read-model access - a command handler that reads the read model
 * has already broken the separation ("Mistake 4").
 *
 * Handlers receive their dependencies through the constructor rather than
 * importing a singleton, which is what makes them unit-testable with a stub
 * service and is the DI relationship roadmap 9.5 asks for:
 *
 *   Controller -> Handler -> Service -> Repository -> MongoDB
 */

export class CreateShipmentCommandHandler {
  #service;

  constructor({ shipmentCommandService }) {
    this.#service = shipmentCommandService;
  }

  async handle(rawCommand, context = {}) {
    const command = validateCreateShipmentCommand(rawCommand);
    return this.#service.createShipment(command, context);
  }
}

export class MoveShipmentCommandHandler {
  #service;

  constructor({ shipmentCommandService }) {
    this.#service = shipmentCommandService;
  }

  async handle(rawCommand, context = {}) {
    const command = validateMoveShipmentCommand(rawCommand);
    return this.#service.moveShipment(command, context);
  }
}

export class RecordTemperatureCommandHandler {
  #service;

  constructor({ shipmentCommandService }) {
    this.#service = shipmentCommandService;
  }

  async handle(rawCommand, context = {}) {
    const command = validateRecordTemperatureCommand(rawCommand);
    return this.#service.recordTemperature(command, context);
  }
}

/**
 * The lifecycle-management handlers. Same three-line shape as the others: the
 * dashboard's "edit" and "remove" buttons get no privileged path into the
 * system, only another command.
 */
export class AmendShipmentCommandHandler {
  #service;

  constructor({ shipmentCommandService }) {
    this.#service = shipmentCommandService;
  }

  async handle(rawCommand, context = {}) {
    const command = validateAmendShipmentCommand(rawCommand);
    return this.#service.amendShipmentDetails(command, context);
  }
}

export class ArchiveShipmentCommandHandler {
  #service;

  constructor({ shipmentCommandService }) {
    this.#service = shipmentCommandService;
  }

  async handle(rawCommand, context = {}) {
    const command = validateArchiveShipmentCommand(rawCommand);
    return this.#service.archiveShipment(command, context);
  }
}

export class RestoreShipmentCommandHandler {
  #service;

  constructor({ shipmentCommandService }) {
    this.#service = shipmentCommandService;
  }

  async handle(rawCommand, context = {}) {
    const command = validateRestoreShipmentCommand(rawCommand);
    return this.#service.restoreShipment(command, context);
  }
}

/**
 * Scheduling handlers. Same three-line shape as the rest: validate, delegate,
 * return. The planning UI is richer than the old command panel, but it gets no
 * richer access - it issues business commands and nothing else.
 */
export class PlanScheduleCommandHandler {
  #service;

  constructor({ shipmentCommandService }) {
    this.#service = shipmentCommandService;
  }

  async handle(rawCommand, context = {}) {
    const command = validatePlanScheduleCommand(rawCommand);
    return this.#service.planSchedule(command, context);
  }
}

export class ReviseScheduleCommandHandler {
  #service;

  constructor({ shipmentCommandService }) {
    this.#service = shipmentCommandService;
  }

  async handle(rawCommand, context = {}) {
    const command = validateReviseScheduleCommand(rawCommand);
    return this.#service.reviseSchedule(command, context);
  }
}

export class ExtendScheduleCommandHandler {
  #service;

  constructor({ shipmentCommandService }) {
    this.#service = shipmentCommandService;
  }

  async handle(rawCommand, context = {}) {
    const command = validateExtendScheduleCommand(rawCommand);
    return this.#service.extendSchedule(command, context);
  }
}
