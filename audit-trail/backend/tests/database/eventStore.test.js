import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestSystem, seedCanonicalShipment } from '../helpers/testSystem.js';
import { createEvent } from '../../src/domain/shipment/events/eventFactory.js';
import { EVENT_TYPES } from '../../src/domain/shipment/events/eventTypes.js';
import { COLLECTIONS } from '../../src/config/env.js';
import {
  ConcurrencyConflictError,
  ImmutabilityViolationError,
  ValidationError,
} from '../../src/shared/errors/AppError.js';

const makeEvent = (version, eventType = EVENT_TYPES.TEMPERATURE_RECORDED, payload = { temperatureC: 4 }) =>
  createEvent({ aggregateId: 'SHP-DB-1', eventType, payload, version });

test('a valid event is appended with every required field', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const stored = await system.eventStore.append(
    createEvent({
      aggregateId: 'SHP-DB-1',
      eventType: EVENT_TYPES.CONTAINER_CREATED,
      payload: { containerCode: 'C1', origin: 'A', destination: 'B' },
      version: 1,
    })
  );

  for (const field of ['aggregateId', 'eventType', 'payload', 'timestamp', 'version']) {
    assert.ok(stored[field] !== undefined, `missing ${field}`);
  }
  assert.equal(typeof stored.hash, 'string');
  assert.equal(stored.previousHash, null);
  assert.equal(typeof stored.sequence, 'number');
});

test('a malformed event cannot be appended', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const valid = makeEvent(1);
  for (const field of ['aggregateId', 'eventType', 'timestamp', 'eventId']) {
    const broken = { ...valid };
    delete broken[field];
    await assert.rejects(() => system.eventStore.append(broken), ValidationError);
  }
  await assert.rejects(() => system.eventStore.append({ ...valid, version: 0 }), ValidationError);
  await assert.rejects(() => system.eventStore.append({ ...valid, timestamp: 'nonsense' }), ValidationError);
});

test('appending a duplicate version is impossible', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await system.eventStore.append(makeEvent(1, EVENT_TYPES.CONTAINER_CREATED, { origin: 'A' }));
  await assert.rejects(
    () => system.eventStore.append(makeEvent(1, EVENT_TYPES.CONTAINER_CREATED, { origin: 'B' })),
    ConcurrencyConflictError
  );
  assert.equal(await system.eventStore.countEvents('SHP-DB-1'), 1);
});

test('a version that skips ahead is rejected, keeping the sequence gapless', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await system.eventStore.append(makeEvent(1, EVENT_TYPES.CONTAINER_CREATED, { origin: 'A' }));
  await assert.rejects(() => system.eventStore.append(makeEvent(5)), ConcurrencyConflictError);
});

test('the unique index on (aggregateId, version) exists and is unique', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const indexes = await system.db.collection(COLLECTIONS.events).indexes_();
  const unique = indexes.find((index) => index.name === 'uniq_aggregate_version');
  assert.ok(unique, 'expected uniq_aggregate_version to exist');
  assert.equal(unique.unique, true);
  // This index is not a performance nicety - it is the database-level
  // enforcement point for optimistic concurrency control.
});

test('the driver itself refuses a duplicate (aggregateId, version) pair', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const collection = system.db.collection(COLLECTIONS.events);
  await system.eventStore.append(makeEvent(1, EVENT_TYPES.CONTAINER_CREATED, { origin: 'A' }));

  await assert.rejects(
    () => collection.insertOne({ aggregateId: 'SHP-DB-1', version: 1, eventType: 'FORGED' }),
    (error) => error.code === 11000
  );
});

test('events are returned in ascending version order', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await seedCanonicalShipment(system.container, 'SHP-ORDER');
  const events = await system.eventStore.getEvents('SHP-ORDER');
  assert.deepEqual(
    events.map((event) => event.version),
    [1, 2, 3, 4]
  );
});

test('the repository exposes no mutation API, and the guards throw if one is called', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { eventStore } = system;
  assert.throws(() => eventStore.updateEvent(), ImmutabilityViolationError);
  assert.throws(() => eventStore.deleteEvent(), ImmutabilityViolationError);
  assert.throws(() => eventStore.replaceEvent(), ImmutabilityViolationError);
  assert.throws(() => eventStore.truncate(), ImmutabilityViolationError);

  // And no method whose name suggests mutation was ever added by accident.
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(eventStore));
  const suspicious = methods.filter((name) => /^(save|upsert|patch|edit|set|modify)/i.test(name));
  assert.deepEqual(suspicious, []);
});

test('read-model documents are keyed uniquely by aggregate', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const indexes = await system.db.collection(COLLECTIONS.readModel).indexes_();
  const unique = indexes.find((index) => index.name === 'uniq_read_model_aggregate');
  assert.ok(unique);
  assert.equal(unique.unique, true);
});

test('the read model updates as the worker processes events', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await seedCanonicalShipment(system.container, 'SHP-RM');
  assert.equal(await system.readModelRepository.findById('SHP-RM'), null);

  await system.projectionWorker.catchUp();
  const projection = await system.readModelRepository.findById('SHP-RM');
  assert.equal(projection.currentVersion, 4);
  assert.equal(projection.currentState, 'AT_PORT');
});

test('the global sequence is strictly increasing across aggregates', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  await seedCanonicalShipment(system.container, 'SHP-A');
  await seedCanonicalShipment(system.container, 'SHP-B');

  const all = await system.eventStore.getEventsAfterSequence(0, 100);
  const sequences = all.map((event) => event.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.equal(new Set(sequences).size, sequences.length);
});
