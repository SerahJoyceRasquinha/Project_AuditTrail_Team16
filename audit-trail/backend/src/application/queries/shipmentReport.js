import { EVENT_TYPES } from '../../domain/shipment/events/eventTypes.js';
import { replay } from '../../domain/shipment/reducers/shipmentReducer.js';
import {
  LIFECYCLE_STAGES,
  STAGE_LABELS,
  daysBetween,
  summariseSchedule,
  toPlanDate,
} from '../../domain/shipment/schedule/schedulePolicy.js';

/**
 * Builds the report model behind the shipment PDF and CSV.
 *
 * Why this is a separate module
 * -----------------------------
 * The old export walked the reconstructed state at every version and printed a
 * diff of raw field names - `temperatureBreachCount: 0 → 1`, `currentState:
 * "IN_TRANSIT" → "AT_PORT"`. That is a database dump with a title on it. It is
 * readable only by someone who already knows the schema, which is precisely the
 * person who does not need the report.
 *
 * The translation from internal vocabulary to business vocabulary happens here,
 * once, so the PDF and the CSV cannot describe the same shipment differently.
 *
 * What is deliberately preserved
 * ------------------------------
 * Making the report readable must not make it *weaker as evidence*. So every
 * translated line still carries its version number and event type, the hash
 * chain verdict is stated plainly, and - most importantly - the report
 * distinguishes four things the old dump ran together:
 *
 *   - **Confirmed facts**: a stage happened, at this instant.
 *   - **Planned intentions**: a stage is expected, on this date. Not a fact.
 *   - **Reconstructed state**: derived by replaying events, not stored.
 *   - **Historical record**: the events themselves.
 *
 * The section headers say which is which, because a report that lets a reader
 * mistake a plan for an outcome is worse than no report.
 */

/** Internal event types -> the words a logistics manager actually uses. */
export const EVENT_BUSINESS_LABELS = Object.freeze({
  CONTAINER_CREATED: 'Shipment opened',
  LOADED_ON_SHIP: 'Loaded on ship',
  ARRIVED_AT_PORT: 'Arrived at port',
  UNLOADED_FROM_SHIP: 'Unloaded from ship',
  TEMPERATURE_RECORDED: 'Temperature reading',
  TEMPERATURE_SPIKE: 'Temperature alert',
  SHIPMENT_DETAILS_AMENDED: 'Details corrected',
  SHIPMENT_ARCHIVED: 'Withdrawn from active fleet',
  SHIPMENT_RESTORED: 'Returned to active fleet',
  SHIPMENT_SCHEDULE_PLANNED: 'Schedule agreed',
  SHIPMENT_SCHEDULE_REVISED: 'Schedule revised',
  SHIPMENT_SCHEDULE_EXTENDED: 'Delay recorded, schedule extended',
});

export const STATE_BUSINESS_LABELS = Object.freeze({
  CREATED: 'Awaiting loading',
  IN_TRANSIT: 'In transit',
  AT_PORT: 'At destination port',
  UNLOADED: 'Delivered and unloaded',
});

const STATUS_LABELS = Object.freeze({
  CONFIRMED: 'Confirmed',
  IN_PROGRESS: 'In progress',
  PLANNED: 'Planned',
  OVERDUE: 'Overdue',
  UNPLANNED: 'Not yet planned',
});

const SOURCE_LABELS = Object.freeze({
  SIMULATED: 'Simulated (not measured)',
  EXTERNAL: 'Sensor feed',
  MANUAL: 'Entered by operator',
});

