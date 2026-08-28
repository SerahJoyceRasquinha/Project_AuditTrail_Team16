import { Router } from 'express';
import { createShipmentCommandRoutes } from '../interfaces/http/commandRoutes/shipmentCommandRoutes.js';
import { createShipmentQueryRoutes } from '../interfaces/http/queryRoutes/shipmentQueryRoutes.js';
import { asyncHandler } from '../interfaces/http/middleware/index.js';
import { authenticate, requireRole } from '../interfaces/http/middleware/auth.js';
import {
  AMENDABLE_FIELDS,
  EVENT_CATALOG,
  EVENT_TYPES,
  LIFECYCLE_POLICY,
  MOVEMENT_TYPES,
  SCHEDULE_POLICY,
  SHIPMENT_STATES,
  TEMPERATURE_POLICY,
} from '../domain/shipment/events/eventTypes.js';
import { locationCatalogue } from '../domain/shipment/reference/locations.js';

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

  // --- Authentication (public) ---------------------------------------------
  /**
   * These three routes are mounted BEFORE `authenticate`, because they are how
   * a caller obtains a session in the first place. Everything registered after
   * the `api.use(authenticate(...))` line below requires one.
   *
   * They are also neither commands nor queries in the CQRS sense: they do not
   * touch a shipment, an event or the read model. Placing them outside both
   * routers keeps that boundary honest rather than smuggling account handling
   * into one half of the split.
   */

  /** POST /api/auth/register - create an account and sign in as it. */
  api.post(
    '/auth/register',
    asyncHandler(async (req, res) => {
      const result = await authService.register(req.body ?? {});
      res.status(201).json(result);
    })
  );

  /** POST /api/auth/login - exchange credentials for a session token. */
  api.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const result = await authService.login(req.body?.username, req.body?.password);
      res.status(200).json(result);
    })
  );

  api.use(authenticate(authService));

  /**
   * GET /api/auth/me - who the current token belongs to.
   *
   * This is what lets a page refresh restore the session without the frontend
   * having to trust anything it stored locally. The browser keeps only the
   * token; identity and role are re-derived here from the stored account on
   * every reload, so editing localStorage changes nothing that matters.
   */
  api.get('/auth/me', (req, res) => {
    res.json({ user: req.user });
  });


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
      lifecyclePolicy: LIFECYCLE_POLICY,
      schedulePolicy: SCHEDULE_POLICY,
      amendableFields: AMENDABLE_FIELDS,
    });
  });

  /**
   * GET /api/meta/locations
   *
   * The country/subdivision catalogue the create form's dropdowns are built
   * from. Served from the same module the command validator checks against, so
   * a country/state pair the UI offers is by construction a pair the backend
   * accepts - and adding a country is one edit in the domain layer rather than
   * one per component.
   *
   * Cached for a day: this data changes about as often as the map does.
   */
  api.get('/meta/locations', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(locationCatalogue());
  });

  /** GET /api/meta/sensors - what the temperature monitor is doing, and where its data comes from. */
  api.get('/meta/sensors', (req, res) => {
    res.json({
      monitor: {
        running: container.temperatureMonitor.isRunning,
        ...container.temperatureMonitor.stats,
      },
      /**
       * Stated plainly because it changes how the numbers should be read: a
       * simulated feed is not evidence about a real container, and the UI
       * labels it accordingly wherever it appears.
       */
      dataIsSimulated: config.sensors.source === 'simulated',
    });
  });

  /** GET /api/stream/shipments - SSE notifications for near-real-time refresh. */
  if (config.realtime.enabled) {
    api.get('/stream/shipments', shipmentQueryController.stream);
  }

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
        temperatureMonitor: container.temperatureMonitor.isRunning ? 'running' : 'stopped',
        sensorSource: config.sensors.source,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    })
  );

  return app;
}
