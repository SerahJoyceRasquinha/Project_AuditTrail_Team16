import { EventStoreRepository } from '../infrastructure/eventStore/eventStoreRepository.js';
import { ShipmentReadModelRepository } from '../infrastructure/readModel/shipmentReadModelRepository.js';
import { CheckpointRepository } from '../infrastructure/projections/checkpointRepository.js';

import { ShipmentCommandService } from '../application/services/shipmentCommandService.js';
import { ReplayService } from '../application/services/replayService.js';
import { SensorService } from '../application/services/sensorService.js';
import { ReconciliationService } from '../application/services/reconciliationService.js';

import {
  AmendShipmentCommandHandler,
  ArchiveShipmentCommandHandler,
  CreateShipmentCommandHandler,
  MoveShipmentCommandHandler,
  RecordTemperatureCommandHandler,
  RestoreShipmentCommandHandler,
} from '../application/commands/commandHandlers.js';

import {
  GetShipmentQueryHandler,
  GetShipmentEventsQueryHandler,
  GetHistoricalStateQueryHandler,
  GetSensorSeriesQueryHandler,
  ListShipmentsQueryHandler,
  VerifyIntegrityQueryHandler,
  ReconcileShipmentQueryHandler,
} from '../application/queries/queryHandlers.js';
import { ExportShipmentHistoryQueryHandler } from '../application/queries/exportShipmentHistory.js';

import { ShipmentCommandController } from '../interfaces/http/controllers/shipmentCommandController.js';
import { ShipmentQueryController } from '../interfaces/http/controllers/shipmentQueryController.js';
import { ProjectionWorker } from '../workers/projectionWorker/projectionWorker.js';

/**
 * The composition root (roadmap 9.5).
 *
 * This is the only file in the backend that knows how the object graph is
 * wired. Everything else receives what it needs through its constructor, which
 * is why there is not a single database singleton imported anywhere in the
 * domain or application layers - and why every one of those classes can be
 * tested with a stub in one line.
 *
 * Manual DI is used deliberately rather than a container library. The graph is
 * small enough to read top-to-bottom, and the roadmap explicitly recommends
 * lightweight manual injection unless a framework is genuinely required.
 *
 * Construction order follows the dependency direction the roadmap sets out:
 *   database -> repositories -> services -> handlers -> controllers -> routes
 */
export function buildContainer({ db, config, logger }) {
  // --- Infrastructure -------------------------------------------------------
  const eventStore = new EventStoreRepository({ db, logger, limits: config.limits });
  const readModelRepository = new ShipmentReadModelRepository({ db, limits: config.limits });
  const checkpointRepository = new CheckpointRepository({ db });

  // --- Application services -------------------------------------------------
  const shipmentCommandService = new ShipmentCommandService({ eventStore, logger });
  const replayService = new ReplayService({ eventStore, logger });
  const sensorService = new SensorService({ eventStore });
  const reconciliationService = new ReconciliationService({
    eventStore,
    readModelRepository,
    logger,
    config,
  });

  // --- Command handlers (write side) ---------------------------------------
  const createShipmentCommandHandler = new CreateShipmentCommandHandler({ shipmentCommandService });
  const moveShipmentCommandHandler = new MoveShipmentCommandHandler({ shipmentCommandService });
  const recordTemperatureCommandHandler = new RecordTemperatureCommandHandler({ shipmentCommandService });
  const amendShipmentCommandHandler = new AmendShipmentCommandHandler({ shipmentCommandService });
  const archiveShipmentCommandHandler = new ArchiveShipmentCommandHandler({ shipmentCommandService });
  const restoreShipmentCommandHandler = new RestoreShipmentCommandHandler({ shipmentCommandService });

  // --- Query handlers (read side) ------------------------------------------
  const getShipmentQueryHandler = new GetShipmentQueryHandler({
    readModelRepository,
    eventStore,
    logger,
    config,
  });
  const getShipmentEventsQueryHandler = new GetShipmentEventsQueryHandler({ eventStore });
  const getHistoricalStateQueryHandler = new GetHistoricalStateQueryHandler({ replayService });
  const getSensorSeriesQueryHandler = new GetSensorSeriesQueryHandler({ sensorService });
  const listShipmentsQueryHandler = new ListShipmentsQueryHandler({ readModelRepository });
  const verifyIntegrityQueryHandler = new VerifyIntegrityQueryHandler({ eventStore });
  const reconcileShipmentQueryHandler = new ReconcileShipmentQueryHandler({ reconciliationService });
  const exportShipmentHistoryQueryHandler = new ExportShipmentHistoryQueryHandler({ replayService, eventStore });

  // --- Controllers ----------------------------------------------------------
  const shipmentCommandController = new ShipmentCommandController({
    createShipmentCommandHandler,
    moveShipmentCommandHandler,
    recordTemperatureCommandHandler,
    amendShipmentCommandHandler,
    archiveShipmentCommandHandler,
    restoreShipmentCommandHandler,
  });

  const shipmentQueryController = new ShipmentQueryController({
    getShipmentQueryHandler,
    getShipmentEventsQueryHandler,
    getHistoricalStateQueryHandler,
    getSensorSeriesQueryHandler,
    listShipmentsQueryHandler,
    verifyIntegrityQueryHandler,
    reconcileShipmentQueryHandler,
    exportShipmentHistoryQueryHandler,
  });

  // --- Worker ---------------------------------------------------------------
  const projectionWorker = new ProjectionWorker({
    eventStore,
    readModelRepository,
    checkpointRepository,
    logger,
    config,
  });

  return {
    config,
    logger,
    db,
    eventStore,
    readModelRepository,
    checkpointRepository,
    shipmentCommandService,
    replayService,
    sensorService,
    reconciliationService,
    commandHandlers: {
      createShipmentCommandHandler,
      moveShipmentCommandHandler,
      recordTemperatureCommandHandler,
      amendShipmentCommandHandler,
      archiveShipmentCommandHandler,
      restoreShipmentCommandHandler,
    },
    queryHandlers: {
      getShipmentQueryHandler,
      getShipmentEventsQueryHandler,
      getHistoricalStateQueryHandler,
      getSensorSeriesQueryHandler,
      listShipmentsQueryHandler,
      verifyIntegrityQueryHandler,
      reconcileShipmentQueryHandler,
      exportShipmentHistoryQueryHandler,
    },
    shipmentCommandController,
    shipmentQueryController,
    projectionWorker,
  };
}
