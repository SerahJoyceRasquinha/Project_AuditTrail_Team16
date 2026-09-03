import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestSystem, startHttp, seedCanonicalShipment } from '../helpers/testSystem.js';

/**
 * Reconciliation must not report a shipment that does not exist as consistent.
 *
 * The service's own answer for an empty stream with no projection is
 * "consistent", and that is correct for the `reconcileAll` sweep - an
 * identifier nobody ever used is not a read-model defect. Served to someone who
 * typed an identifier and is waiting to hear whether their shipment reconciles,
 * the same answer is a confident wrong one. The distinction belongs at the HTTP
 * edge, and these tests hold both halves of it in place.
 */
async function withServer(t) {
  const system = await createTestSystem();
  const http = await startHttp(system.app);
  t.after(async () => {
    await http.close();
    await system.teardown();
  });
  return { system, http };
}

test('reconciling an unknown shipment is a 404, not a green tick', async (t) => {
  const { http } = await withServer(t);

  const response = await http.get('/api/shipment/SHP-DOES-NOT-EXIST/reconciliation');

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'AGGREGATE_NOT_FOUND');
  assert.notEqual(response.body.consistent, true);
});

test('an unknown shipment answers the same way across every query endpoint', async (t) => {
  const { http } = await withServer(t);

  for (const path of [
    '/api/shipment/SHP-NOPE/reconciliation',
    '/api/shipment/SHP-NOPE/integrity',
    '/api/shipment/SHP-NOPE/events',
    '/api/shipment/SHP-NOPE',
  ]) {
    const response = await http.get(path);
    assert.equal(response.status, 404, `${path} should report the shipment as missing`);
  }
});

test('reconciling a real shipment still reports consistency and event count', async (t) => {
  const { system, http } = await withServer(t);
  await seedCanonicalShipment(system.container ?? system, 'SHP-RECON-1');
  await system.projectionWorker.catchUp();

  const response = await http.get('/api/shipment/SHP-RECON-1/reconciliation');

  assert.equal(response.status, 200);
  assert.equal(response.body.consistent, true);
  assert.equal(response.body.discrepancies.length, 0);
  assert.ok(response.body.eventCount > 0, 'a real stream reports how many events it holds');
});

test('the sweep still treats an empty store as consistent rather than throwing', async (t) => {
  const { system } = await withServer(t);

  // reconcileAll must remain usable on a store with nothing in it - the HTTP
  // 404 above is an edge concern and must not have leaked into the service.
  const sweep = await system.container?.reconciliationService?.reconcileAll?.()
    ?? (await system.reconciliationService.reconcileAll());

  assert.equal(sweep.inconsistent, 0);
  assert.equal(sweep.checked, 0);
});
