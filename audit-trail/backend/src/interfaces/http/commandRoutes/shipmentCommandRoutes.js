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

  return router;
}
