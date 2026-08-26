import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestSystem, startHttp } from '../helpers/testSystem.js';
import { EVENT_TYPES } from '../../src/domain/shipment/events/eventTypes.js';

async function withServer(t) {
  const system = await createTestSystem();
  const http = await startHttp(system.app);
  t.after(async () => {
    await http.close();
    await system.teardown();
  });
  return { system, http };
}

const CREATE_BODY = {
  containerCode: 'msku7845123',
  originLocation: { city: 'Chennai', countryCode: 'IN', stateCode: 'TN' },
  destinationLocation: { city: 'Rotterdam', countryCode: 'NL', stateCode: 'ZH' },
  estimatedDurationDays: 20,
  minTemperatureC: 2,
  maxTemperatureC: 8,
};

/** Plan dates relative to the shipment's own creation day, in UTC. */
function planFrom(createdAt, offsets = [2, 12, 14]) {
  const day = new Date(createdAt);
  const at = (offset) =>
    new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + offset))
      .toISOString()
      .slice(0, 10);
  return {
    LOAD_ON_SHIP: { plannedDate: at(offsets[0]), details: { vesselName: 'MV Ganges Star' } },
    ARRIVE_AT_PORT: { plannedDate: at(offsets[1]), details: { portName: 'Port of Rotterdam' } },
    UNLOAD_FROM_SHIP: { plannedDate: at(offsets[2]), details: { yardBlock: 'D7' } },
  };
}

// ---------------------------------------------------------------------------
// Automatic shipment ID generation (requirement 3)
// ---------------------------------------------------------------------------

test('a shipment created without an id is assigned SHP-1, then SHP-2', async (t) => {
  const { http } = await withServer(t);

  const first = await http.post('/api/shipment/create', CREATE_BODY);
  const second = await http.post('/api/shipment/create', CREATE_BODY);

  assert.equal(first.status, 201);
  assert.equal(first.body.aggregateId, 'SHP-1');
  assert.equal(second.body.aggregateId, 'SHP-2');
});

test('generated ids are not zero-padded', async (t) => {
  const { http } = await withServer(t);
  const created = await http.post('/api/shipment/create', CREATE_BODY);
  assert.equal(created.body.aggregateId, 'SHP-1');
  assert.notEqual(created.body.aggregateId, 'SHP-001');
});

test('concurrent creations never receive the same identifier', async (t) => {
  const { http } = await withServer(t);

  // The failure mode this guards against is max(id)+1: twenty simultaneous
  // requests all reading the same maximum and computing the same successor.
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => http.post('/api/shipment/create', CREATE_BODY))
  );

  const ids = responses.map((response) => response.body.aggregateId);
  assert.equal(new Set(ids).size, 20, 'every concurrent creation must get a unique id');
  assert.ok(responses.every((response) => response.status === 201));

  const numbers = ids.map((id) => Number(id.replace('SHP-', ''))).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 20 }, (unused, index) => index + 1));
});

test('an explicitly supplied id is still honoured, for backfill and seeding', async (t) => {
  const { http } = await withServer(t);
  const created = await http.post('/api/shipment/create', { ...CREATE_BODY, shipmentId: 'SHP-LEGACY-9' });
  assert.equal(created.body.aggregateId, 'SHP-LEGACY-9');
});

test('the identifier is fixed at creation and cannot be amended', async (t) => {
  const { http } = await withServer(t);
  const created = await http.post('/api/shipment/create', CREATE_BODY);

  const amended = await http.post('/api/shipment/amend', {
    shipmentId: created.body.aggregateId,
    aggregateId: 'SHP-999',
    shipmentIdNew: 'SHP-999',
    carrier: 'Maersk Line',
    expectedVersion: created.body.version,
  });

  assert.equal(amended.status, 200);
  const after = await http.get(`/api/shipment/${created.body.aggregateId}`);
  assert.equal(after.body.shipment.aggregateId, created.body.aggregateId);
});

// ---------------------------------------------------------------------------
// Container code and location normalisation (requirements 2, 4)
// ---------------------------------------------------------------------------

