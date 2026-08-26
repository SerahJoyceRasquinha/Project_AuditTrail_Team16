import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIFECYCLE_STAGES,
  applyExtension,
  daysBetween,
  deriveStageStatuses,
  planningWindow,
  proposeEarlyCompletionShift,
  validatePlannedDates,
  validateWholeDays,
} from '../../src/domain/shipment/schedule/schedulePolicy.js';
import { resolveLocation, findCountry } from '../../src/domain/shipment/reference/locations.js';
import { normaliseContainerCode } from '../../src/domain/shipment/validators/commandValidators.js';

// ---------------------------------------------------------------------------
// Estimated duration (requirement 7)
// ---------------------------------------------------------------------------

test('estimated duration accepts positive whole numbers only', () => {
  for (const good of [1, 5, 10, 30]) {
    assert.equal(validateWholeDays(good).ok, true, `${good} should be valid`);
  }
});

test('estimated duration rejects zero, negatives, decimals, text and empty', () => {
  const bad = [0, -1, 2.5, 'ten', '', null, undefined, true, NaN, Infinity];
  for (const value of bad) {
    assert.equal(
      validateWholeDays(value).ok,
      false,
      `${JSON.stringify(value)} should be rejected`
    );
  }
});

test('a rejected duration explains which rule it broke', () => {
  assert.equal(validateWholeDays(2.5).issue.code, 'NOT_WHOLE');
  assert.equal(validateWholeDays(0).issue.code, 'NOT_POSITIVE');
  assert.equal(validateWholeDays(-1).issue.code, 'NOT_POSITIVE');
  assert.equal(validateWholeDays('ten').issue.code, 'NOT_A_NUMBER');
  assert.equal(validateWholeDays('').issue.code, 'REQUIRED');
});

test('a numeric string is accepted, because HTML inputs produce strings', () => {
  assert.deepEqual(validateWholeDays('7'), { ok: true, value: 7 });
});

// ---------------------------------------------------------------------------
// Planning window and ordering (requirements 9, 10, 11)
// ---------------------------------------------------------------------------

const CREATED_AT = '2026-03-01T09:00:00.000Z';
const WINDOW = planningWindow({ createdAt: CREATED_AT, estimatedDurationDays: 20 });

test('the planning window opens on the creation day and closes on creation + duration', () => {
  assert.equal(WINDOW.earliest, '2026-03-01');
  assert.equal(WINDOW.latest, '2026-03-21');
});

test('a date before shipment creation is refused', () => {
  const result = validatePlannedDates(
    {
      LOAD_ON_SHIP: { plannedDate: '2026-02-27' },
      ARRIVE_AT_PORT: { plannedDate: '2026-03-10' },
      UNLOAD_FROM_SHIP: { plannedDate: '2026-03-12' },
    },
    { window: WINDOW }
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'BEFORE_SHIPMENT_CREATION'));
});

test('a date beyond the estimated completion boundary is refused', () => {
  const result = validatePlannedDates(
    {
      LOAD_ON_SHIP: { plannedDate: '2026-03-02' },
      ARRIVE_AT_PORT: { plannedDate: '2026-03-10' },
      UNLOAD_FROM_SHIP: { plannedDate: '2026-04-15' },
    },
    { window: WINDOW }
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'OUTSIDE_PLANNING_WINDOW'));
});

test('arrival cannot be planned before loading', () => {
  const result = validatePlannedDates(
    {
      LOAD_ON_SHIP: { plannedDate: '2026-03-10' },
      ARRIVE_AT_PORT: { plannedDate: '2026-03-05' },
      UNLOAD_FROM_SHIP: { plannedDate: '2026-03-12' },
    },
    { window: WINDOW }
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'STAGE_ORDER_VIOLATION'));
});

test('unloading cannot be planned before arrival', () => {
  const result = validatePlannedDates(
    {
      LOAD_ON_SHIP: { plannedDate: '2026-03-02' },
      ARRIVE_AT_PORT: { plannedDate: '2026-03-12' },
      UNLOAD_FROM_SHIP: { plannedDate: '2026-03-08' },
    },
    { window: WINDOW }
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'STAGE_ORDER_VIOLATION'));
});

test('a legal, in-window, correctly ordered plan is accepted', () => {
  const result = validatePlannedDates(
    {
      LOAD_ON_SHIP: { plannedDate: '2026-03-02' },
      ARRIVE_AT_PORT: { plannedDate: '2026-03-14' },
      UNLOAD_FROM_SHIP: { plannedDate: '2026-03-16' },
    },
    { window: WINDOW }
  );
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
});

