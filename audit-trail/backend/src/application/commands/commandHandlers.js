import {
  validateCreateShipmentCommand,
  validateMoveShipmentCommand,
  validateRecordTemperatureCommand,
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