test('a lowercase container code is stored upper-cased', async (t) => {
  const { http } = await withServer(t);
  const created = await http.post('/api/shipment/create', CREATE_BODY);

  const events = await http.get(`/api/shipment/${created.body.aggregateId}/events`);
  assert.equal(events.body.events[0].payload.containerCode, 'MSKU7845123');
});

test('backend normalisation cannot be bypassed by posting directly', async (t) => {
  const { http } = await withServer(t);
  // No browser involved: this is the raw API, which is exactly the path a
  // frontend-only normalisation would leave open.
  const created = await http.post('/api/shipment/create', {
    ...CREATE_BODY,
    containerCode: '  mskU 111 ',
  });
  const events = await http.get(`/api/shipment/${created.body.aggregateId}/events`);
  assert.equal(events.body.events[0].payload.containerCode, 'MSKU111');
});

test('the stored location carries codes and a readable display string', async (t) => {
  const { http } = await withServer(t);
  const created = await http.post('/api/shipment/create', CREATE_BODY);
  const events = await http.get(`/api/shipment/${created.body.aggregateId}/events`);
  const payload = events.body.events[0].payload;

  assert.equal(payload.originLocation.countryCode, 'IN');
  assert.equal(payload.originLocation.stateCode, 'TN');
  assert.equal(payload.origin, 'Chennai, Tamil Nadu, India');
});

test('a state that does not belong to the country is rejected by the backend', async (t) => {
  const { http } = await withServer(t);
  const response = await http.post('/api/shipment/create', {
    ...CREATE_BODY,
    originLocation: { city: 'Chennai', countryCode: 'IN', stateCode: 'CA' },
  });

  assert.equal(response.status, 400);
  assert.ok(
    response.body.error.details.issues.some((issue) => issue.code === 'STATE_NOT_IN_COUNTRY')
  );
});

test('a state without a country is rejected by the backend', async (t) => {
  const { http } = await withServer(t);
  const response = await http.post('/api/shipment/create', {
    ...CREATE_BODY,
    originLocation: { city: 'Chennai', countryCode: '', stateCode: 'TN' },
  });
  assert.equal(response.status, 400);
  assert.ok(
    response.body.error.details.issues.some((issue) => issue.code === 'STATE_WITHOUT_COUNTRY')
  );
});

// ---------------------------------------------------------------------------
// Creation timestamp (requirement 5)
// ---------------------------------------------------------------------------

test('the creation timestamp is generated by the server, not the client', async (t) => {
  const { http } = await withServer(t);
  const before = Date.now();
  const created = await http.post('/api/shipment/create', CREATE_BODY);
  const after = Date.now();

  const stamped = Date.parse(created.body.timestamp);
  assert.ok(stamped >= before && stamped <= after, 'timestamp must come from the server clock');
});

test('the original creation timestamp survives later events unchanged', async (t) => {
  const { http, system } = await withServer(t);
  const created = await http.post('/api/shipment/create', CREATE_BODY);
  const id = created.body.aggregateId;

  await http.post('/api/shipment/amend', {
    shipmentId: id,
    carrier: 'Maersk Line',
    expectedVersion: created.body.version,
  });

  const replayed = await system.replayService.reconstructCurrentState(id);
  assert.equal(replayed.state.createdAt, created.body.timestamp);
});

// ---------------------------------------------------------------------------
// Estimated duration validation over HTTP (requirement 7)
// ---------------------------------------------------------------------------

test('creation is refused without an estimated duration', async (t) => {
  const { http } = await withServer(t);
  const body = { ...CREATE_BODY };
  delete body.estimatedDurationDays;
  const response = await http.post('/api/shipment/create', body);
  assert.equal(response.status, 400);
});