test('a confirmed stage cannot be re-planned', () => {
  const result = validatePlannedDates(
    {
      LOAD_ON_SHIP: { plannedDate: '2026-03-05' },
      ARRIVE_AT_PORT: { plannedDate: '2026-03-14' },
      UNLOAD_FROM_SHIP: { plannedDate: '2026-03-16' },
    },
    {
      window: WINDOW,
      confirmedStages: { LOAD_ON_SHIP: { plannedDate: '2026-03-02', confirmedAt: CREATED_AT } },
    }
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'STAGE_ALREADY_CONFIRMED'));
});

// ---------------------------------------------------------------------------
// Derived status and overdue detection (requirement 14)
// ---------------------------------------------------------------------------

const SCHEDULE = {
  LOAD_ON_SHIP: { plannedDate: '2026-03-02', originalPlannedDate: '2026-03-02' },
  ARRIVE_AT_PORT: { plannedDate: '2026-03-14', originalPlannedDate: '2026-03-14' },
  UNLOAD_FROM_SHIP: { plannedDate: '2026-03-16', originalPlannedDate: '2026-03-16' },
};

test('a stage whose planned date has passed without confirmation is overdue', () => {
  const [load] = deriveStageStatuses({
    schedule: SCHEDULE,
    confirmedStages: {},
    now: '2026-03-05T00:00:00.000Z',
  });
  assert.equal(load.status, 'OVERDUE');
  assert.equal(load.overdueByDays, 3);
});

test('overdue is derived from the instant, so the same stream is not overdue earlier', () => {
  const [load] = deriveStageStatuses({
    schedule: SCHEDULE,
    confirmedStages: {},
    now: '2026-03-01T00:00:00.000Z',
  });
  assert.equal(load.status, 'IN_PROGRESS');
  assert.equal(load.overdueByDays, 0);
});

test('a later stage is blocked, not overdue, while its prerequisite is outstanding', () => {
  const [, arrive] = deriveStageStatuses({
    schedule: SCHEDULE,
    confirmedStages: {},
    now: '2026-03-20T00:00:00.000Z',
  });
  // Its date has passed, but it is not the stage anyone can act on yet - calling
  // it overdue would point the operator at the wrong problem.
  assert.equal(arrive.status, 'PLANNED');
  assert.equal(arrive.isBlocked, true);
});

test('a confirmed stage never becomes overdue and reports its variance', () => {
  const [load] = deriveStageStatuses({
    schedule: SCHEDULE,
    confirmedStages: {
      LOAD_ON_SHIP: { confirmedAt: '2026-03-04T10:00:00.000Z', plannedDate: '2026-03-02' },
    },
    now: '2026-04-01T00:00:00.000Z',
  });
  assert.equal(load.status, 'CONFIRMED');
  assert.equal(load.lateByDays, 2);
  assert.equal(load.overdueByDays, 0);
});

test('a stage confirmed ahead of plan reports how early it was', () => {
  const [load] = deriveStageStatuses({
    schedule: SCHEDULE,
    confirmedStages: {
      LOAD_ON_SHIP: { confirmedAt: '2026-02-28T10:00:00.000Z', plannedDate: '2026-03-02' },
    },
    now: '2026-03-05T00:00:00.000Z',
  });
  assert.equal(load.earlyByDays, 2);
});

// ---------------------------------------------------------------------------
// Extensions and early completion (requirements 14, 15)
// ---------------------------------------------------------------------------

test('an extension shifts the overdue stage and every later unconfirmed stage', () => {
  const result = applyExtension({
    schedule: SCHEDULE,
    confirmedStages: {},
    stage: 'LOAD_ON_SHIP',
    extensionDays: 4,
    createdAt: CREATED_AT,
    estimatedDurationDays: 20,
  });

  assert.equal(result.schedule.LOAD_ON_SHIP.plannedDate, '2026-03-06');
  assert.equal(result.schedule.ARRIVE_AT_PORT.plannedDate, '2026-03-18');
  assert.equal(result.schedule.UNLOAD_FROM_SHIP.plannedDate, '2026-03-20');
});

test('an extension preserves the original planned dates for the audit trail', () => {
  const result = applyExtension({
    schedule: SCHEDULE,
    confirmedStages: {},
    stage: 'LOAD_ON_SHIP',
    extensionDays: 4,
    createdAt: CREATED_AT,
    estimatedDurationDays: 20,
  });
  // The revised entry still carries where it started.
  assert.equal(result.schedule.LOAD_ON_SHIP.originalPlannedDate, '2026-03-02');
});

