import { Router } from 'express';
import { asyncHandler, rateLimiter, tagCqrsSide } from '../middleware/index.js';
import { requireRole } from '../middleware/auth.js';
import { COMMAND_ROLES } from '../../../domain/auth/roles.js';

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
  /**
   * Authorization.
   *
   * `operatorOnly` is attached to each command route individually rather than
   * with `router.use`, and the distinction is not cosmetic. Both routers are
   * mounted on the same `/api` path, so *every* request - including every
   * query - passes through this router first and only falls through to the
   * query router when no path here matches. A router-level guard would
   * therefore reject a read-only account's perfectly legitimate GET before it
   * ever reached the query side.
   *
   * Attached per route, the guard still runs before the controller, the
   * handler, the aggregate and the Event Store, so a caller without the
   * Operator role is refused before anything can append an event - which is
   * the property that actually matters. A read-only account posting directly
   * to any of these endpoints with curl or Postman is stopped here; hiding the
   * button in React is a courtesy to the user, not the control.
   */
  const operatorOnly = requireRole(...COMMAND_ROLES);

  /**
   * Rate limiting, attached per route for exactly the reason described above.
   *
   * This budget is meant for the command surface: appending events is the
   * expensive, irreversible thing worth throttling. But `router.use` here would
   * spend it on the query side as well, because - as noted above - every
   * request entering `/api` passes through this router's middleware before
   * falling through to the query router. Mounted at router level, a dashboard
   * doing nothing but reading would exhaust the command budget and start
   * receiving 429s on its own timeline, chart and metrics; a read-only account,
   * which cannot issue a single command, would be throttled by a limit on
   * commands. Neither is what the limit is for.
   *
   * One limiter instance is created and attached to each command route, so the
   * budget stays shared across all commands - it is a limit on commanding, not
   * a separate allowance per endpoint - while queries are never counted
   * against it at all.
   */
  const limitCommands = rateLimiter({
    enabled: config.rateLimit.enabled,
    windowMs: config.rateLimit.windowMs,
    maxRequests: config.rateLimit.maxRequests,
    logger,
  });

  /** POST /api/shipment/create -> CONTAINER_CREATED */
  router.post('/shipment/create', limitCommands, operatorOnly, asyncHandler(controller.create));

  /** POST /api/shipment/move -> LOADED_ON_SHIP | ARRIVED_AT_PORT | UNLOADED_FROM_SHIP */
  router.post('/shipment/move', limitCommands, operatorOnly, asyncHandler(controller.move));

  /** POST /api/shipment/temperature -> TEMPERATURE_RECORDED | TEMPERATURE_SPIKE */
  router.post('/shipment/temperature', limitCommands, operatorOnly, asyncHandler(controller.recordTemperature));

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
  router.post('/shipment/amend', limitCommands, operatorOnly, asyncHandler(controller.amend));

  /** POST /api/shipment/archive -> SHIPMENT_ARCHIVED */
  router.post('/shipment/archive', limitCommands, operatorOnly, asyncHandler(controller.archive));

  /** POST /api/shipment/restore -> SHIPMENT_RESTORED */
  router.post('/shipment/restore', limitCommands, operatorOnly, asyncHandler(controller.restore));

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
  router.post('/shipment/schedule/plan', limitCommands, operatorOnly, asyncHandler(controller.planSchedule));

  /** POST /api/shipment/schedule/revise -> SHIPMENT_SCHEDULE_REVISED */
  router.post('/shipment/schedule/revise', limitCommands, operatorOnly, asyncHandler(controller.reviseSchedule));

  /** POST /api/shipment/schedule/extend -> SHIPMENT_SCHEDULE_EXTENDED */
  router.post('/shipment/schedule/extend', limitCommands, operatorOnly, asyncHandler(controller.extendSchedule));

  return router;
}