test('zero, negative, decimal and text durations are all refused over HTTP', async (t) => {
  const { http } = await withServer(t);
  for (const value of [0, -1, 2.5, 'ten']) {
    const response = await http.post('/api/shipment/create', {
      ...CREATE_BODY,
      estimatedDurationDays: value,
    });
    assert.equal(response.status, 400, `${JSON.stringify(value)} should be refused`);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle planning and confirmation (requirements 8-12)
// ---------------------------------------------------------------------------

async function createAndPlan(http) {
  const created = await http.post('/api/shipment/create', CREATE_BODY);
  const id = created.body.aggregateId;
  const planned = await http.post('/api/shipment/schedule/plan', {
    shipmentId: id,
    schedule: planFrom(created.body.timestamp),
    expectedVersion: created.body.version,
  });
  return { id, created, planned };
}

test('a schedule can be planned for all three stages before any is confirmed', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  assert.equal(planned.status, 200);
  assert.equal(planned.body.eventType, EVENT_TYPES.SHIPMENT_SCHEDULE_PLANNED);

  const schedule = await http.get(`/api/shipment/${id}/schedule`);
  assert.equal(schedule.body.planned, true);
  assert.equal(schedule.body.stages.length, 3);
  assert.equal(schedule.body.nextStage, 'LOAD_ON_SHIP');
});

test('planning refuses a date outside the shipment window, even posted directly', async (t) => {
  const { http } = await withServer(t);
  const created = await http.post('/api/shipment/create', CREATE_BODY);

  const response = await http.post('/api/shipment/schedule/plan', {
    shipmentId: created.body.aggregateId,
    schedule: planFrom(created.body.timestamp, [2, 12, 400]),
    expectedVersion: created.body.version,
  });

  assert.equal(response.status, 409);
  assert.ok(
    response.body.error.details.issues.some((issue) => issue.code === 'OUTSIDE_PLANNING_WINDOW')
  );
});

test('planning refuses arrival before loading, even posted directly', async (t) => {
  const { http } = await withServer(t);
  const created = await http.post('/api/shipment/create', CREATE_BODY);

  const response = await http.post('/api/shipment/schedule/plan', {
    shipmentId: created.body.aggregateId,
    schedule: planFrom(created.body.timestamp, [10, 4, 14]),
    expectedVersion: created.body.version,
  });

  assert.equal(response.status, 409);
  assert.ok(
    response.body.error.details.issues.some((issue) => issue.code === 'STAGE_ORDER_VIOLATION')
  );
});

test('arrival cannot be confirmed before loading', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  const response = await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'ARRIVE_AT_PORT',
    location: 'Rotterdam',
    portName: 'Port of Rotterdam',
    expectedVersion: planned.body.version,
  });

  assert.equal(response.status, 409);
  assert.match(response.body.error.message, /cannot be confirmed before Load on Ship/i);
});

test('unloading cannot be confirmed before arrival', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  const loaded = await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: planned.body.version,
  });

  const response = await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'UNLOAD_FROM_SHIP',
    location: 'Rotterdam Yard',
    expectedVersion: loaded.body.version,
  });

  assert.equal(response.status, 409);
  assert.match(response.body.error.message, /cannot be confirmed before Arrive at Port/i);
});

test('the full lifecycle in order is accepted and completes the shipment', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  const loaded = await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: planned.body.version,
  });
  const arrived = await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'ARRIVE_AT_PORT',
    location: 'Rotterdam',
    portName: 'Port of Rotterdam',
    expectedVersion: loaded.body.version,
  });
  const unloaded = await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'UNLOAD_FROM_SHIP',
    location: 'Rotterdam Yard',
    expectedVersion: arrived.body.version,
  });

  assert.equal(unloaded.status, 200);

  const schedule = await http.get(`/api/shipment/${id}/schedule`);
  assert.equal(schedule.body.isComplete, true);
  assert.equal(schedule.body.stages.every((stage) => stage.status === 'CONFIRMED'), true);
});

test('a stage already confirmed cannot be confirmed twice', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  const loaded = await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: planned.body.version,
  });

  const again = await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: loaded.body.version,
  });

  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /already been confirmed/i);
});

