import { loadConfig } from '../../src/config/env.js';
import { connectDatabase } from '../../src/config/database.js';
import { buildContainer } from '../../src/app/dependencies.js';
import { createApp } from '../../src/app/app.js';
import { silentLogger } from '../../src/shared/logging/logger.js';

/**
 * Builds a complete, isolated system for a test.
 *
 * Every call gets its own in-process store, so tests are independent and can
 * run in any order without a shared database to clean up between them. The
 * wiring is the production wiring - the same `buildContainer` and `createApp`
 * the server uses - so these tests exercise the real object graph rather than a
 * parallel test-only arrangement.
 */
export async function createTestSystem(overrides = {}) {
  const config = loadConfig({
    persistence: 'memory',
    logLevel: 'error',
    corsOrigin: '*',
    rateLimit: { enabled: false, windowMs: 60_000, maxRequests: 10_000 },
    worker: {
      enabled: true,
      inProcess: false,
      // Tests drive the worker explicitly via runOnce()/catchUp() rather than
      // racing a timer, so the interval is irrelevant but kept small.
      pollIntervalMs: 10,
      batchSize: 100,
      maxRetries: 3,
      retryBackoffMs: 1,
      name: 'test-projection-worker',
    },
    limits: { maxEventsPerQuery: 5000, maxShipmentsPerPage: 100 },
    ...overrides,
  });

  const { db, close } = await connectDatabase({ config, logger: silentLogger });
  const container = buildContainer({ db, config, logger: silentLogger });
  const app = createApp({ container });

  return {
    app,
    db,
    config,
    container,
    ...container,
    teardown: async () => {
      await container.projectionWorker.stop().catch(() => {});
      await close();
    },
  };
}

/**
 * Starts the Express app on an ephemeral port and returns a small fetch-based
 * client. Using the real HTTP stack (rather than an in-process request shim)
 * means status codes, headers, JSON parsing and the error middleware are all
 * genuinely exercised.
 */
export async function startHttp(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const request = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, body: json, raw: text };
  };

  return {
    base,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    raw: request,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Seeds the source document's canonical four-event sequence via real commands.
 *
 * A short pause separates the commands so that each event lands on a distinct
 * millisecond. Without it the four events can share a timestamp, and a
 * timestamp-based historical query would - correctly, under the documented
 * inclusive boundary rule - return all four. Real traffic is seconds apart; the
 * pause just stops the test fixture from being unrealistically instantaneous.
 * Ordering itself never depends on this: version is the deterministic key.
 */
export async function seedCanonicalShipment(container, shipmentId = 'SHP-TEST-1') {
  const svc = container.shipmentCommandService;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  const created = await svc.createShipment({
    shipmentId,
    containerCode: 'MSKU0000001',
    origin: 'Chennai, IN',
    destination: 'Rotterdam, NL',
    minTemperatureC: 2,
    maxTemperatureC: 8,
  });
  await tick();
  const loaded = await svc.moveShipment({
    shipmentId,
    movementType: 'LOAD_ON_SHIP',
    location: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    expectedVersion: created.version,
  });
  await tick();
  const spike = await svc.recordTemperature({
    shipmentId,
    temperatureC: 12.4,
    expectedVersion: loaded.version,
  });
  await tick();
  const arrived = await svc.moveShipment({
    shipmentId,
    movementType: 'ARRIVE_AT_PORT',
    location: 'Rotterdam, NL',
    portName: 'Port of Rotterdam',
    expectedVersion: spike.version,
  });

  return { shipmentId, created, loaded, spike, arrived };
}
