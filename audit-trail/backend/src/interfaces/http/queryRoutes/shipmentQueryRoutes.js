import { Router } from 'express';
import { asyncHandler, tagCqrsSide } from '../middleware/index.js';

/**
 * The **Query** router (roadmap 8.2 - 8.5).
 *
 * `GET /shipment/:id` is the endpoint named by the source. The rest are
 * documented design decisions serving the timeline, the scrubber, the chart and
 * the integrity demonstration.
 *
 * Route order matters: `/shipment/:id` is registered last so that it cannot
 * swallow `/shipment/:id/events` and friends.
 */
export function createShipmentQueryRoutes({ controller }) {
  const router = Router();

  router.use(tagCqrsSide('query'));

  /** GET /api/meta/dashboard-metrics - KPI dashboard data */
  router.get('/meta/dashboard-metrics', asyncHandler(controller.getDashboardMetrics));

  /**
   * The dashboard as a document. Registered before nothing in particular, but
   * note it sits on the query router: an export reads, it never writes, so it
   * needs a session like any other query and no role beyond that.
   */
  router.get('/meta/dashboard-metrics/export', asyncHandler(controller.exportDashboardMetrics));

  /** GET /api/shipments - dashboard list (design decision) */
  router.get('/shipments', asyncHandler(controller.listShipments));

  /** GET /api/shipment/:id/events - raw chronological stream for the timeline */
  router.get('/shipment/:id/events', asyncHandler(controller.getEvents));

  /** GET /api/shipment/:id/state?at=<iso> - historical reconstruction (scrubber) */
  router.get('/shipment/:id/state', asyncHandler(controller.getHistoricalState));

  /** GET /api/shipment/:id/sensors - temperature series for Recharts */
  router.get('/shipment/:id/sensors', asyncHandler(controller.getSensors));

  /** GET /api/shipment/:id/integrity - hash-chain verification */
  router.get('/shipment/:id/integrity', asyncHandler(controller.verifyIntegrity));

  /** GET /api/shipment/:id/reconciliation - projection vs replay comparison */
  router.get('/shipment/:id/reconciliation', asyncHandler(controller.reconcile));

  /** GET /api/shipment/:id/schedule - plan, derived stage statuses and calendar bounds */
  router.get('/shipment/:id/schedule', asyncHandler(controller.getSchedule));

  /** GET /api/shipment/:id - current state from the read model (source endpoint) */
  router.get('/shipment/:id', asyncHandler(controller.getShipment));

  /** GET /api/shipment/:id/export?format=... - output history */
  router.get('/shipment/:id/export', asyncHandler(controller.exportHistory));

  return router;
}
