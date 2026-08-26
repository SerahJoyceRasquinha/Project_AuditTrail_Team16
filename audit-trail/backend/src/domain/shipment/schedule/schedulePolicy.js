/**
 * Shipment schedule policy.
 *
 * Pure functions only - no clock of its own, no I/O. Every function that needs
 * "now" takes it as an argument, because a business rule that reads the system
 * clock cannot be tested and cannot be replayed. That matters more than usual
 * here: whether a stage is *overdue* is a question about a moment in time, and
 * the state scrubber has to be able to ask it about a past moment.
 *
 * The central design decision
 * --------------------------
 * **Overdue is derived, never stored.** There is no `isOverdue` field anywhere
 * in the event store or the read model that some job flips. A stage is overdue
 * if its planned date has passed and its confirming event has not been
 * appended - a function of the event stream and the current instant, computed
 * on read. Storing it would create exactly the mutable status field the whole
 * project argues against, and would be wrong the moment the clock moved.
 *
 * What *is* stored, as events: the plan itself, every revision to it, and every
 * schedule extension. Those are facts about decisions people made, and an
 * auditor needs them.
 */

/** The three lifecycle stages, in the only order they may legally occur. */
export const LIFECYCLE_STAGES = Object.freeze(['LOAD_ON_SHIP', 'ARRIVE_AT_PORT', 'UNLOAD_FROM_SHIP']);

export const STAGE_LABELS = Object.freeze({
  LOAD_ON_SHIP: 'Load on Ship',
  ARRIVE_AT_PORT: 'Arrive at Port',
  UNLOAD_FROM_SHIP: 'Unload from Ship',
});

/** The state each stage's confirming event puts the shipment into. */
export const STAGE_CONFIRMING_EVENT = Object.freeze({
  LOAD_ON_SHIP: 'LOADED_ON_SHIP',
  ARRIVE_AT_PORT: 'ARRIVED_AT_PORT',
  UNLOAD_FROM_SHIP: 'UNLOADED_FROM_SHIP',
});

/** Why a schedule changed. Recorded on the event so an auditor sees intent. */
export const REVISION_REASONS = Object.freeze({
  REPLAN: 'REPLAN',
  DELAY_EXTENSION: 'DELAY_EXTENSION',
  EARLY_COMPLETION: 'EARLY_COMPLETION',
});

export const MS_PER_DAY = 86_400_000;

/**
 * Duration validation, shared by the create command, the extension command and
 * the frontend (which imports the same rules through the meta endpoint).
 *
 * Rejects zero, negatives, decimals, non-numerics and empty - the exact list
 * the requirement enumerates. `2.5` is rejected rather than rounded: silently
 * rounding a user's number is how a shipment ends up with a completion date
 * nobody chose.
 */
export function validateWholeDays(value, { field = 'estimatedDurationDays', max = 3650 } = {}) {
  if (value === undefined || value === null || value === '') {
    return { ok: false, issue: { field, code: 'REQUIRED', message: `'${field}' is required.` } };
  }
  if (typeof value === 'boolean') {
    return { ok: false, issue: { field, code: 'NOT_A_NUMBER', message: `'${field}' must be a whole number of days.` } };
  }
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric)) {
    return {
      ok: false,
      issue: { field, code: 'NOT_A_NUMBER', message: `'${field}' must be a whole number of days.` },
    };
  }
  if (!Number.isInteger(numeric)) {
    return {
      ok: false,
      issue: { field, code: 'NOT_WHOLE', message: `'${field}' must be a whole number of days - fractions of a day are not accepted.` },
    };
  }
  if (numeric < 1) {
    return {
      ok: false,
      issue: { field, code: 'NOT_POSITIVE', message: `'${field}' must be at least 1 day.` },
    };
  }
  if (numeric > max) {
    return {
      ok: false,
      issue: { field, code: 'TOO_LARGE', message: `'${field}' must be at most ${max} days.` },
    };
  }
  return { ok: true, value: numeric };
}

/** Start-of-day in UTC. All planning maths happens on UTC day boundaries. */
export function startOfUtcDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** `YYYY-MM-DD` - the wire format for every planned (as opposed to actual) date. */
export function toPlanDate(value) {
  const day = startOfUtcDay(value);
  return day ? day.toISOString().slice(0, 10) : null;
}

