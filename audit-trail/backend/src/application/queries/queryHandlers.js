import {
  validateHistoricalStateQuery,
  validateShipmentId,
} from '../../domain/shipment/validators/commandValidators.js';
import { AggregateNotFoundError } from '../../shared/errors/AppError.js';
import { projectState } from '../../infrastructure/projections/shipmentProjection.js';
import { replay } from '../../domain/shipment/reducers/shipmentReducer.js';
import {
  LIFECYCLE_STAGES,
  planningWindow,
  summariseSchedule,
} from '../../domain/shipment/schedule/schedulePolicy.js';
import {
  calculateShipmentRiskScore,
  getRiskLevel,
} from '../../domain/shipment/risk/riskScore.js';

/**
 * Recomputes the schedule against the current instant.
 *
 * The projection stores a schedule snapshot taken when the worker last ran, and
 * that snapshot is fine for sorting a list. It is *not* fine for answering "is
 * this stage overdue?" on a detail screen: overdue-ness is a function of the
 * clock, and a projection written yesterday would answer as though it were
 * still yesterday.
 *
 * So the read model supplies the plan and the query supplies the moment. Both
 * come from the same pure `summariseSchedule`, so the answer is consistent with
 * the PDF and the aggregate - it is only the value of "now" that differs.
 */
function withRiskAssessment(shipment, integrityIssue = false) {
  if (!shipment) return shipment;
  const riskScore = calculateShipmentRiskScore(shipment, { integrityIssue });
  return {
    ...shipment,
    riskScore,
    riskLevel: getRiskLevel(riskScore),
  };
}

function withLiveSchedule(shipment) {
  if (!shipment?.schedulePlanned || !shipment?.schedule?.plan) return shipment;

  const confirmedStages = {};
  for (const entry of shipment.schedule.stages ?? []) {
    if (entry.status === 'CONFIRMED') {
      confirmedStages[entry.stage] = {
        confirmedAt: entry.confirmedAt,
        plannedDate: entry.plannedDate,
        varianceDays: entry.varianceDays ?? null,
      };
    }
  }

  const summary = summariseSchedule({
    schedule: shipment.schedule.plan,
    originalSchedule: shipment.schedule.originalPlan,
    confirmedStages,
    createdAt: shipment.createdAt,
    estimatedDurationDays: shipment.estimatedDurationDays,
    originalEstimatedDurationDays: shipment.originalEstimatedDurationDays,
    now: new Date(),
  });

  return {
    ...shipment,
    schedule: {
      ...shipment.schedule,
      stages: summary.stages,
      nextStage: summary.nextStage,
      isOverdue: summary.isOverdue,
      overdueStages: summary.overdueStages,
      maxOverdueDays: summary.maxOverdueDays,
      isComplete: summary.isComplete,
      actualCompletionAt: summary.actualCompletionAt,
      actualDurationDays: summary.actualDurationDays,
      plannedCompletionDate: summary.plannedCompletionDate,
      originalPlannedCompletionDate: summary.originalPlannedCompletionDate,
      evaluatedAt: new Date().toISOString(),
    },
  };
}

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

    const [projection, storeVersion, integrity] = await Promise.all([
      this.#readModel.findById(shipmentId),
      this.#eventStore.getCurrentVersion(shipmentId),
      this.#eventStore.verifyChain(shipmentId),
    ]);

    if (storeVersion === 0) throw new AggregateNotFoundError(shipmentId);

    if (projection && projection.currentVersion === storeVersion) {
      return {
        shipment: withRiskAssessment(withLiveSchedule(projection), integrity?.intact === false),
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
      shipment: withRiskAssessment(withLiveSchedule(replayed), integrity?.intact === false),
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
    const result = await this.#readModel.list(filters);
    // The list is where an operator scans for trouble, so overdue-ness has to
    // be current here too - not as of whenever the worker last ran.
    return { ...result, items: result.items.map((shipment) => withRiskAssessment(withLiveSchedule(shipment))) };
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
    const result = await this.#reconciliationService.reconcileOne(shipmentId);

    /**
     * A shipment that does not exist is a 404 here, exactly as it is on every
     * other query endpoint - not a 200 saying "consistent".
     *
     * `reconcileOne` is right to call an empty stream with no projection
     * consistent: that is the honest answer for the `reconcileAll` sweep, which
     * asks "does the read model disagree with the events anywhere?" and must
     * not be tripped by an identifier nobody ever used. But that answer becomes
     * a lie the moment it is served to someone who typed an identifier and is
     * waiting to be told whether *their* shipment reconciles. Reported as a
     * green tick, it is worse than an error: it is a confident wrong answer
     * about the integrity of a record that was never created.
     *
     * So the distinction is drawn here, at the edge, where the caller's
     * question is known - and the service keeps the semantics the sweep needs.
     */
    if (result.eventCount === 0) throw new AggregateNotFoundError(shipmentId);

    return result;
  }
}

