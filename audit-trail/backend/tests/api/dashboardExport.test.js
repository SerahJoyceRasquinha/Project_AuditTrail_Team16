import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, startHttp } from '../helpers/testSystem.js';
import { buildDashboardCsv } from '../../src/application/queries/exportDashboardMetrics.js';
import { METRIC_DEFINITIONS, CHART_DEFINITIONS } from '../../src/application/queries/metricDefinitions.js';

/**
 * The dashboard export.
 *
 * The point of this report is that a figure never travels without its
 * definition, so most of what is asserted here is that the explanations are
 * actually present rather than that the file merely parses. A CSV of bare
 * numbers would pass a "did it download" check and still be the wrong artefact.
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

/**
 * Fetches a binary response.
 *
 * The shared test client reads every response with `.text()`, which is right
 * for JSON and CSV and wrong for a PDF - decoding arbitrary bytes as UTF-8
 * replaces anything invalid, so the length and the header bytes stop meaning
 * anything. Binary assertions therefore go through the exposed base URL and
 * read the body as bytes.
 */
async function fetchBytes(http, path) {
  const response = await fetch(`${http.base}${path}`);
  return {
    status: response.status,
    headers: response.headers,
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

let sequence = 0;
async function createShipment(http, overrides = {}) {
  sequence += 1;
  const response = await http.post('/api/shipment/create', {
    containerCode: `EXPT${String(sequence).padStart(7, '0')}`,
    estimatedDurationDays: 10,
    origin: { city: 'Chennai', countryCode: 'IN', stateCode: 'TN' },
    destination: { city: 'Rotterdam', countryCode: 'NL', stateCode: 'ZH' },
    description: 'Test cargo',
    ...overrides,
  });
  assert.equal(response.status, 201);
  return response.body.aggregateId;
}

// --- definitions endpoint ----------------------------------------------------

test('the metric definitions endpoint describes every metric in both registers', async (t) => {
  const { http } = await withServer(t);

  const response = await http.get('/api/meta/metric-definitions');

  assert.equal(response.status, 200);
  assert.equal(response.body.metrics.length, METRIC_DEFINITIONS.length);

  for (const definition of response.body.metrics) {
    assert.ok(definition.key, 'every definition names the field it explains');
    assert.ok(definition.label);
    assert.ok(definition.plain.length > 20, `${definition.key} needs a real plain-English explanation`);
    assert.ok(definition.technical.length > 20, `${definition.key} needs a real technical explanation`);
    assert.ok(definition.formula, `${definition.key} must state how it is computed`);
  }

  assert.ok(response.body.basis.source);
  assert.ok(response.body.basis.scope);
  assert.ok(response.body.basis.freshness);
});

test('every chart on the dashboard is explained too', async (t) => {
  const { http } = await withServer(t);

  const response = await http.get('/api/meta/metric-definitions');

  assert.equal(response.body.charts.length, CHART_DEFINITIONS.length);
  for (const chart of response.body.charts) {
    assert.ok(chart.title);
    assert.ok(chart.plain.length > 20);
    assert.ok(chart.technical.length > 20);
  }
});

test('every metric the API returns has a definition, and vice versa', async (t) => {
  const { system, http } = await withServer(t);
  await createShipment(http);
  await system.projectionWorker.catchUp();

  const metrics = (await http.get('/api/meta/dashboard-metrics')).body;
  const defined = new Set(METRIC_DEFINITIONS.map((definition) => definition.key));

  // `generatedAt` is a timestamp on the envelope, not a metric.
  const reported = Object.keys(metrics).filter((key) => key !== 'generatedAt');

  for (const key of reported) {
    assert.ok(defined.has(key), `metric '${key}' is reported but never explained`);
  }
  for (const key of defined) {
    assert.ok(reported.includes(key), `metric '${key}' is explained but never reported`);
  }
});

// --- CSV ---------------------------------------------------------------------

test('the CSV carries both explanations and the formula for every metric', async (t) => {
  const { system, http } = await withServer(t);
  await createShipment(http);
  await system.projectionWorker.catchUp();

  const response = await http.get('/api/meta/dashboard-metrics/export?format=csv');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.match(response.headers.get('content-disposition'), /attachment; filename=/);

  /**
   * The BOM has to be checked on the raw bytes. `fetch().text()` strips a
   * leading UTF-8 BOM per the WHATWG spec, so asserting on the decoded string
   * would fail even though the bytes are correctly on the wire.
   */
  const { bytes } = await fetchBytes(http, '/api/meta/dashboard-metrics/export?format=csv');
  assert.deepEqual(
    [...bytes.subarray(0, 3)],
    [0xef, 0xbb, 0xbf],
    'a BOM keeps Excel from mangling accented place names'
  );

  const csv = response.raw;
  assert.ok(csv.includes('What it means (plain English)'));
  assert.ok(csv.includes('How it is derived (technical)'));

  for (const definition of METRIC_DEFINITIONS) {
    assert.ok(csv.includes(definition.label), `${definition.label} is missing from the CSV`);
  }
});

test('breakdown metrics are flattened to one row per entry, not stringified into a cell', () => {
  const csv = buildDashboardCsv({
    totalShipments: 3,
    activeShipments: 3,
    archivedShipments: 0,
    byState: { CREATED: 2, IN_TRANSIT: 1, AT_PORT: 0, UNLOADED: 0 },
    withBreaches: 0,
    totalBreaches: 0,
    avgBreachesPerShipment: 0,
    shipmentsByOrigin: { 'Chennai, Tamil Nadu, India': 3 },
    shipmentsByDestination: {},
    averageDeliveryTime: 0,
    onTimeDeliveryRate: 0,
    overallTemperatureCompliance: 100,
    generatedAt: '2026-09-05T00:00:00.000Z',
  });

  // One row per state, each naming the bucket in its own column.
  assert.ok(csv.includes('"Shipments by Lifecycle State","CREATED","2"'));
  assert.ok(csv.includes('"Shipments by Lifecycle State","IN_TRANSIT","1"'));
  assert.ok(csv.includes('"Shipments by Lifecycle State","UNLOADED","0"'));
  assert.ok(csv.includes('"Shipments by Origin","Chennai, Tamil Nadu, India","3"'));
});

test('a place name containing a comma or quote does not break the CSV columns', () => {
  const csv = buildDashboardCsv({
    totalShipments: 1,
    activeShipments: 1,
    archivedShipments: 0,
    byState: { CREATED: 1, IN_TRANSIT: 0, AT_PORT: 0, UNLOADED: 0 },
    withBreaches: 0,
    totalBreaches: 0,
    avgBreachesPerShipment: 0,
    shipmentsByOrigin: { 'Washington, D.C., "the District"': 1 },
    shipmentsByDestination: {},
    averageDeliveryTime: 0,
    onTimeDeliveryRate: 0,
    overallTemperatureCompliance: 100,
  });

  assert.ok(csv.includes('"Washington, D.C., ""the District"""'));
});

// --- PDF ---------------------------------------------------------------------

test('the PDF export returns a real, non-trivial PDF document', async (t) => {
  const { system, http } = await withServer(t);
  await createShipment(http);
  await createShipment(http, { origin: { city: 'Mumbai', countryCode: 'IN', stateCode: 'MH' } });
  await system.projectionWorker.catchUp();

  const response = await fetchBytes(http, '/api/meta/dashboard-metrics/export?format=pdf');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/pdf/);

  const { bytes } = response;
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(bytes.includes(Buffer.from('%%EOF')), 'the document must be terminated, not truncated');
  // A report carrying every definition is necessarily substantial; a few
  // hundred bytes would mean the content silently failed to render.
  assert.ok(bytes.length > 5000, `expected a substantial report, got ${bytes.length} bytes`);
});

test('the PDF renders on an empty fleet rather than dividing by zero', async (t) => {
  const { http } = await withServer(t);

  const { status, bytes } = await fetchBytes(http, '/api/meta/dashboard-metrics/export?format=pdf');

  assert.equal(status, 200);
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(bytes.includes(Buffer.from('%%EOF')));
});

// --- contract ----------------------------------------------------------------

test('an unsupported format is refused rather than guessed at', async (t) => {
  const { http } = await withServer(t);

  const response = await http.get('/api/meta/dashboard-metrics/export?format=xlsx');

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_FORMAT');
});

test('the export defaults to PDF when no format is given', async (t) => {
  const { http } = await withServer(t);

  const response = await http.get('/api/meta/dashboard-metrics/export');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/pdf/);
});

