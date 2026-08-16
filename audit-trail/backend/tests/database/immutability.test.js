import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestSystem, seedCanonicalShipment } from '../helpers/testSystem.js';
import { COLLECTIONS } from '../../src/config/env.js';

/**
 * The Immutability Audit (roadmap 11.1).
 *
 * The pass condition the roadmap sets is demanding, and deliberately so: there
 * must be demonstrable evidence that the Event Store is genuinely append-only,
 * not merely append-only by convention. So these tests do not only check that
 * the *application* refuses to mutate events - they reach past the application,
 * mutate documents through the raw driver, and then prove the tampering is
 * detected.
 */

async function storedEvents(system, aggregateId) {
  return system.db
    .collection(COLLECTIONS.events)
    .find({ aggregateId })
    .sort({ version: 1 })
    .toArray();
}

test('AUDIT 1: an event, once written, is byte-identical when read back', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-1');
  const first = await storedEvents(system, shipmentId);
  const second = await storedEvents(system, shipmentId);
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
});

test('AUDIT 2: the application offers no way to update an event', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-2');
  const before = await storedEvents(system, shipmentId);

  assert.throws(() => system.eventStore.updateEvent(shipmentId, 1, { payload: { forged: true } }));

  const after = await storedEvents(system, shipmentId);
  assert.deepEqual(after, before, 'the stored events must be unchanged');
});

test('AUDIT 3: the application offers no way to delete an event', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-3');
  assert.throws(() => system.eventStore.deleteEvent(shipmentId, 2));
  assert.equal((await storedEvents(system, shipmentId)).length, 4);
});

test('AUDIT 4: the application offers no way to replace an event', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-4');
  assert.throws(() => system.eventStore.replaceEvent(shipmentId, 1, {}));
  assert.equal((await storedEvents(system, shipmentId)).length, 4);
});

test('AUDIT 5: tampering with a payload outside the application is detected', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-5');
  const before = await system.eventStore.verifyChain(shipmentId);
  assert.equal(before.intact, true);

  // Simulate a privileged actor editing history straight from the mongo shell -
  // exactly the scenario a regulator would ask about.
  await system.db
    .collection(COLLECTIONS.events)
    .updateOne({ aggregateId: shipmentId, version: 3 }, { $set: { 'payload.temperatureC': 4.0 } });

  const after = await system.eventStore.verifyChain(shipmentId);
  assert.equal(after.intact, false);
  assert.ok(after.issues.some((issue) => issue.type === 'CONTENT_TAMPERED'));
});

test('AUDIT 6: tampering with a timestamp is detected', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-6');
  await system.db
    .collection(COLLECTIONS.events)
    .updateOne({ aggregateId: shipmentId, version: 3 }, { $set: { timestamp: '2020-01-01T00:00:00.000Z' } });

  const result = await system.eventStore.verifyChain(shipmentId);
  assert.equal(result.intact, false);
  // This is the dispute scenario from the source document: someone moving when
  // the temperature spike happened cannot do so undetectably.
  assert.ok(result.issues.some((issue) => issue.type === 'CONTENT_TAMPERED'));
});

test('AUDIT 7: tampering with an event type is detected', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-7');
  await system.db
    .collection(COLLECTIONS.events)
    .updateOne({ aggregateId: shipmentId, version: 3 }, { $set: { eventType: 'TEMPERATURE_RECORDED' } });

  const result = await system.eventStore.verifyChain(shipmentId);
  assert.equal(result.intact, false);
});

test('AUDIT 8: tampering with a version is detected', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-8');
  await system.db
    .collection(COLLECTIONS.events)
    .updateOne({ aggregateId: shipmentId, version: 4 }, { $set: { version: 9 } });

  const result = await system.eventStore.verifyChain(shipmentId);
  assert.equal(result.intact, false);
  assert.ok(result.issues.some((issue) => ['VERSION_GAP', 'CONTENT_TAMPERED'].includes(issue.type)));
});

test('AUDIT 9: deleting an event from the middle of a stream is detected', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-9');
  await system.db.collection(COLLECTIONS.events).deleteOne({ aggregateId: shipmentId, version: 2 });

  const result = await system.eventStore.verifyChain(shipmentId);
  assert.equal(result.intact, false);
  assert.ok(result.issues.some((issue) => ['VERSION_GAP', 'BROKEN_LINK'].includes(issue.type)));
});

test('AUDIT 10: an untampered chain verifies clean, so the audit is not vacuous', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-10');
  const result = await system.eventStore.verifyChain(shipmentId);
  assert.equal(result.intact, true);
  assert.equal(result.issues.length, 0);
  assert.equal(result.eventCount, 4);
  assert.equal(typeof result.headHash, 'string');
});

test('AUDIT 11: each event links to its predecessor by hash', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const { shipmentId } = await seedCanonicalShipment(system.container, 'SHP-AUDIT-11');
  const events = await storedEvents(system, shipmentId);

  assert.equal(events[0].previousHash, null);
  for (let i = 1; i < events.length; i += 1) {
    assert.equal(events[i].previousHash, events[i - 1].hash);
  }
});
