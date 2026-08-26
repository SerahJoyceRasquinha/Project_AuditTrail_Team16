import { applyEvent, initialShipmentState } from '../../domain/shipment/reducers/shipmentReducer.js';
import { summariseSchedule } from '../../domain/shipment/schedule/schedulePolicy.js';

/**
 * The projection handler (roadmap 12.2).
 *
 * It reuses the *same* reducer the command side and the historical query use.
 * If the projection had its own private copy of the state transitions, the read
 * model could drift from the truth while every individual test still passed;
 * sharing the reducer makes that class of bug structurally impossible.
 *
 * The projection is deliberately narrower than the full aggregate state: it
 * carries what the dashboard queries need, not a blind copy of every event
 * (roadmap 12.2, "Do not duplicate every event blindly").
 */
/**
 * Bumped from 1 when the schedule fields were added. The rebuild tooling
 * compares this against what is stored, so an old projection is recognised as
 * stale rather than silently serving a shape the dashboard no longer expects.
 * Nothing is lost by rebuilding: the read model is derived, and the events it
 * derives from are untouched.
 */
export const PROJECTION_VERSION = 2;

export function projectState(state, { lastSequence, workerName }) {
  return {
    aggregateId: state.aggregateId,
    containerCode: state.containerCode,
    currentState: state.currentState,
    currentVersion: state.version,
    currentLocation: state.currentLocation,
    origin: state.origin,
    destination: state.destination,
    originLocation: state.originLocation,
    destinationLocation: state.destinationLocation,
    carrier: state.carrier,
    cargoDescription: state.cargoDescription,
    vesselName: state.vesselName,
    voyageNumber: state.voyageNumber,
    minTemperatureC: state.minTemperatureC,
    maxTemperatureC: state.maxTemperatureC,
    latestTemperatureC: state.latestTemperatureC,
    latestTemperatureAt: state.latestTemperatureAt,
    temperatureReadingCount: state.temperatureReadingCount,
    temperatureBreachCount: state.temperatureBreachCount,
    temperatureExcursion: state.temperatureExcursion,
    createdAt: state.createdAt,
    loadedAt: state.loadedAt,
    arrivedAt: state.arrivedAt,
    unloadedAt: state.unloadedAt,

    /**
     * The schedule, flattened for querying.
     *
     * `summariseSchedule` is the same pure function the API and the PDF call,
     * so a stage is "overdue" in the read model under exactly the conditions it
     * is overdue everywhere else.
     *
     * One caveat worth being explicit about: overdue-ness depends on the
     * current instant, and a projection is written once. So the stored
     * `isOverdue` here is a *snapshot as at projection time* - useful for
     * sorting and filtering a list - while the shipment detail query recomputes
     * it against the real clock before answering. The query, not the
     * projection, is authoritative for that field.
     */
    estimatedDurationDays: state.estimatedDurationDays,
    originalEstimatedDurationDays: state.originalEstimatedDurationDays,
    schedulePlanned: state.schedulePlanned,
    scheduleRevisionCount: state.scheduleRevisionCount,
    scheduleExtensionCount: state.scheduleExtensionCount,
    totalExtensionDays: state.totalExtensionDays,
    lastScheduleChangeAt: state.lastScheduleChangeAt,
    schedule: buildScheduleProjection(state),
    // Archival is derived state like everything else here: the worker computes
    // it by folding SHIPMENT_ARCHIVED / SHIPMENT_RESTORED, and the list query
    // filters on it. Nothing outside the reducer ever sets it.
    archived: state.archived,
    archivedAt: state.archivedAt,
    restoredAt: state.restoredAt,
    amendmentCount: state.amendmentCount,
    lastAmendedAt: state.lastAmendedAt,
    lastEventAt: state.lastEventAt,
    lastEventType: state.lastEventType,
    projectionMetadata: {
      projectionVersion: PROJECTION_VERSION,
      lastProcessedVersion: state.version,
      lastProcessedSequence: lastSequence,
      projectedBy: workerName,
      projectedAt: new Date().toISOString(),
    },
  };
}

/**
 * Rebuilds the state a projection represents, so an incremental update can be
 * applied on top of it without re-reading the whole event stream.
 *
 * The fields restored here are exactly the ones the reducer needs as carry-over
 * context. Anything the reducer recomputes from the incoming event alone does
 * not need restoring.
 */
/**
 * The schedule slice of the projection, including a `nextPlannedDate` the
 * dashboard can sort and index on without unpacking the stage array.
 */
