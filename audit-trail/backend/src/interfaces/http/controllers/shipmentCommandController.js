/**
 * Command controller (roadmap 5.1, step 2).
 *
 * Its entire job is protocol translation: read the HTTP request, call the
 * handler, choose a status code. There is no business logic here, and it never
 * touches a repository. If this file ever grows an `if` about shipment state,
 * something has leaked out of the domain.
 */
export class ShipmentCommandController {
  #createHandler;
  #moveHandler;
  #temperatureHandler;

  constructor({ createShipmentCommandHandler, moveShipmentCommandHandler, recordTemperatureCommandHandler }) {
    this.#createHandler = createShipmentCommandHandler;
    this.#moveHandler = moveShipmentCommandHandler;
    this.#temperatureHandler = recordTemperatureCommandHandler;
  }

  create = async (req, res) => {
    const result = await this.#createHandler.handle(req.body, { correlationId: req.correlationId });
    res.status(201).json(result);
  };

  move = async (req, res) => {
    const result = await this.#moveHandler.handle(req.body, { correlationId: req.correlationId });
    res.status(200).json(result);
  };

  recordTemperature = async (req, res) => {
    const result = await this.#temperatureHandler.handle(req.body, { correlationId: req.correlationId });
    res.status(200).json(result);
  };
}
