/**
 * Query controller.
 *
 * Read-only by construction: it is wired with query handlers only, so there is
 * no path from any of these methods to an event append.
 */
export class ShipmentQueryController {
  #handlers;

  constructor(handlers) {
    this.#handlers = handlers;
  }

  getShipment = async (req, res) => {
    const result = await this.#handlers.getShipmentQueryHandler.handle({ shipmentId: req.params.id });
    res.status(200).json(result);
  };

  getEvents = async (req, res) => {
    const result = await this.#handlers.getShipmentEventsQueryHandler.handle({ shipmentId: req.params.id });
    res.status(200).json(result);
  };

  getHistoricalState = async (req, res) => {
    const result = await this.#handlers.getHistoricalStateQueryHandler.handle({
      shipmentId: req.params.id,
      at: req.query.at,
    });
    res.status(200).json(result);
  };

  getSensors = async (req, res) => {
    const result = await this.#handlers.getSensorSeriesQueryHandler.handle({
      shipmentId: req.params.id,
      at: req.query.at ?? null,
    });
    res.status(200).json(result);
  };

  listShipments = async (req, res) => {
    const result = await this.#handlers.listShipmentsQueryHandler.handle({
      page: Number.parseInt(req.query.page ?? '1', 10) || 1,
      pageSize: Number.parseInt(req.query.pageSize ?? '20', 10) || 20,
      state: req.query.state ?? null,
      search: req.query.search ?? null,
    });
    res.status(200).json(result);
  };

  verifyIntegrity = async (req, res) => {
    const result = await this.#handlers.verifyIntegrityQueryHandler.handle({ shipmentId: req.params.id });
    res.status(200).json(result);
  };

  reconcile = async (req, res) => {
    const result = await this.#handlers.reconcileShipmentQueryHandler.handle({ shipmentId: req.params.id });
    res.status(200).json(result);
  };
}