test('a shipment cannot be re-loaded after it has been unloaded', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  const loaded = await http.post('/api/shipment/move', {
    shipmentId: id, movementType: 'LOAD_ON_SHIP', location: 'A', vesselName: 'V',
    expectedVersion: planned.body.version,
  });
  const arrived = await http.post('/api/shipment/move', {
    shipmentId: id, movementType: 'ARRIVE_AT_PORT', location: 'B', portName: 'P',
    expectedVersion: loaded.body.version,
  });
  const unloaded = await http.post('/api/shipment/move', {
    shipmentId: id, movementType: 'UNLOAD_FROM_SHIP', location: 'C',
    expectedVersion: arrived.body.version,
  });

  // The stream must never describe a journey no physical container took.
  const relist = await http.post('/api/shipment/move', {
    shipmentId: id, movementType: 'LOAD_ON_SHIP', location: 'A', vesselName: 'V',
    expectedVersion: unloaded.body.version,
  });
  assert.equal(relist.status, 409);
});

test('a confirmation records the plan it was measured against', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: planned.body.version,
  });

  const events = await http.get(`/api/shipment/${id}/events`);
  const loadEvent = events.body.events.find((event) => event.eventType === EVENT_TYPES.LOADED_ON_SHIP);
  assert.ok(loadEvent.payload.plannedDate, 'the confirming event carries the planned date');
  assert.equal(typeof loadEvent.payload.varianceDays, 'number');
});

// ---------------------------------------------------------------------------
// Schedule changes preserve history (requirements 10, 14, 15, 16, 21)
// ---------------------------------------------------------------------------

test('an extension appends an event and never overwrites the original plan', async (t) => {
  const { http } = await withServer(t);
  const { id, created, planned } = await createAndPlan(http);
  const originalPlan = planFrom(created.body.timestamp);

  const extended = await http.post('/api/shipment/schedule/extend', {
    shipmentId: id,
    stage: 'LOAD_ON_SHIP',
    extensionDays: 3,
    reason: 'Port congestion at origin',
    expectedVersion: planned.body.version,
  });

  assert.equal(extended.status, 200);
  assert.equal(extended.body.eventType, EVENT_TYPES.SHIPMENT_SCHEDULE_EXTENDED);

  const events = await http.get(`/api/shipment/${id}/events`);
  const extension = events.body.events.find(
    (event) => event.eventType === EVENT_TYPES.SHIPMENT_SCHEDULE_EXTENDED
  );

  // Both sides of the change are on the record.
  assert.equal(
    extension.payload.previousSchedule.LOAD_ON_SHIP.plannedDate,
    originalPlan.LOAD_ON_SHIP.plannedDate
  );
  assert.notEqual(
    extension.payload.schedule.LOAD_ON_SHIP.plannedDate,
    originalPlan.LOAD_ON_SHIP.plannedDate
  );
  assert.equal(extension.payload.extensionDays, 3);

  // And the creation event is untouched.
  assert.equal(events.body.events[0].eventType, EVENT_TYPES.CONTAINER_CREATED);
  assert.equal(events.body.events[0].payload.estimatedDurationDays, 20);
});

test('an extension propagates to later unconfirmed stages', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  const before = await http.get(`/api/shipment/${id}/schedule`);
  await http.post('/api/shipment/schedule/extend', {
    shipmentId: id,
    stage: 'LOAD_ON_SHIP',
    extensionDays: 3,
    expectedVersion: planned.body.version,
  });
  const after = await http.get(`/api/shipment/${id}/schedule`);

  for (const stage of ['LOAD_ON_SHIP', 'ARRIVE_AT_PORT', 'UNLOAD_FROM_SHIP']) {
    assert.notEqual(after.body.plan[stage].plannedDate, before.body.plan[stage].plannedDate);
  }
});

test('the original estimate remains recoverable after an extension', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  await http.post('/api/shipment/schedule/extend', {
    shipmentId: id,
    stage: 'UNLOAD_FROM_SHIP',
    extensionDays: 10,
    expectedVersion: planned.body.version,
  });

  const schedule = await http.get(`/api/shipment/${id}/schedule`);
  assert.equal(schedule.body.originalEstimatedDurationDays, 20);
  assert.ok(schedule.body.estimatedDurationDays > 20);
  // The stage still remembers where it started.
  assert.notEqual(
    schedule.body.plan.UNLOAD_FROM_SHIP.plannedDate,
    schedule.body.plan.UNLOAD_FROM_SHIP.originalPlannedDate
  );
});