function buildScheduleProjection(state) {
  if (!state.schedulePlanned) {
    return {
      planned: false,
      stages: [],
      nextStage: null,
      nextPlannedDate: null,
      isOverdue: false,
    };
  }

  const summary = summariseSchedule({
    schedule: state.schedule,
    originalSchedule: state.originalSchedule,
    confirmedStages: state.confirmedStages ?? {},
    createdAt: state.createdAt,
    estimatedDurationDays: state.estimatedDurationDays,
    originalEstimatedDurationDays: state.originalEstimatedDurationDays,
    now: new Date(),
  });

  const pending = summary.stages.find((entry) => entry.stage === summary.nextStage) ?? null;

  return {
    planned: true,
    stages: summary.stages,
    plan: state.schedule,
    originalPlan: state.originalSchedule,
    nextStage: summary.nextStage,
    nextPlannedDate: pending?.plannedDate ?? null,
    plannedCompletionDate: summary.plannedCompletionDate,
    originalPlannedCompletionDate: summary.originalPlannedCompletionDate,
    isComplete: summary.isComplete,
    actualCompletionAt: summary.actualCompletionAt,
    actualDurationDays: summary.actualDurationDays,
    isOverdue: summary.isOverdue,
    overdueStages: summary.overdueStages,
    maxOverdueDays: summary.maxOverdueDays,
    /**
     * Deliberately carries no timestamp of its own. The reconciliation job
     * deep-compares a stored projection against a fresh replay to detect drift,
     * and a wall-clock field inside the compared object would differ on every
     * run - reporting drift that does not exist. Projection timing lives in
     * `projectionMetadata`, which reconciliation already excludes.
     */
  };
}

export function stateFromProjection(projection) {
  if (!projection) return initialShipmentState;
  return Object.freeze({
    ...initialShipmentState,
    aggregateId: projection.aggregateId,
    exists: true,
    version: projection.currentVersion,
    currentState: projection.currentState,
    currentLocation: projection.currentLocation,
    origin: projection.origin ?? null,
    destination: projection.destination ?? null,
    containerCode: projection.containerCode ?? null,
    cargoDescription: projection.cargoDescription ?? null,
    carrier: projection.carrier ?? null,
    vesselName: projection.vesselName ?? null,
    voyageNumber: projection.voyageNumber ?? null,
    minTemperatureC: projection.minTemperatureC ?? null,
    maxTemperatureC: projection.maxTemperatureC ?? null,
    latestTemperatureC: projection.latestTemperatureC ?? null,
    latestTemperatureAt: projection.latestTemperatureAt ?? null,
    temperatureReadingCount: projection.temperatureReadingCount ?? 0,
    temperatureBreachCount: projection.temperatureBreachCount ?? 0,
    temperatureExcursion: projection.temperatureExcursion ?? false,
    createdAt: projection.createdAt ?? null,
    loadedAt: projection.loadedAt ?? null,
    arrivedAt: projection.arrivedAt ?? null,
    unloadedAt: projection.unloadedAt ?? null,
    archived: projection.archived ?? false,
    archivedAt: projection.archivedAt ?? null,
    restoredAt: projection.restoredAt ?? null,
    amendmentCount: projection.amendmentCount ?? 0,
    lastAmendedAt: projection.lastAmendedAt ?? null,
    lastEventAt: projection.lastEventAt ?? null,
    lastEventType: projection.lastEventType ?? null,
    originLocation: projection.originLocation ?? null,
    destinationLocation: projection.destinationLocation ?? null,
    estimatedDurationDays: projection.estimatedDurationDays ?? null,
    originalEstimatedDurationDays: projection.originalEstimatedDurationDays ?? null,
    schedule: projection.schedule?.plan ?? null,
    originalSchedule: projection.schedule?.originalPlan ?? null,
    confirmedStages: rebuildConfirmedStages(projection),
    schedulePlanned: projection.schedulePlanned ?? false,
    scheduleRevisionCount: projection.scheduleRevisionCount ?? 0,
    scheduleExtensionCount: projection.scheduleExtensionCount ?? 0,
    totalExtensionDays: projection.totalExtensionDays ?? 0,
    lastScheduleChangeAt: projection.lastScheduleChangeAt ?? null,
  });
}

/**
 * Restores `confirmedStages` when resuming from a stored projection.
 *
 * Derived from the confirmed entries the projection already carries rather than
 * stored twice, so the incremental path and a full replay agree.
 */
function rebuildConfirmedStages(projection) {
  const confirmed = {};
  for (const entry of projection.schedule?.stages ?? []) {
    if (entry.status !== 'CONFIRMED') continue;
    confirmed[entry.stage] = {
      confirmedAt: entry.confirmedAt,
      plannedDate: entry.plannedDate,
      varianceDays: entry.varianceDays ?? null,
    };
  }
  return confirmed;
}

export function applyEventToState(state, event) {
  return applyEvent(state, event, { strict: true });
}