test('the export is served by the query router, so it can never write', async (t) => {
  const { http } = await withServer(t);

  const response = await http.get('/api/meta/dashboard-metrics/export?format=csv');

  assert.equal(response.headers.get('x-cqrs-side'), 'query');
});

test('the exported figures match the ones the dashboard endpoint reports', async (t) => {
  const { system, http } = await withServer(t);
  await createShipment(http);
  await createShipment(http);
  const doomed = await createShipment(http);
  await http.post('/api/shipment/archive', {
    shipmentId: doomed,
    reason: 'closed out after customs clearance',
    expectedVersion: 1,
  });
  await system.projectionWorker.catchUp();

  const metrics = (await http.get('/api/meta/dashboard-metrics')).body;
  const csv = (await http.get('/api/meta/dashboard-metrics/export?format=csv')).raw;

  assert.equal(metrics.totalShipments, 3);
  assert.equal(metrics.archivedShipments, 1);
  // The report is built from the same handler, so the numbers must agree.
  assert.ok(csv.includes(`"Total Shipments","","${metrics.totalShipments}"`));
  assert.ok(csv.includes(`"Active Shipments","","${metrics.activeShipments}"`));
  assert.ok(csv.includes(`"Archived Shipments","","${metrics.archivedShipments}"`));
});
