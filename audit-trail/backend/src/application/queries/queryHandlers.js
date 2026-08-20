import {
  validateHistoricalStateQuery,
  validateShipmentId,
} from '../../domain/shipment/validators/commandValidators.js';
import { AggregateNotFoundError } from '../../shared/errors/AppError.js';
import { projectState } from '../../infrastructure/projections/shipmentProjection.js';
import { replay } from '../../domain/shipment/reducers/shipmentReducer.js';

/**
 * Query handlers - the read half of CQRS (roadmap 9.4).
 *
 * Every handler here is strictly read-only. None of them appends an event, and
 * none of them can: they are constructed with the read model and the replay
 * service, never with the command service ("Mistake 3").
 */

/**
 * GET /shipment/:id
 *
 * Reads the optimised projection, which is the entire point of the read model.
 * But it also handles the eventual-consistency window honestly (roadmap 12.6):
 * if the worker has not caught up, rather than returning stale data silently or
 * pretending the shipment does not exist, it falls back to replaying the events
 * and labels the response so the UI can say "synchronising".
 */
export class GetShipmentQueryHandler {
  #readModel;
  #eventStore;
  #logger;
  #workerName;

  constructor({ readModelRepository, eventStore, logger, config }) {
    this.#readModel = readModelRepository;
    this.#eventStore = eventStore;
    this.#logger = logger;
    this.#workerName = config?.worker?.name ?? 'unknown';
  }

  async handle({ shipmentId }) {
    validateShipmentId(shipmentId);

    const [projection, storeVersion] = await Promise.all([
      this.#readModel.findById(shipmentId),
      this.#eventStore.getCurrentVersion(shipmentId),
    ]);

    if (storeVersion === 0) throw new AggregateNotFoundError(shipmentId);

    if (projection && projection.currentVersion === storeVersion) {
      return {
        shipment: projection,
        consistency: {
          source: 'read-model',
          projected: true,
          storeVersion,
          projectedVersion: projection.currentVersion,
          lagVersions: 0,
        },
      };
    }

    const lag = storeVersion - (projection?.currentVersion ?? 0);
    this.#logger.debug('Read model has not caught up; serving a replayed view.', {
      aggregateId: shipmentId,
      storeVersion,
      projectedVersion: projection?.currentVersion ?? 0,
      lagVersions: lag,
    });

    const events = await this.#eventStore.getEvents(shipmentId);
    const replayed = projectState(replay(events), {
      lastSequence: events[events.length - 1]?.sequence ?? 0,
      workerName: `${this.#workerName} (on-demand replay)`,
    });

    return {
      shipment: replayed,
      consistency: {
        source: 'event-store-replay',
        projected: false,
        storeVersion,
        projectedVersion: projection?.currentVersion ?? 0,
        lagVersions: lag,
        note: 'The projection worker has not yet caught up. This view was reconstructed from the Event Store, which is authoritative.',
      },
    };
  }
}

/** GET /shipment/:id/events - the raw stream behind the timeline. */
export class GetShipmentEventsQueryHandler {
  #eventStore;

  constructor({ eventStore }) {
    this.#eventStore = eventStore;
  }

  async handle({ shipmentId }) {
    validateShipmentId(shipmentId);
    const events = await this.#eventStore.getEvents(shipmentId);
    if (events.length === 0) throw new AggregateNotFoundError(shipmentId);

    return {
      aggregateId: shipmentId,
      eventCount: events.length,
      // Already ordered by version at the database level. The frontend must not
      // re-sort (roadmap 10.8); it renders what it is given.
      events,
      bounds: {
        firstEventAt: events[0].timestamp,
        lastEventAt: events[events.length - 1].timestamp,
        firstVersion: events[0].version,
        lastVersion: events[events.length - 1].version,
      },
    };
  }
}

/** GET /shipment/:id/state?at=... - the state scrubber's backend. */
export class GetHistoricalStateQueryHandler {
  #replayService;

  constructor({ replayService }) {
    this.#replayService = replayService;
  }

  async handle({ shipmentId, at }) {
    const validated = validateHistoricalStateQuery({ shipmentId, at });
    return this.#replayService.reconstructStateAt(validated.shipmentId, validated.at);
  }
}

/** GET /shipment/:id/sensors - the Recharts data source. */
export class GetSensorSeriesQueryHandler {
  #sensorService;

  constructor({ sensorService }) {
    this.#sensorService = sensorService;
  }

  async handle({ shipmentId, at = null }) {
    validateShipmentId(shipmentId);
    return this.#sensorService.getTemperatureSeries(shipmentId, { at });
  }
}

/** GET /shipments - the dashboard list. */
export class ListShipmentsQueryHandler {
  #readModel;

  constructor({ readModelRepository }) {
    this.#readModel = readModelRepository;
  }

  async handle(filters = {}) {
    return this.#readModel.list(filters);
  }
}

/** GET /shipment/:id/integrity - hash-chain verification. */
export class VerifyIntegrityQueryHandler {
  #eventStore;

  constructor({ eventStore }) {
    this.#eventStore = eventStore;
  }

  async handle({ shipmentId }) {
    validateShipmentId(shipmentId);
    const result = await this.#eventStore.verifyChain(shipmentId);
    if (result.eventCount === 0) throw new AggregateNotFoundError(shipmentId);
    return result;
  }
}

/** GET /shipment/:id/reconciliation - projection vs replay, for the demo. */
export class ReconcileShipmentQueryHandler {
  #reconciliationService;

  constructor({ reconciliationService }) {
    this.#reconciliationService = reconciliationService;
  }

  async handle({ shipmentId }) {
    validateShipmentId(shipmentId);
    return this.#reconciliationService.reconcileOne(shipmentId);
  }
}