test('an extension never moves a stage that has already been confirmed', () => {
  const result = applyExtension({
    schedule: SCHEDULE,
    confirmedStages: {
      LOAD_ON_SHIP: { confirmedAt: '2026-03-02T10:00:00.000Z', plannedDate: '2026-03-02' },
    },
    stage: 'ARRIVE_AT_PORT',
    extensionDays: 5,
    createdAt: CREATED_AT,
    estimatedDurationDays: 20,
  });

  assert.equal(result.schedule.LOAD_ON_SHIP.plannedDate, '2026-03-02');
  assert.equal(result.schedule.ARRIVE_AT_PORT.plannedDate, '2026-03-19');
});

test('an extension grows the estimated duration so the plan still fits its window', () => {
  const result = applyExtension({
    schedule: SCHEDULE,
    confirmedStages: {},
    stage: 'UNLOAD_FROM_SHIP',
    extensionDays: 10,
    createdAt: CREATED_AT,
    estimatedDurationDays: 20,
  });
  assert.equal(result.schedule.UNLOAD_FROM_SHIP.plannedDate, '2026-03-26');
  assert.equal(result.estimatedDurationDays, 25);
});

test('an extension inside the existing window never shortens the duration', () => {
  const result = applyExtension({
    schedule: SCHEDULE,
    confirmedStages: {},
    stage: 'UNLOAD_FROM_SHIP',
    extensionDays: 1,
    createdAt: CREATED_AT,
    estimatedDurationDays: 20,
  });
  assert.equal(result.estimatedDurationDays, 20);
});

test('early completion pulls later stages forward without breaking their order', () => {
  const proposal = proposeEarlyCompletionShift({
    schedule: SCHEDULE,
    confirmedStages: {},
    stage: 'LOAD_ON_SHIP',
    actualDate: '2026-02-28',
  });

  assert.equal(proposal.gainedDays, 2);
  assert.equal(proposal.schedule.ARRIVE_AT_PORT.plannedDate, '2026-03-12');
  assert.equal(proposal.schedule.UNLOAD_FROM_SHIP.plannedDate, '2026-03-14');
  assert.ok(
    proposal.schedule.UNLOAD_FROM_SHIP.plannedDate >= proposal.schedule.ARRIVE_AT_PORT.plannedDate
  );
});

test('early completion proposes nothing when a stage finishes on or after plan', () => {
  assert.equal(
    proposeEarlyCompletionShift({
      schedule: SCHEDULE,
      confirmedStages: {},
      stage: 'LOAD_ON_SHIP',
      actualDate: '2026-03-05',
    }),
    null
  );
});

test('daysBetween measures whole UTC days regardless of time of day', () => {
  assert.equal(daysBetween('2026-03-01', '2026-03-04T23:59:00.000Z'), 3);
  assert.equal(daysBetween('2026-03-04', '2026-03-01T00:00:00.000Z'), -3);
});

// ---------------------------------------------------------------------------
// Container code normalisation (requirement 4)
// ---------------------------------------------------------------------------

test('container codes are upper-cased so casing cannot fork a container', () => {
  assert.equal(normaliseContainerCode('msku7845123'), 'MSKU7845123');
  assert.equal(normaliseContainerCode('  msku 7845123 '), 'MSKU7845123');
  assert.equal(normaliseContainerCode('MSKU7845123'), 'MSKU7845123');
});

// ---------------------------------------------------------------------------
// Country / state dependency (requirement 2)
// ---------------------------------------------------------------------------

test('a state cannot be resolved without a country', () => {
  const { issues } = resolveLocation({ city: 'Chennai', countryCode: '', stateCode: 'TN' });
  assert.ok(issues.some((issue) => issue.code === 'STATE_WITHOUT_COUNTRY'));
});

test('a state that does not belong to the country is refused', () => {
  const { issues } = resolveLocation({ city: 'Chennai', countryCode: 'IN', stateCode: 'CA' });
  assert.ok(issues.some((issue) => issue.code === 'STATE_NOT_IN_COUNTRY'));
});

test('a country with subdivisions requires one to be chosen', () => {
  const { issues } = resolveLocation({ city: 'Chennai', countryCode: 'IN', stateCode: '' });
  assert.ok(issues.some((issue) => issue.code === 'STATE_REQUIRED'));
});

test('a valid pair normalises to codes plus a readable display string', () => {
  const { location } = resolveLocation({ city: 'Chennai', countryCode: 'in', stateCode: 'tn' });
  assert.equal(location.countryCode, 'IN');
  assert.equal(location.stateCode, 'TN');
  assert.equal(location.stateName, 'Tamil Nadu');
  assert.equal(location.display, 'Chennai, Tamil Nadu, India');
});

