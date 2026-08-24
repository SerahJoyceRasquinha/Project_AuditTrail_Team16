function parseOptionalNumber(value) {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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
    // Anything unrecognised falls back to 'active' rather than erroring: a bad
    // view is a harmless client mistake, and silently listing everything
    // (including archived shipments) would be the more surprising outcome.
    const requestedView = String(req.query.view ?? 'active');
    const view = ['active', 'archived', 'all'].includes(requestedView) ? requestedView : 'active';

    const result = await this.#handlers.listShipmentsQueryHandler.handle({
      page: Number.parseInt(req.query.page ?? '1', 10) || 1,
      pageSize: Number.parseInt(req.query.pageSize ?? '20', 10) || 20,
      state: req.query.state ?? null,
      search: req.query.search ?? null,
      origin: req.query.origin ?? null,
      destination: req.query.destination ?? null,
      hasBreach: req.query.hasBreach === undefined ? null : req.query.hasBreach === 'true',
      minTemperature: parseOptionalNumber(req.query.minTemperature),
      maxTemperature: parseOptionalNumber(req.query.maxTemperature),
      lastEventFrom: req.query.lastEventFrom ?? null,
      lastEventTo: req.query.lastEventTo ?? null,
      view,
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