/**
 * GET /shipment/:id/schedule
 *
 * The planner's dedicated read endpoint. It answers three questions the
 * dashboard needs together and which would otherwise be assembled by the
 * browser from three separate calls:
 *
 *   - what is planned, and what was originally planned;
 *   - what each stage's status is *right now*;
 *   - which dates the calendar may offer for each stage.
 *
 * That last one matters most. The selectable range for a stage depends on the
 * shipment's creation date, its current estimated duration and the dates chosen
 * for the stages before it. Computing those bounds here - from the same policy
 * the aggregate validates with - means the calendar cannot offer a date the
 * backend would then refuse.
 */
export class GetShipmentScheduleQueryHandler {
  #eventStore;

  constructor({ eventStore }) {
    this.#eventStore = eventStore;
  }

  async handle({ shipmentId }) {
    validateShipmentId(shipmentId);
    const events = await this.#eventStore.getEvents(shipmentId);
    if (events.length === 0) throw new AggregateNotFoundError(shipmentId);

    const state = replay(events);
    const window = planningWindow({
      createdAt: state.createdAt,
      estimatedDurationDays: state.estimatedDurationDays,
    });

    const summary = state.schedulePlanned
      ? summariseSchedule({
          schedule: state.schedule,
          originalSchedule: state.originalSchedule,
          confirmedStages: state.confirmedStages ?? {},
          createdAt: state.createdAt,
          estimatedDurationDays: state.estimatedDurationDays,
          originalEstimatedDurationDays: state.originalEstimatedDurationDays,
          now: new Date(),
        })
      : null;

    return {
      aggregateId: shipmentId,
      currentVersion: state.version,
      planned: Boolean(state.schedulePlanned),
      createdAt: state.createdAt,
      estimatedDurationDays: state.estimatedDurationDays,
      originalEstimatedDurationDays: state.originalEstimatedDurationDays,
      window,
      plan: state.schedule,
      originalPlan: state.originalSchedule,
      stages: summary?.stages ?? [],
      nextStage: summary?.nextStage ?? LIFECYCLE_STAGES[0],
      isOverdue: summary?.isOverdue ?? false,
      overdueStages: summary?.overdueStages ?? [],
      isComplete: summary?.isComplete ?? false,
      plannedCompletionDate: summary?.plannedCompletionDate ?? null,
      originalPlannedCompletionDate: summary?.originalPlannedCompletionDate ?? null,
      /** Per-stage selectable bounds, so the calendar cannot offer an illegal date. */
      bounds: buildStageBounds(state, window, summary),
      scheduleRevisionCount: state.scheduleRevisionCount,
      scheduleExtensionCount: state.scheduleExtensionCount,
      totalExtensionDays: state.totalExtensionDays,
      evaluatedAt: new Date().toISOString(),
    };
  }
}

/**
 * The selectable date range for each stage.
 *
 * A stage may never be planned before the stage in front of it, nor before the
 * shipment existed, nor beyond the current planning window. Confirmed stages
 * get a null range: their date is a historical fact and is not selectable at
 * all.
 */
function buildStageBounds(state, window, summary) {
  if (!window) return {};

  const bounds = {};
  let floor = window.earliest;

  for (const stage of LIFECYCLE_STAGES) {
    const confirmed = state.confirmedStages?.[stage] ?? null;
    if (confirmed) {
      bounds[stage] = {
        selectable: false,
        reason: 'This stage has already been confirmed, so its date is now a historical fact.',
        min: null,
        max: null,
      };
      floor = confirmed.confirmedOn ?? state.schedule?.[stage]?.plannedDate ?? floor;
      continue;
    }

    bounds[stage] = { selectable: true, min: floor, max: window.latest, reason: null };
    const chosen = state.schedule?.[stage]?.plannedDate;
    if (chosen && chosen > floor) floor = chosen;
  }

  return bounds;
}

