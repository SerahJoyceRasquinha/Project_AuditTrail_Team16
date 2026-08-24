import { applyEvent, initialShipmentState } from '../../domain/shipment/reducers/shipmentReducer.js';

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
export const PROJECTION_VERSION = 1;

export function projectState(state, { lastSequence, workerName }) {
  return {
    aggregateId: state.aggregateId,
    containerCode: state.containerCode,
    currentState: state.currentState,
    currentVersion: state.version,
    currentLocation: state.currentLocation,
    origin: state.origin,
    destination: state.destination,
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
  });
}

export function applyEventToState(state, event) {
  return applyEvent(state, event, { strict: true });
}
