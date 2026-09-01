import { EventStoreRepository } from '../infrastructure/eventStore/eventStoreRepository.js';
import { ShipmentReadModelRepository } from '../infrastructure/readModel/shipmentReadModelRepository.js';
import { CheckpointRepository } from '../infrastructure/projections/checkpointRepository.js';
import { ShipmentIdAllocator } from '../infrastructure/identity/shipmentIdAllocator.js';
import { ShipmentEventBus } from '../infrastructure/realtime/shipmentEventBus.js';
import { createSensorProvider } from '../infrastructure/sensors/sensorGateway.js';
import { TemperatureMonitorService } from '../application/services/temperatureMonitorService.js';

import { ShipmentCommandService } from '../application/services/shipmentCommandService.js';
import { ReplayService } from '../application/services/replayService.js';
import { SensorService } from '../application/services/sensorService.js';
import { ReconciliationService } from '../application/services/reconciliationService.js';
import { AuthService } from '../application/services/authService.js';
import { UserRepository } from '../infrastructure/users/userRepository.js';

import {
  AmendShipmentCommandHandler,
  ArchiveShipmentCommandHandler,
  CreateShipmentCommandHandler,
  MoveShipmentCommandHandler,
  RecordTemperatureCommandHandler,
  RestoreShipmentCommandHandler,
  PlanScheduleCommandHandler,
  ReviseScheduleCommandHandler,
  ExtendScheduleCommandHandler,
} from '../application/commands/commandHandlers.js';

import {
  GetShipmentQueryHandler,
  GetShipmentEventsQueryHandler,
  GetHistoricalStateQueryHandler,
  GetSensorSeriesQueryHandler,
  ListShipmentsQueryHandler,
  VerifyIntegrityQueryHandler,
  ReconcileShipmentQueryHandler,
  GetShipmentScheduleQueryHandler,
  DashboardMetricsQueryHandler,
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
  const shipmentIdAllocator = new ShipmentIdAllocator({ db, eventStore, logger });
  const eventBus = new ShipmentEventBus({ logger });
  const sensorProvider = createSensorProvider({ config, logger });

  // --- Application services -------------------------------------------------
  const shipmentCommandService = new ShipmentCommandService({
    eventStore,
    logger,
    shipmentIdAllocator,
  });
  const replayService = new ReplayService({ eventStore, logger });
  const sensorService = new SensorService({ eventStore });
  const reconciliationService = new ReconciliationService({
    eventStore,
    readModelRepository,
    logger,
    config,
  });
  /**
   * Accounts are stored in their own collection, wired here alongside every
   * other repository. The auth service receives that repository and nothing
   * else from the persistence layer - it has no handle on the Event Store, so
   * no account operation can reach the shipment log.
   */
  const userRepository = new UserRepository({ db });
  const authService = new AuthService(config.auth, { userRepository, logger });

  /**
   * The temperature monitor is given the *command service*, not the event
   * store. That is the whole design in one line: an automated reading takes the
   * identical validated path a hand-entered one takes, and no background job
   * has a private door into the ledger.
   */
  const temperatureMonitor = new TemperatureMonitorService({
    eventStore,
    shipmentCommandService,
    sensorProvider,
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
  const planScheduleCommandHandler = new PlanScheduleCommandHandler({ shipmentCommandService });
  const reviseScheduleCommandHandler = new ReviseScheduleCommandHandler({ shipmentCommandService });
  const extendScheduleCommandHandler = new ExtendScheduleCommandHandler({ shipmentCommandService });

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
  const getShipmentScheduleQueryHandler = new GetShipmentScheduleQueryHandler({ eventStore });
  const exportShipmentHistoryQueryHandler = new ExportShipmentHistoryQueryHandler({ replayService, eventStore });
  const dashboardMetricsQueryHandler = new DashboardMetricsQueryHandler({ readModelRepository });

  // --- Controllers ----------------------------------------------------------
  const shipmentCommandController = new ShipmentCommandController({
    createShipmentCommandHandler,
    moveShipmentCommandHandler,
    recordTemperatureCommandHandler,
    amendShipmentCommandHandler,
    archiveShipmentCommandHandler,
    restoreShipmentCommandHandler,
    planScheduleCommandHandler,
    reviseScheduleCommandHandler,
    extendScheduleCommandHandler,
  });

  const shipmentQueryController = new ShipmentQueryController({
    getShipmentQueryHandler,
    getShipmentEventsQueryHandler,
    getHistoricalStateQueryHandler,
    getSensorSeriesQueryHandler,
    listShipmentsQueryHandler,
    verifyIntegrityQueryHandler,
    reconcileShipmentQueryHandler,
    getShipmentScheduleQueryHandler,
    exportShipmentHistoryQueryHandler,
    dashboardMetricsQueryHandler,
    // The SSE endpoint needs the bus and the heartbeat interval. Passed as a
    // named bundle rather than smuggled in as a handler, because it is not one.
    realtime: { eventBus, config, logger },
  });

  // --- Worker ---------------------------------------------------------------
  const projectionWorker = new ProjectionWorker({
    eventStore,
    readModelRepository,
    checkpointRepository,
    logger,
    config,
    // Notifications are published by the worker *after* the projection is
    // committed, so a client that refetches on the hint finds the read model
    // already able to serve it.
    eventBus,
  });

  return {
    config,
    logger,
    db,
    eventStore,
    readModelRepository,
    checkpointRepository,
    shipmentIdAllocator,
    eventBus,
    sensorProvider,
    temperatureMonitor,
    shipmentCommandService,
    replayService,
    sensorService,
    reconciliationService,
    userRepository,
    authService,
    commandHandlers: {
      createShipmentCommandHandler,
      moveShipmentCommandHandler,
      recordTemperatureCommandHandler,
      amendShipmentCommandHandler,
      archiveShipmentCommandHandler,
      restoreShipmentCommandHandler,
      planScheduleCommandHandler,
      reviseScheduleCommandHandler,
      extendScheduleCommandHandler,
    },
    queryHandlers: {
      getShipmentQueryHandler,
      getShipmentEventsQueryHandler,
      getHistoricalStateQueryHandler,
      getSensorSeriesQueryHandler,
      listShipmentsQueryHandler,
      verifyIntegrityQueryHandler,
      reconcileShipmentQueryHandler,
      getShipmentScheduleQueryHandler,
      exportShipmentHistoryQueryHandler,
      dashboardMetricsQueryHandler,
    },
    shipmentCommandController,
    shipmentQueryController,
    projectionWorker,
  };
}