/** GET /api/meta/dashboard-metrics - KPI dashboard data */
export class DashboardMetricsQueryHandler {
  #readModel;

  constructor({ readModelRepository }) {
    this.#readModel = readModelRepository;
  }

  async handle() {
    // Fetch all shipments without pagination to aggregate metrics
    const result = await this.#readModel.list({ pageSize: 10000, view: 'active' });
    const allShipments = result.items;

    // Initialize metrics
    const metrics = {
      totalShipments: allShipments.length,
      activeShipments: allShipments.filter(s => !s.archived).length,
      byState: {
        CREATED: 0,
        IN_TRANSIT: 0,
        AT_PORT: 0,
      },
      withBreaches: 0,
      totalBreaches: 0,
      avgBreachesPerShipment: 0,
      shipmentsByOrigin: {},
      shipmentsByDestination: {},
      averageDeliveryTime: 0,
      onTimeDeliveryRate: 0,
      overallTemperatureCompliance: 0,
    };

    let completedShipments = 0;
    let onTimeShipments = 0;
    let totalDeliveryHours = 0;

    for (const shipment of allShipments) {
      // Count by state
      if (shipment.currentState && metrics.byState[shipment.currentState] !== undefined) {
        metrics.byState[shipment.currentState]++;
      }

      // Temperature breach metrics
      if (shipment.temperatureBreachCount > 0) {
        metrics.withBreaches++;
        metrics.totalBreaches += shipment.temperatureBreachCount;
      }

      // Origin/Destination breakdown
      if (shipment.origin) {
        metrics.shipmentsByOrigin[shipment.origin] = (metrics.shipmentsByOrigin[shipment.origin] || 0) + 1;
      }
      if (shipment.destination) {
        metrics.shipmentsByDestination[shipment.destination] = (metrics.shipmentsByDestination[shipment.destination] || 0) + 1;
      }

      // Delivery time metrics (for completed shipments)
      if (shipment.unloadedAt && shipment.createdAt) {
        completedShipments++;
        const createdTime = new Date(shipment.createdAt).getTime();
        const unloadedTime = new Date(shipment.unloadedAt).getTime();
        const deliveryHours = (unloadedTime - createdTime) / (1000 * 60 * 60);
        totalDeliveryHours += deliveryHours;

        // Check if on-time (within estimated duration)
        if (shipment.estimatedDurationDays) {
          const estimatedHours = shipment.estimatedDurationDays * 24;
          if (deliveryHours <= estimatedHours) {
            onTimeShipments++;
          }
        }
      }
    }

    // Calculate derived metrics
    if (completedShipments > 0) {
      metrics.averageDeliveryTime = Math.round(totalDeliveryHours / completedShipments / 24 * 100) / 100; // in days
      metrics.onTimeDeliveryRate = Math.round((onTimeShipments / completedShipments) * 100);
    }

    if (allShipments.length > 0) {
      metrics.avgBreachesPerShipment = Math.round((metrics.totalBreaches / allShipments.length) * 100) / 100;
      // Temperature compliance: (shipments without breaches / total) * 100
      metrics.overallTemperatureCompliance = Math.round(
        ((allShipments.length - metrics.withBreaches) / allShipments.length) * 100
      );
    }

    // Sort origin/destination by count (descending) and limit to top 5
    const sortedOrigins = Object.entries(metrics.shipmentsByOrigin)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .reduce((acc, [key, val]) => ({ ...acc, [key]: val }), {});

    const sortedDestinations = Object.entries(metrics.shipmentsByDestination)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .reduce((acc, [key, val]) => ({ ...acc, [key]: val }), {});

    return {
      ...metrics,
      shipmentsByOrigin: sortedOrigins,
      shipmentsByDestination: sortedDestinations,
      generatedAt: new Date().toISOString(),
    };
  }
}