export function addDays(isoDateOrTimestamp, days) {
  const day = startOfUtcDay(isoDateOrTimestamp);
  if (!day) return null;
  return new Date(day.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function daysBetween(fromDate, toDate) {
  const a = startOfUtcDay(fromDate);
  const b = startOfUtcDay(toDate);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

export const isPlanDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));

/**
 * The window inside which every planned date must fall.
 *
 * Opens on the shipment's creation day (a stage cannot be planned before the
 * shipment existed) and closes on creation + estimated duration. Extensions
 * move the closing edge by appending an event - they never widen it silently.
 */
export function planningWindow({ createdAt, estimatedDurationDays }) {
  const earliest = toPlanDate(createdAt);
  if (!earliest || !Number.isInteger(estimatedDurationDays)) return null;
  return Object.freeze({
    earliest,
    latest: addDays(createdAt, estimatedDurationDays),
    estimatedDurationDays,
  });
}

/**
 * Validates a proposed set of planned dates against the window and against the
 * lifecycle ordering.
 *
 * Both rules are checked here, once, and this same function runs on the command
 * side. The calendar in the browser narrows its ranges using the identical
 * logic, but the browser is a convenience: bypassing it with a raw POST hits
 * this function anyway.
 */
export function validatePlannedDates(plan, { window: planWindow, confirmedStages = {} } = {}) {
  const issues = [];
  const dates = {};

  for (const stage of LIFECYCLE_STAGES) {
    const value = plan?.[stage]?.plannedDate ?? plan?.[stage] ?? null;
    if (value === null || value === undefined || value === '') {
      issues.push({
        field: `schedule.${stage}.plannedDate`,
        code: 'PLANNED_DATE_REQUIRED',
        message: `A tentative date is required for ${STAGE_LABELS[stage]}.`,
      });
      continue;
    }
    if (!isPlanDate(value)) {
      issues.push({
        field: `schedule.${stage}.plannedDate`,
        code: 'PLANNED_DATE_INVALID',
        message: `The tentative date for ${STAGE_LABELS[stage]} must be a calendar date (YYYY-MM-DD).`,
      });
      continue;
    }
    dates[stage] = value;
  }

  if (planWindow) {
    for (const [stage, value] of Object.entries(dates)) {
      if (value < planWindow.earliest) {
        issues.push({
          field: `schedule.${stage}.plannedDate`,
          code: 'BEFORE_SHIPMENT_CREATION',
          message: `${STAGE_LABELS[stage]} cannot be planned before the shipment was created (${planWindow.earliest}).`,
        });
      } else if (value > planWindow.latest) {
        issues.push({
          field: `schedule.${stage}.plannedDate`,
          code: 'OUTSIDE_PLANNING_WINDOW',
          message: `The planned date falls outside the allowed shipment window, which ends on ${planWindow.latest}. Record a schedule extension if the shipment genuinely needs longer.`,
        });
      }
    }
  }

  // Ordering. Compared as `YYYY-MM-DD` strings, which sort correctly by date -
  // no timezone can get between two dates written this way.
  const [load, arrive, unload] = LIFECYCLE_STAGES.map((stage) => dates[stage]);
  if (load && arrive && arrive < load) {
    issues.push({
      field: 'schedule.ARRIVE_AT_PORT.plannedDate',
      code: 'STAGE_ORDER_VIOLATION',
      message: 'The planned Arrive at Port date cannot be earlier than the planned Load on Ship date.',
    });
  }
  if (arrive && unload && unload < arrive) {
    issues.push({
      field: 'schedule.UNLOAD_FROM_SHIP.plannedDate',
      code: 'STAGE_ORDER_VIOLATION',
      message: 'The planned Unload from Ship date cannot be earlier than the planned Arrive at Port date.',
    });
  }

  // A stage that has already happened is a historical fact. Re-planning it
  // would be editing the past under a different name.
  for (const stage of LIFECYCLE_STAGES) {
    if (confirmedStages[stage] && dates[stage] && dates[stage] !== confirmedStages[stage].plannedDate) {
      issues.push({
        field: `schedule.${stage}.plannedDate`,
        code: 'STAGE_ALREADY_CONFIRMED',
        message: `${STAGE_LABELS[stage]} has already been confirmed, so its tentative date can no longer be changed.`,
      });
    }
  }

  return { ok: issues.length === 0, dates, issues };
}

/**
 * Which stage is next, given what has been confirmed.
 * Returns null once the lifecycle is complete.
 */
export function nextStage(confirmedStages = {}) {
  return LIFECYCLE_STAGES.find((stage) => !confirmedStages[stage]) ?? null;
}

/**
 * Derives each stage's status at a given instant.
 *
 * This is the function the dashboard, the read model and the PDF all call, so
 * "overdue" means exactly one thing across the whole system. Statuses:
 *
 *   CONFIRMED   - its event is in the stream. Terminal; never becomes overdue.
 *   IN_PROGRESS - it is the next stage and its planned date has not passed.
 *   PLANNED      - a later stage, waiting on its prerequisite.
 *   OVERDUE     - it is the next stage, its planned date has passed, and it has
 *                 not been confirmed.
 *   UNPLANNED   - no tentative date has been set yet.
 */
export function deriveStageStatuses({ schedule, confirmedStages = {}, now }) {
  const today = toPlanDate(now);
  const pending = nextStage(confirmedStages);

  return LIFECYCLE_STAGES.map((stage) => {
    const planned = schedule?.[stage] ?? null;
    const confirmed = confirmedStages[stage] ?? null;

    if (confirmed) {
      const varianceDays =
        planned?.plannedDate && confirmed.confirmedAt
          ? daysBetween(planned.plannedDate, confirmed.confirmedAt)
          : null;
      return {
        stage,
        label: STAGE_LABELS[stage],
        status: 'CONFIRMED',
        plannedDate: planned?.plannedDate ?? null,
        originalPlannedDate: planned?.originalPlannedDate ?? null,
        confirmedAt: confirmed.confirmedAt,
        details: planned?.details ?? null,
        varianceDays,
        // Negative variance means it happened before the plan said it would.
        earlyByDays: varianceDays !== null && varianceDays < 0 ? Math.abs(varianceDays) : 0,
        lateByDays: varianceDays !== null && varianceDays > 0 ? varianceDays : 0,
        overdueByDays: 0,
        isBlocked: false,
      };
    }

    if (!planned?.plannedDate) {
      return {
        stage,
        label: STAGE_LABELS[stage],
        status: 'UNPLANNED',
        plannedDate: null,
        originalPlannedDate: null,
        confirmedAt: null,
        details: planned?.details ?? null,
        varianceDays: null,
        earlyByDays: 0,
        lateByDays: 0,
        overdueByDays: 0,
        isBlocked: stage !== pending,
      };
    }

    const overdueByDays = today && planned.plannedDate < today ? daysBetween(planned.plannedDate, today) : 0;
    const isNext = stage === pending;

    return {
      stage,
      label: STAGE_LABELS[stage],
      status: isNext && overdueByDays > 0 ? 'OVERDUE' : isNext ? 'IN_PROGRESS' : 'PLANNED',
      plannedDate: planned.plannedDate,
      originalPlannedDate: planned.originalPlannedDate ?? planned.plannedDate,
      confirmedAt: null,
      details: planned.details ?? null,
      varianceDays: null,
      earlyByDays: 0,
      lateByDays: 0,
      overdueByDays,
      // A stage whose prerequisite has not happened cannot be confirmed. The UI
      // uses this to disable the control; the aggregate enforces it regardless.
      isBlocked: !isNext,
    };
  });
}

/**
 * Computes the schedule that a delay extension produces.
 *
 * Rules, stated so they can be argued with rather than reverse-engineered:
 *
 *   - the overdue stage moves forward by `extensionDays`;
 *   - every *later unconfirmed* stage shifts by the same amount, which
 *     preserves the gaps the planner originally chose rather than compressing
 *     the remaining voyage into whatever is left;
 *   - confirmed stages never move - they are historical facts;
 *   - the overall estimated duration grows by whatever the last stage needed,
 *     so the planning window still contains the plan.
 *
 * It returns the *proposed* new plan. Nothing is written here; the aggregate
 * decides whether to emit the event, and the event carries both the previous
 * plan and this one.
 */
export function applyExtension({ schedule, confirmedStages = {}, stage, extensionDays, createdAt, estimatedDurationDays }) {
  const revised = {};
  let shifting = false;

  for (const candidate of LIFECYCLE_STAGES) {
    const current = schedule?.[candidate] ?? null;
    if (!current?.plannedDate) {
      revised[candidate] = current;
      continue;
    }
    if (confirmedStages[candidate]) {
      revised[candidate] = current;
      continue;
    }
    if (candidate === stage) shifting = true;
    revised[candidate] = shifting
      ? { ...current, plannedDate: addDays(current.plannedDate, extensionDays) }
      : current;
  }

  const finalPlanned = revised[LIFECYCLE_STAGES[LIFECYCLE_STAGES.length - 1]]?.plannedDate ?? null;
  const requiredDuration = finalPlanned ? daysBetween(createdAt, finalPlanned) : estimatedDurationDays;

  return {
    schedule: revised,
    // The duration only ever grows here. An extension that happened to still
    // fit inside the original window must not quietly shorten the shipment.
    estimatedDurationDays: Math.max(estimatedDurationDays, requiredDuration ?? estimatedDurationDays),
  };
}

/**
 * Computes the schedule that early completion of `stage` suggests.
 *
 * `pullForwardDays` is capped at the slack actually available, so ordering can
 * never be broken by pulling a stage in front of one before it. If the caller
 * asks for more than that, they get the maximum legal shift rather than an
 * error - the UI proposes this number and the operator confirms it.
 *
 * Note what this does NOT do: it does not run automatically when a stage is
 * confirmed early. Confirming a stage emits exactly one event. Re-planning the
 * rest of the voyage is a separate decision, so it is a separate command and a
 * separate event, and an auditor can see that someone chose it.
 */
export function proposeEarlyCompletionShift({ schedule, confirmedStages = {}, stage, actualDate }) {
  const planned = schedule?.[stage]?.plannedDate ?? null;
  if (!planned || !actualDate) return null;

  const gained = daysBetween(actualDate, planned);
  if (gained === null || gained <= 0) return null;

  const laterStages = LIFECYCLE_STAGES.slice(LIFECYCLE_STAGES.indexOf(stage) + 1).filter(
    (candidate) => !confirmedStages[candidate] && schedule?.[candidate]?.plannedDate
  );
  if (laterStages.length === 0) return null;

  const revised = { ...schedule };
  let previousDate = actualDate;
  for (const candidate of laterStages) {
    const currentDate = schedule[candidate].plannedDate;
    const shifted = addDays(currentDate, -gained);
    // Never earlier than the stage before it, and never before the stage that
    // was just completed.
    const safe = shifted < previousDate ? previousDate : shifted;
    revised[candidate] = { ...schedule[candidate], plannedDate: safe };
    previousDate = safe;
  }

  return { schedule: revised, gainedDays: gained, shiftedStages: laterStages };
}

/**
 * Flattens the reducer's schedule state into the shape the read model, the API
 * and the PDF all consume. Kept here so those three cannot drift.
 */
export function summariseSchedule({ schedule, originalSchedule, confirmedStages, createdAt, estimatedDurationDays, originalEstimatedDurationDays, now }) {
  const stages = deriveStageStatuses({ schedule, confirmedStages, now });
  const plannedCompletionDate = createdAt && Number.isInteger(estimatedDurationDays)
    ? addDays(createdAt, estimatedDurationDays)
    : null;
  const originalCompletionDate = createdAt && Number.isInteger(originalEstimatedDurationDays)
    ? addDays(createdAt, originalEstimatedDurationDays)
    : plannedCompletionDate;

  const overdueStages = stages.filter((entry) => entry.status === 'OVERDUE');
  const completed = stages.every((entry) => entry.status === 'CONFIRMED');
  const actualCompletionAt = completed
    ? confirmedStages[LIFECYCLE_STAGES[LIFECYCLE_STAGES.length - 1]]?.confirmedAt ?? null
    : null;

  return {
    stages,
    nextStage: nextStage(confirmedStages),
    estimatedDurationDays: estimatedDurationDays ?? null,
    originalEstimatedDurationDays: originalEstimatedDurationDays ?? estimatedDurationDays ?? null,
    plannedCompletionDate,
    originalPlannedCompletionDate: originalCompletionDate,
    originalSchedule: originalSchedule ?? null,
    isComplete: completed,
    actualCompletionAt,
    actualDurationDays: actualCompletionAt && createdAt ? daysBetween(createdAt, actualCompletionAt) : null,
    isOverdue: overdueStages.length > 0,
    overdueStages: overdueStages.map((entry) => entry.stage),
    maxOverdueDays: overdueStages.reduce((max, entry) => Math.max(max, entry.overdueByDays), 0),
  };
}