/** A readable UTC timestamp. The zone is always shown - never left to be guessed. */
export function formatInstant(iso, { withTime = true } = {}) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const day = date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  if (!withTime) return `${day} (UTC)`;

  const time = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${day}, ${time} UTC`;
}

/** A planned calendar date. No time component, because a plan has none. */
export function formatPlanDate(value) {
  if (!value) return '—';
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const formatTemp = (value) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? '—'
    : `${Number(value).toFixed(1)} °C`;

function describeLocation(location, fallback) {
  if (!location) {
    return fallback ? { display: fallback, verified: false } : { display: '—', verified: false };
  }
  return {
    display: location.display ?? fallback ?? '—',
    city: location.city ?? null,
    state: location.stateName ?? null,
    country: location.countryName ?? null,
    code: [location.countryCode, location.stateCode].filter(Boolean).join('-') || null,
    verified: true,
  };
}

/**
 * Assembles the whole report.
 *
 * `now` is injected rather than read from the clock so the report is
 * deterministic under test, and so a report generated for a historical instant
 * would compute overdue-ness against that instant rather than against today.
 */
export function buildShipmentReport({ events, integrity, now = new Date() }) {
  const state = replay(events);

  const schedule = state.schedulePlanned
    ? summariseSchedule({
        schedule: state.schedule,
        originalSchedule: state.originalSchedule,
        confirmedStages: state.confirmedStages ?? {},
        createdAt: state.createdAt,
        estimatedDurationDays: state.estimatedDurationDays,
        originalEstimatedDurationDays: state.originalEstimatedDurationDays,
        now,
      })
    : null;

  const temperatureEvents = events.filter(
    (event) =>
      event.eventType === EVENT_TYPES.TEMPERATURE_RECORDED ||
      event.eventType === EVENT_TYPES.TEMPERATURE_SPIKE
  );

  const readings = temperatureEvents.map((event) => ({
    version: event.version,
    at: event.payload.recordedAt ?? event.timestamp,
    temperatureC: event.payload.temperatureC ?? null,
    isAlert: event.eventType === EVENT_TYPES.TEMPERATURE_SPIKE,
    direction: event.payload.direction ?? null,
    thresholdC: event.payload.thresholdC ?? null,
    sensorId: event.payload.sensorId ?? null,
    source: event.payload.source ?? 'MANUAL',
    sourceLabel: SOURCE_LABELS[event.payload.source ?? 'MANUAL'] ?? 'Unknown origin',
  }));

  const alerts = readings.filter((reading) => reading.isAlert);
  const values = readings.map((r) => r.temperatureC).filter((v) => Number.isFinite(v));

  const scheduleChanges = events
    .filter((event) =>
      [
        EVENT_TYPES.SHIPMENT_SCHEDULE_PLANNED,
        EVENT_TYPES.SHIPMENT_SCHEDULE_REVISED,
        EVENT_TYPES.SHIPMENT_SCHEDULE_EXTENDED,
      ].includes(event.eventType)
    )
    .map((event) => ({
      version: event.version,
      at: event.timestamp,
      kind: event.eventType,
      label: EVENT_BUSINESS_LABELS[event.eventType],
      extensionDays: event.payload.extensionDays ?? null,
      stage: event.payload.stage ? STAGE_LABELS[event.payload.stage] : null,
      reason: event.payload.reason ?? null,
      changes: describeScheduleChange(event),
    }));

  return {
    identification: {
      shipmentId: state.aggregateId,
      containerCode: state.containerCode,
      cargo: state.cargoDescription,
      carrier: state.carrier,
      vessel: state.vesselName,
      voyage: state.voyageNumber,
    },
    origin: describeLocation(state.originLocation, state.origin),
    destination: describeLocation(state.destinationLocation, state.destination),
    creation: {
      openedAt: state.createdAt,
      // The instant the *ledger* wrote it, as distinct from the instant the
      // event claims to have occurred. They are equal for anything created
      // through the dashboard; showing both makes a backfilled record
      // self-evidently backfilled rather than indistinguishable from a live one.
      recordedAt: events[0]?.recordedAt ?? null,
      backfilled:
        Boolean(events[0]?.recordedAt) &&
        Math.abs(Date.parse(events[0].recordedAt) - Date.parse(state.createdAt)) > 60_000,
    },
    currentStatus: {
      state: state.currentState,
      label: STATE_BUSINESS_LABELS[state.currentState] ?? state.currentState,
      location: state.currentLocation,
      archived: state.archived,
      archivedAt: state.archivedAt,
      version: state.version,
      lastActivityAt: state.lastEventAt,
    },
    duration: {
      originalEstimateDays: state.originalEstimatedDurationDays,
      currentEstimateDays: state.estimatedDurationDays,
      wasExtended: state.scheduleExtensionCount > 0,
      totalExtensionDays: state.totalExtensionDays,
      extensionCount: state.scheduleExtensionCount,
      revisionCount: state.scheduleRevisionCount,
      originalCompletion: schedule?.originalPlannedCompletionDate ?? null,
      currentCompletion: schedule?.plannedCompletionDate ?? null,
      actualCompletionAt: schedule?.actualCompletionAt ?? null,
      actualDurationDays: schedule?.actualDurationDays ?? null,
      finishedEarlyByDays:
        schedule?.actualDurationDays !== null &&
        schedule?.actualDurationDays !== undefined &&
        Number.isInteger(state.originalEstimatedDurationDays)
          ? state.originalEstimatedDurationDays - schedule.actualDurationDays
          : null,
    },
    lifecycle: (schedule?.stages ?? LIFECYCLE_STAGES.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      status: 'UNPLANNED',
      plannedDate: null,
      originalPlannedDate: null,
      confirmedAt: null,
      details: null,
      overdueByDays: 0,
      earlyByDays: 0,
      lateByDays: 0,
    }))).map((entry) => ({
      ...entry,
      statusLabel: STATUS_LABELS[entry.status] ?? entry.status,
      wasRescheduled:
        Boolean(entry.originalPlannedDate) &&
        Boolean(entry.plannedDate) &&
        entry.originalPlannedDate !== entry.plannedDate,
    })),
    schedulePlanned: Boolean(state.schedulePlanned),
    isOverdue: schedule?.isOverdue ?? false,
    scheduleChanges,
    temperature: {
      declaredMinC: state.minTemperatureC,
      declaredMaxC: state.maxTemperatureC,
      hasRange: state.minTemperatureC !== null && state.maxTemperatureC !== null,
      readingCount: readings.length,
      alertCount: alerts.length,
      lowestC: values.length > 0 ? Math.min(...values) : null,
      highestC: values.length > 0 ? Math.max(...values) : null,
      averageC:
        values.length > 0
          ? Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(2))
          : null,
      firstReadingAt: readings[0]?.at ?? null,
      lastReadingAt: readings[readings.length - 1]?.at ?? null,
      readings,
      alerts,
      // If every reading came from the simulator, the report says so at the top
      // of the section rather than only in a per-row column that a skimming
      // reader would miss.
      sources: [...new Set(readings.map((r) => r.sourceLabel))],
    },
    history: events.map((event) => ({
      version: event.version,
      at: event.timestamp,
      recordedAt: event.recordedAt ?? null,
      eventType: event.eventType,
      label: EVENT_BUSINESS_LABELS[event.eventType] ?? event.eventType,
      summary: summariseEvent(event),
      isAlert: event.eventType === EVENT_TYPES.TEMPERATURE_SPIKE,
      hash: event.hash ?? null,
    })),
    integrity: {
      intact: integrity?.intact ?? null,
      eventCount: integrity?.eventCount ?? events.length,
      issues: integrity?.issues ?? [],
      headHash: integrity?.headHash ?? null,
      verifiedAt: integrity?.verifiedAt ?? null,
    },
    generatedAt: new Date(now).toISOString(),
  };
}

/** One plain-English line describing what an event actually did. */
function summariseEvent(event) {
  const p = event.payload ?? {};

  switch (event.eventType) {
    case EVENT_TYPES.CONTAINER_CREATED:
      return `Container ${p.containerCode ?? '—'} opened for carriage from ${p.origin ?? '—'} to ${p.destination ?? '—'}${
        Number.isInteger(p.estimatedDurationDays)
          ? `, estimated at ${p.estimatedDurationDays} day${p.estimatedDurationDays === 1 ? '' : 's'}`
          : ''
      }.`;

    case EVENT_TYPES.LOADED_ON_SHIP:
      return `Loaded onto ${p.vesselName ?? 'a vessel'}${p.voyageNumber ? ` (voyage ${p.voyageNumber})` : ''} at ${p.location ?? '—'}${describeVariance(p)}`;

    case EVENT_TYPES.ARRIVED_AT_PORT:
      return `Arrived at ${p.portName ?? p.location ?? '—'}${p.berth ? `, berth ${p.berth}` : ''}${describeVariance(p)}`;

    case EVENT_TYPES.UNLOADED_FROM_SHIP:
      return `Discharged at ${p.location ?? '—'}${p.yardBlock ? `, yard block ${p.yardBlock}` : ''}${describeVariance(p)}`;

    case EVENT_TYPES.TEMPERATURE_RECORDED:
      return `${formatTemp(p.temperatureC)} recorded, within the agreed range. Source: ${
        SOURCE_LABELS[p.source ?? 'MANUAL'] ?? 'unknown'
      }.`;

    case EVENT_TYPES.TEMPERATURE_SPIKE:
      return `ALERT — ${formatTemp(p.temperatureC)} breached the agreed ${
        p.direction === 'BELOW_MIN' ? 'minimum' : 'maximum'
      } of ${formatTemp(p.thresholdC)}. Source: ${SOURCE_LABELS[p.source ?? 'MANUAL'] ?? 'unknown'}.`;

    case EVENT_TYPES.SHIPMENT_DETAILS_AMENDED: {
      const fields = Object.keys(p).filter((key) => key !== 'reason');
      return `Corrected: ${fields.join(', ') || 'no fields'}.${p.reason ? ` Reason: ${p.reason}` : ''}`;
    }

    case EVENT_TYPES.SHIPMENT_ARCHIVED:
      return `Withdrawn from the active fleet.${p.reason ? ` Reason: ${p.reason}` : ''} No history was removed.`;

    case EVENT_TYPES.SHIPMENT_RESTORED:
      return `Returned to the active fleet.${p.reason ? ` Reason: ${p.reason}` : ''}`;

    case EVENT_TYPES.SHIPMENT_SCHEDULE_PLANNED:
      return `Schedule agreed: ${LIFECYCLE_STAGES.map(
        (stage) => `${STAGE_LABELS[stage]} ${formatPlanDate(p.schedule?.[stage]?.plannedDate)}`
      ).join('; ')}.`;

    case EVENT_TYPES.SHIPMENT_SCHEDULE_REVISED:
      return `Schedule revised for ${(p.changedStages ?? []).map((s) => STAGE_LABELS[s]).join(', ') || 'the voyage'}.${
        p.reason ? ` Reason: ${p.reason}.` : ''
      }`;

    case EVENT_TYPES.SHIPMENT_SCHEDULE_EXTENDED:
      return `${STAGE_LABELS[p.stage] ?? 'A stage'} extended by ${p.extensionDays} day${
        p.extensionDays === 1 ? '' : 's'
      }; estimated duration now ${p.estimatedDurationDays} days (was ${p.previousEstimatedDurationDays ?? '—'}).${
        p.reason ? ` Reason: ${p.reason}.` : ''
      }`;

    default:
      return '';
  }
}

function describeVariance(payload) {
  if (!payload.plannedDate) return '.';
  const variance = payload.varianceDays;
  if (!Number.isInteger(variance) || variance === 0) {
    return `. On the planned date of ${formatPlanDate(payload.plannedDate)}.`;
  }
  return variance > 0
    ? `. ${variance} day${variance === 1 ? '' : 's'} later than the planned ${formatPlanDate(payload.plannedDate)}.`
    : `. ${Math.abs(variance)} day${variance === -1 ? '' : 's'} earlier than the planned ${formatPlanDate(payload.plannedDate)}.`;
}

/** Stage-by-stage before/after for a schedule change event. */
function describeScheduleChange(event) {
  const p = event.payload ?? {};
  if (!p.previousSchedule) return [];

  return LIFECYCLE_STAGES.map((stage) => {
    const before = p.previousSchedule?.[stage]?.plannedDate ?? null;
    const after = p.schedule?.[stage]?.plannedDate ?? null;
    if (before === after) return null;
    return {
      stage: STAGE_LABELS[stage],
      from: before,
      to: after,
      shiftedByDays: before && after ? daysBetween(before, `${after}T00:00:00.000Z`) : null,
    };
  }).filter(Boolean);
}