test('extension days must be a positive whole number', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  for (const value of [0, -2, 1.5, 'three']) {
    const response = await http.post('/api/shipment/schedule/extend', {
      shipmentId: id,
      stage: 'LOAD_ON_SHIP',
      extensionDays: value,
      expectedVersion: planned.body.version,
    });
    assert.equal(response.status, 400, `${JSON.stringify(value)} should be refused`);
  }
});

test('time scrubbing before a revision shows the original plan', async (t) => {
  const { http } = await withServer(t);
  const { id, created, planned } = await createAndPlan(http);
  const originalPlan = planFrom(created.body.timestamp);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await http.post('/api/shipment/schedule/extend', {
    shipmentId: id,
    stage: 'LOAD_ON_SHIP',
    extensionDays: 4,
    expectedVersion: planned.body.version,
  });

  // As at the instant the plan was first agreed, the extension had not happened.
  const historical = await http.get(
    `/api/shipment/${id}/state?at=${encodeURIComponent(planned.body.timestamp)}`
  );

  assert.equal(
    historical.body.state.schedule.LOAD_ON_SHIP.plannedDate,
    originalPlan.LOAD_ON_SHIP.plannedDate
  );
  assert.equal(historical.body.state.scheduleExtensionCount, 0);
});

test('a schedule cannot be planned twice; the second attempt is refused', async (t) => {
  const { http } = await withServer(t);
  const { id, created, planned } = await createAndPlan(http);

  const again = await http.post('/api/shipment/schedule/plan', {
    shipmentId: id,
    schedule: planFrom(created.body.timestamp, [3, 13, 15]),
    expectedVersion: planned.body.version,
  });

  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /already has a schedule/i);
});

test('a revision that changes nothing is refused', async (t) => {
  const { http } = await withServer(t);
  const { id, created, planned } = await createAndPlan(http);

  const response = await http.post('/api/shipment/schedule/revise', {
    shipmentId: id,
    schedule: planFrom(created.body.timestamp),
    expectedVersion: planned.body.version,
  });

  assert.equal(response.status, 409);
  assert.match(response.body.error.message, /would change nothing/i);
});

// ---------------------------------------------------------------------------
// Optimistic concurrency on the new commands (requirement 18)
// ---------------------------------------------------------------------------

test('a stale version is rejected when confirming a stage', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);
  const staleVersion = planned.body.version;

  await http.post('/api/shipment/schedule/extend', {
    shipmentId: id,
    stage: 'LOAD_ON_SHIP',
    extensionDays: 2,
    expectedVersion: staleVersion,
  });

  // The second operator loaded the page before the extension landed.
  const response = await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: staleVersion,
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'CONCURRENCY_CONFLICT');
  assert.equal(response.body.error.details.applied, false);
});

test('two simultaneous confirmations: exactly one wins', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  const command = {
    shipmentId: id,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: planned.body.version,
  };

  const [a, b] = await Promise.all([
    http.post('/api/shipment/move', command),
    http.post('/api/shipment/move', command),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
});

// ---------------------------------------------------------------------------
// Security surface (requirement 25)
// ---------------------------------------------------------------------------

test('there is no endpoint that appends an arbitrary event type and payload', async (t) => {
  const { http } = await withServer(t);
  const { id, planned } = await createAndPlan(http);

  // A client can express business intent; it cannot dictate what gets stored.
  const attempts = await Promise.all([
    http.post('/api/shipment/append', { shipmentId: id, eventType: 'ANYTHING', payload: {} }),
    http.post('/api/events', { aggregateId: id, eventType: 'ANYTHING', payload: {} }),
    http.post('/api/shipment/event', { shipmentId: id, eventType: 'ANYTHING' }),
  ]);

  for (const attempt of attempts) {
    assert.equal(attempt.status, 404);
  }

  // And a command with an injected event type does not honour it.
  const moved = await http.post('/api/shipment/move', {
    shipmentId: id,
    movementType: 'LOAD_ON_SHIP',
    eventType: 'SHIPMENT_ARCHIVED',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: planned.body.version,
  });
  assert.equal(moved.body.eventType, EVENT_TYPES.LOADED_ON_SHIP);
});
