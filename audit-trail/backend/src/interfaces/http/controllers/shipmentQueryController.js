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

  exportHistory = async (req, res) => {
    // The query handler generates PDF/CSV streams directly to the response object.
    await this.#handlers.exportShipmentHistoryQueryHandler.handle({
      shipmentId: req.params.id,
      format: req.query.format || 'csv',
      res,
    });
  };

  /**
   * GET /api/shipment/:id/schedule - the planner's read model.
   *
   * Returns the plan, every stage's derived status against the current instant,
   * and the bounds the calendar must respect. The browser narrows its date
   * pickers from exactly these numbers, so the UI and the backend agree on what
   * is selectable without the rules being written twice.
   */
  getSchedule = async (req, res) => {
    const result = await this.#handlers.getShipmentScheduleQueryHandler.handle({
      shipmentId: req.params.id,
    });
    res.status(200).json(result);
  };

  /**
   * GET /api/stream/shipments - server-sent events.
   *
   * A notification channel, not a data channel: each message says which
   * shipment reached which version, and the browser responds by re-running its
   * ordinary queries. That keeps the read model the thing being read and leaves
   * CQRS intact, while removing the poll-interval delay between one operator
   * confirming a stage and another seeing it.
   */
  stream = async (req, res) => {
    const { eventBus, config, logger } = this.#handlers.realtime;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer by default, which would defeat the point.
      'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('connected', { at: new Date().toISOString(), shipmentId: req.query.shipmentId ?? null });

    const unsubscribe = eventBus.subscribe((notification) => send('shipment', notification), {
      aggregateId: req.query.shipmentId ?? null,
    });

    // Keeps intermediaries from closing an idle connection, and lets the client
    // notice a dead link rather than waiting forever on a socket that will
    // never speak again.
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), config.realtime.heartbeatMs);

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      logger.debug('Realtime subscriber disconnected.');
    };

    req.on('close', close);
    req.on('error', close);
  };
}
