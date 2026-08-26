import { Router } from 'express';
import { createShipmentCommandRoutes } from '../interfaces/http/commandRoutes/shipmentCommandRoutes.js';
import { createShipmentQueryRoutes } from '../interfaces/http/queryRoutes/shipmentQueryRoutes.js';
import { asyncHandler } from '../interfaces/http/middleware/index.js';
import { authenticate, requireRole } from '../interfaces/http/middleware/auth.js';
import {
  EVENT_CATALOG,
  EVENT_TYPES,
  MOVEMENT_TYPES,
  SHIPMENT_STATES,
  TEMPERATURE_POLICY,
} from '../domain/shipment/events/eventTypes.js';

/**
 * Route composition.
 *
 * The two CQRS routers are mounted side by side under /api. Everything else
 * here is operational surface: health, worker status, and a machine-readable
 * copy of the event catalog.
 */
export function registerRoutes({ app, container }) {
  const { config, shipmentCommandController, shipmentQueryController, logger, authService } = container;

  const api = Router();

  api.post('/auth/login', asyncHandler(async (req, res) => {
    res.json(authService.login(req.body?.username, req.body?.password));
  }));
  api.use(authenticate(authService));

  // --- Command side ---------------------------------------------------------
  api.use(
    createShipmentCommandRoutes({
      controller: shipmentCommandController,
      config,
      logger,
    })
  );

  // --- Query side -----------------------------------------------------------
  api.use(createShipmentQueryRoutes({ controller: shipmentQueryController }));

  // --- Meta -----------------------------------------------------------------
  /**
   * Served from the same constants the reducer validates against, so this
   * cannot drift from the implementation the way a hand-written catalog would.
   */
  api.get('/meta/event-catalog', (req, res) => {
    res.json({
      aggregateType: 'Shipment',
      eventTypes: EVENT_TYPES,
      shipmentStates: SHIPMENT_STATES,
      movementTypes: MOVEMENT_TYPES,
      catalog: EVENT_CATALOG,
      temperaturePolicy: TEMPERATURE_POLICY,
    });
  });

  api.get(
    '/meta/worker',
    asyncHandler(async (req, res) => {
      const checkpoint = await container.checkpointRepository.load(config.worker.name);
      const latestSequence = await container.eventStore.getLatestSequence();
      const deadLetters = await container.checkpointRepository.countDeadLetters();

      res.json({
        worker: {
          name: config.worker.name,
          running: container.projectionWorker.isRunning,
          mode: config.worker.inProcess ? 'in-process' : 'standalone',
          pollIntervalMs: config.worker.pollIntervalMs,
        },
        checkpoint,
        stats: container.projectionWorker.stats,
        // The read-side lag the UI surfaces during the eventual-consistency
        // window.
        lag: { latestSequence, lastProcessedSequence: checkpoint.lastSequence, behindBy: latestSequence - checkpoint.lastSequence },
        deadLetters,
      });
    })
  );

  app.use('/api', api);

  // --- Health (roadmap 9.2 / 21) -------------------------------------------
  app.get(
    '/health',
    asyncHandler(async (req, res) => {
      let databaseOk = true;
      try {
        await container.db.command({ ping: 1 });
      } catch {
        databaseOk = false;
      }

      const status = databaseOk ? 200 : 503;
      res.status(status).json({
        status: databaseOk ? 'ok' : 'degraded',
        service: 'audit-trail-backend',
        persistence: config.persistence,
        database: databaseOk ? 'connected' : 'unavailable',
        worker: container.projectionWorker.isRunning ? 'running' : 'stopped',
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    })
  );

  return app;
}