test('a country with no subdivisions resolves without a state', () => {
  const { location, issues } = resolveLocation({
    city: 'Singapore',
    countryCode: 'SG',
    stateCode: '',
  });
  assert.equal(issues.length, 0);
  assert.equal(location.stateCode, null);
});

test('the catalogue exposes the subdivisions the dropdown will offer', () => {
  const india = findCountry('IN');
  assert.ok(india.subdivisions.length > 30);
  assert.ok(india.subdivisions.some((sub) => sub.code === 'KA' && sub.name === 'Karnataka'));
});

test('every lifecycle stage is covered by the canonical order', () => {
  assert.deepEqual(LIFECYCLE_STAGES, ['LOAD_ON_SHIP', 'ARRIVE_AT_PORT', 'UNLOAD_FROM_SHIP']);
});

// ---------------------------------------------------------------------------
// City catalogue (Country -> State -> City)
// ---------------------------------------------------------------------------

test('every curated city key maps to a real country and subdivision', async () => {
  const { cityCatalogue } = await import('../../src/domain/shipment/reference/cities.js');
  const { findCountry, findSubdivision } = await import(
    '../../src/domain/shipment/reference/locations.js'
  );

  for (const key of Object.keys(cityCatalogue())) {
    const countryCode = key.slice(0, 2);
    const stateCode = key.slice(3);
    const country = findCountry(countryCode);
    assert.ok(country, `${key} references an unknown country`);
    if (stateCode) {
      assert.ok(findSubdivision(countryCode, stateCode), `${key} references an unknown subdivision`);
    } else {
      assert.equal(country.hasSubdivisions, false, `${key} omits a required subdivision`);
    }
  }
});

test('every subdivision has at least one suggested city', async () => {
  const { citiesFor } = await import('../../src/domain/shipment/reference/cities.js');
  const { COUNTRIES } = await import('../../src/domain/shipment/reference/locations.js');

  // A gap here would leave a dropdown empty, forcing manual entry for a place
  // the list should have covered.
  for (const country of COUNTRIES) {
    if (!country.hasSubdivisions) {
      assert.ok(citiesFor(country.code, '').length > 0, `${country.code} has no cities`);
      continue;
    }
    for (const sub of country.subdivisions) {
      assert.ok(
        citiesFor(country.code, sub.code).length > 0,
        `${country.code}-${sub.code} has no cities`
      );
    }
  }
});

test('cities are scoped to their own subdivision', async () => {
  const { citiesFor } = await import('../../src/domain/shipment/reference/cities.js');

  assert.ok(citiesFor('IN', 'TN').includes('Chennai'));
  assert.ok(!citiesFor('IN', 'TN').includes('Bengaluru'));
  assert.ok(citiesFor('IN', 'KA').includes('Bengaluru'));
  assert.ok(citiesFor('NL', 'ZH').includes('Rotterdam'));
});

test('the catalogue endpoint payload carries cities per subdivision', async () => {
  const { locationCatalogue } = await import('../../src/domain/shipment/reference/locations.js');
  const payload = locationCatalogue();

  const india = payload.countries.find((country) => country.code === 'IN');
  assert.ok(india.subdivisions.find((sub) => sub.code === 'TN').cities.includes('Chennai'));

  // A country with no subdivisions carries its cities at the country level.
  const singapore = payload.countries.find((country) => country.code === 'SG');
  assert.ok(singapore.cities.length > 0);
});

test('an unlisted city is accepted, because the list is curated and not exhaustive', async () => {
  const { resolveLocation } = await import('../../src/domain/shipment/reference/locations.js');

  // Blocking a real port because a data file was incomplete would be a far
  // worse failure than an inconsistent spelling.
  const { location, issues } = resolveLocation({
    city: 'Some Unlisted Wharf',
    countryCode: 'IN',
    stateCode: 'TN',
  });

  assert.equal(issues.length, 0);
  assert.equal(location.city, 'Some Unlisted Wharf');
  // But the report can still tell how it was entered.
  assert.equal(location.cityFromCatalogue, false);
});

test('a city taken from the list is flagged as such', async () => {
  const { resolveLocation } = await import('../../src/domain/shipment/reference/locations.js');
  const { location } = resolveLocation({ city: 'Chennai', countryCode: 'IN', stateCode: 'TN' });
  assert.equal(location.cityFromCatalogue, true);
});
