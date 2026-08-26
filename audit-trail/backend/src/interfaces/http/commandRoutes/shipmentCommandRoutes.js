import { Router } from 'express';
import { asyncHandler, rateLimiter, tagCqrsSide } from '../middleware/index.js';
import { requireRole } from '../middleware/auth.js';

/**
 * The **Command** router (roadmap 9.4, Week 1).
 *
 * The source document specifies the split literally: "Create separate routers
 * for Commands (e.g., POST /shipment/move) and Queries (e.g., GET
 * /shipment/:id)". So the paths match the source exactly and the separation
 * lives in the routers, not in a URL prefix - both are mounted under /api.
 *
 * This router is only ever constructed with the command controller. There is no
 * query handler in scope, so a query cannot be served from here even by
 * accident.
 */
export function createShipmentCommandRoutes({ controller, config, logger }) {
  const router = Router();

  router.use(tagCqrsSide('command'));
  router.use(requireRole('operator', 'admin'));
  router.use(
    rateLimiter({
      enabled: config.rateLimit.enabled,
      windowMs: config.rateLimit.windowMs,
      maxRequests: config.rateLimit.maxRequests,
      logger,
    })
  );

  /** POST /api/shipment/create -> CONTAINER_CREATED */
  router.post('/shipment/create', asyncHandler(controller.create));

  /** POST /api/shipment/move -> LOADED_ON_SHIP | ARRIVED_AT_PORT | UNLOADED_FROM_SHIP */
  router.post('/shipment/move', asyncHandler(controller.move));

  /** POST /api/shipment/temperature -> TEMPERATURE_RECORDED | TEMPERATURE_SPIKE */
  router.post('/shipment/temperature', asyncHandler(controller.recordTemperature));

  /**
   * Lifecycle management, added so the dashboard can own the whole shipment
   * lifecycle without the seed script.
   *
   * Note what these are *not*: there is no PUT and no DELETE anywhere on this
   * router. Editing and removing a shipment are commands that append events,
   * exactly like moving one, so they are POSTs to named command endpoints and
   * they read as verbs rather than as mutations of a resource.
   */

  /** POST /api/shipment/amend -> SHIPMENT_DETAILS_AMENDED */
  router.post('/shipment/amend', asyncHandler(controller.amend));

  /** POST /api/shipment/archive -> SHIPMENT_ARCHIVED */
  router.post('/shipment/archive', asyncHandler(controller.archive));

  /** POST /api/shipment/restore -> SHIPMENT_RESTORED */
  router.post('/shipment/restore', asyncHandler(controller.restore));

  /**
   * Scheduling.
   *
   * These are the endpoints the lifecycle planner talks to, and they are worth
   * looking at for what they do *not* offer: there is no way to submit an event
   * type and a payload. A client can ask to plan, revise or extend a schedule -
   * business intentions - and the backend decides which event, if any, that
   * legitimately produces. "Append an arbitrary event" is not in the API
   * surface, which is what stops the richer UI from becoming a thin wrapper
   * over the Event Store.
   */

  /** POST /api/shipment/schedule/plan -> SHIPMENT_SCHEDULE_PLANNED */
  router.post('/shipment/schedule/plan', asyncHandler(controller.planSchedule));

  /** POST /api/shipment/schedule/revise -> SHIPMENT_SCHEDULE_REVISED */
  router.post('/shipment/schedule/revise', asyncHandler(controller.reviseSchedule));

  /** POST /api/shipment/schedule/extend -> SHIPMENT_SCHEDULE_EXTENDED */
  router.post('/shipment/schedule/extend', asyncHandler(controller.extendSchedule));

  return router;
}
