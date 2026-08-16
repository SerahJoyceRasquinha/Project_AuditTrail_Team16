import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestSystem } from '../helpers/testSystem.js';
import { ConcurrencyConflictError } from '../../src/shared/errors/AppError.js';

/**
 * Optimistic Concurrency Control (roadmap 13.1 - 13.4).
 *
 * The scenario the source describes: two clients load the same aggregate at
 * version N; one wins; the other must be rejected rather than silently
 * overwriting. These tests assert not only that the loser is rejected, but that
 * the Event Store is left with exactly one new event and no duplicate version -
 * which is the property that actually matters.
 */

async function seedInTransit(system, shipmentId) {
  const svc = system.shipmentCommandService;
  const created = await svc.createShipment({
    shipmentId,
    containerCode: 'MSKU1',
    origin: 'Chennai',
    destination: 'Rotterdam',
    minTemperatureC: 2,
    maxTemperatureC: 8,
  });
  const loaded = await svc.moveShipment({
    shipmentId,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: created.version,
  });
  return loaded.version;
}

test('a command carrying the current version succeeds', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const version = await seedInTransit(system, 'SHP-OCC-1');
  const result = await system.shipmentCommandService.recordTemperature({
    shipmentId: 'SHP-OCC-1',
    temperatureC: 5,
    expectedVersion: version,
  });
  assert.equal(result.version, version + 1);
});

test('a stale command is rejected with both version numbers', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const version = await seedInTransit(system, 'SHP-OCC-2');

  // User A wins.
  await system.shipmentCommandService.recordTemperature({
    shipmentId: 'SHP-OCC-2',
    temperatureC: 5,
    expectedVersion: version,
  });

  // User B is still holding the version they loaded before A's command.
  await assert.rejects(
    () =>
      system.shipmentCommandService.recordTemperature({
        shipmentId: 'SHP-OCC-2',
        temperatureC: 6,
        expectedVersion: version,
      }),
    (error) => {
      assert.ok(error instanceof ConcurrencyConflictError);
      assert.equal(error.status, 409);
      assert.equal(error.details.expectedVersion, version);
      assert.equal(error.details.currentVersion, version + 1);
      // The client must be told unambiguously that nothing was written.
      assert.equal(error.details.applied, false);
      return true;
    }
  );
});

test('a rejected command appends nothing at all', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const version = await seedInTransit(system, 'SHP-OCC-3');
  const before = await system.eventStore.countEvents('SHP-OCC-3');

  await assert.rejects(() =>
    system.shipmentCommandService.recordTemperature({
      shipmentId: 'SHP-OCC-3',
      temperatureC: 6,
      expectedVersion: version - 1,
    })
  );

  assert.equal(await system.eventStore.countEvents('SHP-OCC-3'), before);
});

test('two simultaneous commands at the same version: exactly one wins', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const version = await seedInTransit(system, 'SHP-RACE');

  // Both requests are issued without awaiting the first, so they interleave.
  const results = await Promise.allSettled([
    system.shipmentCommandService.recordTemperature({
      shipmentId: 'SHP-RACE',
      temperatureC: 5,
      expectedVersion: version,
    }),
    system.shipmentCommandService.recordTemperature({
      shipmentId: 'SHP-RACE',
      temperatureC: 6,
      expectedVersion: version,
    }),
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'exactly one command must succeed');
  assert.equal(rejected.length, 1, 'exactly one command must be rejected');
  assert.ok(rejected[0].reason instanceof ConcurrencyConflictError);

  const events = await system.eventStore.getEvents('SHP-RACE');
  const versions = events.map((event) => event.version);
  assert.deepEqual(versions, [1, 2, 3], 'the version sequence must be gapless with no duplicates');
  assert.equal(new Set(versions).size, versions.length);
});

test('a burst of concurrent commands produces a clean version sequence', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const version = await seedInTransit(system, 'SHP-BURST');

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (unused, index) =>
      system.shipmentCommandService.recordTemperature({
        shipmentId: 'SHP-BURST',
        temperatureC: 4 + index * 0.1,
        expectedVersion: version,
      })
    )
  );

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 9);
  for (const rejection of results.filter((r) => r.status === 'rejected')) {
    assert.ok(rejection.reason instanceof ConcurrencyConflictError);
  }

  const versions = (await system.eventStore.getEvents('SHP-BURST')).map((e) => e.version);
  assert.deepEqual(versions, [1, 2, 3]);
});

test('creating the same shipment twice concurrently produces one stream', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const results = await Promise.allSettled([
    system.shipmentCommandService.createShipment({
      shipmentId: 'SHP-DUP',
      containerCode: 'A',
      origin: 'X',
      destination: 'Y',
    }),
    system.shipmentCommandService.createShipment({
      shipmentId: 'SHP-DUP',
      containerCode: 'B',
      origin: 'X',
      destination: 'Y',
    }),
  ]);

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await system.eventStore.countEvents('SHP-DUP'), 1);
});

test('after a conflict, resubmitting against the current version succeeds', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const version = await seedInTransit(system, 'SHP-RETRY');
  await system.shipmentCommandService.recordTemperature({
    shipmentId: 'SHP-RETRY',
    temperatureC: 5,
    expectedVersion: version,
  });

  let conflict;
  try {
    await system.shipmentCommandService.recordTemperature({
      shipmentId: 'SHP-RETRY',
      temperatureC: 6,
      expectedVersion: version,
    });
  } catch (error) {
    conflict = error;
  }

  // The remediation path the error advertises must actually work.
  const retry = await system.shipmentCommandService.recordTemperature({
    shipmentId: 'SHP-RETRY',
    temperatureC: 6,
    expectedVersion: conflict.details.currentVersion,
  });
  assert.equal(retry.version, conflict.details.currentVersion + 1);
});

test('the read model eventually reflects only the successful command', async (t) => {
  const system = await createTestSystem();
  t.after(() => system.teardown());

  const version = await seedInTransit(system, 'SHP-RACE-RM');
  await Promise.allSettled([
    system.shipmentCommandService.recordTemperature({
      shipmentId: 'SHP-RACE-RM',
      temperatureC: 5,
      expectedVersion: version,
    }),
    system.shipmentCommandService.recordTemperature({
      shipmentId: 'SHP-RACE-RM',
      temperatureC: 6,
      expectedVersion: version,
    }),
  ]);

  await system.projectionWorker.catchUp();
  const projection = await system.readModelRepository.findById('SHP-RACE-RM');
  assert.equal(projection.currentVersion, 3);
  assert.equal(projection.temperatureReadingCount, 1);
});
