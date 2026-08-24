import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, startHttp } from '../helpers/testSystem.js';

/**
 * Frontend-driven shipment management, end to end over real HTTP.
 *
 * The point of this suite is not that the endpoints return 200. It is that
 * "create", "edit" and "delete" — the three operations a user expects from a
 * management screen — are implemented without a single UPDATE or DELETE, and
 * that the properties which make this an audit trail survive all three:
 * history stays immutable, the chain stays intact, and any past instant stays
 * reconstructable.
 */
describe('shipment management lifecycle (create / amend / archive / restore)', () => {
  let sys;
  let http;

  before(async () => {
    sys = await createTestSystem();
    http = await startHttp(sys.app);
  });

  after(async () => {
    await http.close();
    await sys.teardown();
  });

  const ID = 'SHP-MGMT-1';

  test('a shipment is created from a command alone, with no seed script', async () => {
    const response = await http.post('/api/shipment/create', {
      shipmentId: ID,
      containerCode: 'MSKU1111111',
      origin: 'Chennai, IN',
      destination: 'Rotterdam, NL',
      carrier: 'Maersk Line',
      minTemperatureC: 2,
      maxTemperatureC: 8,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.eventType, 'CONTAINER_CREATED');
    assert.equal(response.body.version, 1);
    assert.equal(response.body.readModelConsistency, 'eventual');
  });

  test('the new shipment is readable immediately, before the projection catches up', async () => {
    // This is what lets the dashboard show a shipment the instant it is created
    // without polling or a page reload: the query handler replays the events
    // when the read model is behind, and says so.
    const response = await http.get(`/api/shipment/${ID}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.shipment.currentState, 'CREATED');
    assert.equal(response.body.consistency.source, 'event-store-replay');
  });

  test('it appears in the active list once the projection worker runs', async () => {
    await sys.container.projectionWorker.catchUp();
    const response = await http.get('/api/shipments');

    assert.equal(response.body.items.length, 1);
    assert.equal(response.body.items[0].aggregateId, ID);
  });

  test('an amendment appends a new event instead of editing the creation event', async () => {
    await http.post('/api/shipment/move', {
      shipmentId: ID,
      movementType: 'LOAD_ON_SHIP',
      location: 'Chennai Port',
      vesselName: 'MV Ganges Star',
      expectedVersion: 1,
    });

    const amended = await http.post('/api/shipment/amend', {
      shipmentId: ID,
      destination: 'Hamburg, DE',
      carrier: 'Hapag-Lloyd',
      reason: 'Consignee redirected the box',
      expectedVersion: 2,
    });

    assert.equal(amended.status, 200);
    assert.equal(amended.body.eventType, 'SHIPMENT_DETAILS_AMENDED');
    assert.equal(amended.body.version, 3);

    const { events } = (await http.get(`/api/shipment/${ID}/events`)).body;
    const creation = events.find((event) => event.eventType === 'CONTAINER_CREATED');

    // The original declaration is exactly as written. A dispute about what was
    // *originally* agreed is still answerable.
    assert.equal(creation.payload.destination, 'Rotterdam, NL');
    assert.equal(creation.payload.carrier, 'Maersk Line');
    assert.equal(creation.version, 1);
  });

  test('the amendment event carries only the fields that actually changed', async () => {
    const { events } = (await http.get(`/api/shipment/${ID}/events`)).body;
    const amendment = events.find((event) => event.eventType === 'SHIPMENT_DETAILS_AMENDED');

    assert.equal(amendment.payload.destination, 'Hamburg, DE');
    assert.equal(amendment.payload.carrier, 'Hapag-Lloyd');
    assert.equal(amendment.payload.reason, 'Consignee redirected the box');
    // Unchanged fields are absent, so the event reads as a diff.
    assert.equal(amendment.payload.origin, undefined);
    assert.equal(amendment.payload.containerCode, undefined);
  });

  test('replaying the stream yields the amended values without disturbing the lifecycle', async () => {
    await sys.container.projectionWorker.catchUp();
    const { shipment } = (await http.get(`/api/shipment/${ID}`)).body;

    assert.equal(shipment.destination, 'Hamburg, DE');
    assert.equal(shipment.carrier, 'Hapag-Lloyd');
    assert.equal(shipment.amendmentCount, 1);
    // An amendment corrects the manifest; it does not move the container.
    assert.equal(shipment.currentState, 'IN_TRANSIT');
  });

  test('reconstructing an instant before the amendment still shows the original values', async () => {
    const { events } = (await http.get(`/api/shipment/${ID}/events`)).body;
    const atMove = encodeURIComponent(events[1].timestamp);
    const { body } = await http.get(`/api/shipment/${ID}/state?at=${atMove}`);

    assert.equal(body.existedAt, true);
    assert.equal(body.state.destination, 'Rotterdam, NL');
    assert.equal(body.state.carrier, 'Maersk Line');
  });

  test('an amendment that would change nothing is refused', async () => {
    const response = await http.post('/api/shipment/amend', {
      shipmentId: ID,
      destination: 'Hamburg, DE',
      expectedVersion: 3,
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'DOMAIN_RULE_VIOLATION');
  });

  test('an amendment built against a stale version is rejected by OCC', async () => {
    const response = await http.post('/api/shipment/amend', {
      shipmentId: ID,
      carrier: 'Someone Else',
      expectedVersion: 1,
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'CONCURRENCY_CONFLICT');
    assert.equal(response.body.error.details.currentVersion, 3);
    assert.equal(response.body.error.details.applied, false);
  });

  test('archiving removes a shipment from the active list without deleting anything', async () => {
    const archived = await http.post('/api/shipment/archive', {
      shipmentId: ID,
      reason: 'Claim settled',
      expectedVersion: 3,
    });
    assert.equal(archived.body.eventType, 'SHIPMENT_ARCHIVED');
    assert.equal(archived.body.version, 4);

    await sys.container.projectionWorker.catchUp();

    assert.equal((await http.get('/api/shipments')).body.items.length, 0);
    assert.equal((await http.get('/api/shipments?view=archived')).body.items.length, 1);
    assert.equal((await http.get('/api/shipments?view=all')).body.items.length, 1);
  });

  test('the full audit trail survives archival intact', async () => {
    const { events } = (await http.get(`/api/shipment/${ID}/events`)).body;
    assert.equal(events.length, 4);

    // The strongest statement available: the hash chain still verifies, so no
    // stored event was edited or removed when the shipment was "deleted".
    const integrity = (await http.get(`/api/shipment/${ID}/integrity`)).body;
    assert.equal(integrity.intact, true);
    assert.equal(integrity.issues.length, 0);

    const detail = await http.get(`/api/shipment/${ID}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.shipment.archived, true);
  });

  test('an archived shipment accepts no further operational commands', async () => {
    const move = await http.post('/api/shipment/move', {
      shipmentId: ID,
      movementType: 'ARRIVE_AT_PORT',
      location: 'Hamburg',
      portName: 'Port of Hamburg',
      expectedVersion: 4,
    });
    assert.equal(move.status, 409);
    assert.equal(move.body.error.code, 'DOMAIN_RULE_VIOLATION');

    const temperature = await http.post('/api/shipment/temperature', {
      shipmentId: ID,
      temperatureC: 5,
      expectedVersion: 4,
    });
    assert.equal(temperature.status, 409);
  });

  test('restoring appends an event rather than removing the archival event', async () => {
    const restored = await http.post('/api/shipment/restore', { shipmentId: ID, expectedVersion: 4 });
    assert.equal(restored.body.eventType, 'SHIPMENT_RESTORED');
    assert.equal(restored.body.version, 5);

    await sys.container.projectionWorker.catchUp();
    assert.equal((await http.get('/api/shipments')).body.items.length, 1);

    const { events } = (await http.get(`/api/shipment/${ID}/events`)).body;
    // The archival is still on the record; it was undone, not erased.
    assert.ok(events.some((event) => event.eventType === 'SHIPMENT_ARCHIVED'));
    assert.equal(events.length, 5);
  });

  test('the whole stream stays deterministically ordered after five mixed operations', async () => {
    const { events } = (await http.get(`/api/shipment/${ID}/events`)).body;

    assert.deepEqual(
      events.map((event) => event.version),
      [1, 2, 3, 4, 5]
    );
    assert.deepEqual(events.map((event) => event.eventType), [
      'CONTAINER_CREATED',
      'LOADED_ON_SHIP',
      'SHIPMENT_DETAILS_AMENDED',
      'SHIPMENT_ARCHIVED',
      'SHIPMENT_RESTORED',
    ]);

    const times = events.map((event) => Date.parse(event.timestamp));
    assert.ok(times.every((time, index) => index === 0 || time >= times[index - 1]));
  });

  test('the read model agrees with a fresh replay of the whole history', async () => {
    const { body } = await http.get(`/api/shipment/${ID}/reconciliation`);
    assert.equal(body.consistent, true);
    assert.deepEqual(body.discrepancies, []);
  });

  test('an archived instant reconstructs as archived', async () => {
    const { events } = (await http.get(`/api/shipment/${ID}/events`)).body;
    const atArchive = encodeURIComponent(events[3].timestamp);
    const { body } = await http.get(`/api/shipment/${ID}/state?at=${atArchive}`);

    assert.equal(body.state.archived, true);
  });

  test('invalid and impossible commands fail safely, with usable messages', async () => {
    const duplicate = await http.post('/api/shipment/create', {
      shipmentId: ID,
      containerCode: 'X1',
      origin: 'a',
      destination: 'b',
    });
    assert.equal(duplicate.status, 409);

    const unknown = await http.post('/api/shipment/amend', {
      shipmentId: 'SHP-NOT-REAL',
      carrier: 'x',
      expectedVersion: 1,
    });
    assert.ok(unknown.status === 404 || unknown.status === 409);

    const malformed = await http.post('/api/shipment/create', {
      shipmentId: '!!',
      origin: '',
      destination: '',
    });
    assert.equal(malformed.status, 400);
    assert.ok(malformed.body.error.details.issues.length >= 3);

    const empty = await http.post('/api/shipment/amend', { shipmentId: ID, expectedVersion: 5 });
    assert.equal(empty.status, 400);

    // Roadmap 16: no internals ever cross the network.
    const serialised = JSON.stringify(malformed.body);
    assert.ok(!serialised.includes('at Object.'));
    assert.ok(!serialised.includes('.js:'));
  });
});
