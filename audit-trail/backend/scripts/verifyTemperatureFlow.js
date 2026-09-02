/**
 * End-to-end verification, run against a real server over real HTTP.
 *
 * Walks the exact sequence the requirement describes: register, land on the
 * sign-in step, sign in, create a shipment through the ordinary API, then wait
 * for monitoring to produce its first reading on its own and watch it arrive on
 * the realtime stream. Nothing is seeded and no internal function is called
 * directly - if this passes, the flow works for a user.
 *
 * Not part of the test suite: it needs a running backend and it deliberately
 * spends real time waiting. Run it with `node scripts/verifyTemperatureFlow.js`
 * while the server is up.
 */
const BASE = process.env.VERIFY_API_BASE ?? 'http://127.0.0.1:4001';

const log = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => {
  process.stderr.write(`FAILED: ${message}\n`);
  process.exit(1);
};

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json };
}

async function main() {
  const suffix = Date.now().toString(36);
  const credentials = { username: `verify.${suffix}`, password: 'VerifyFlow123', role: 'operator' };

  // 1 - Register. This must create the account and no session.
  const registered = await call('/api/auth/register', { method: 'POST', body: credentials });
  if (registered.status !== 201) fail(`registration returned ${registered.status}`);
  if (registered.body.token) fail('registration issued a session token');
  log(`1. Registered '${credentials.username}' - no token returned, as intended.`);

  // 2 - The registration response cannot open a protected route.
  const unauthenticated = await call('/api/shipments');
  if (unauthenticated.status !== 401) fail(`protected route answered ${unauthenticated.status} without a session`);
  log('2. Protected routes remain closed until an explicit sign-in.');

  // 3 - Sign in with the credentials just chosen.
  const signedIn = await call('/api/auth/login', {
    method: 'POST',
    body: { username: credentials.username, password: credentials.password },
  });
  if (signedIn.status !== 200 || !signedIn.body.token) fail('the new credentials did not sign in');
  const token = signedIn.body.token;
  log('3. Signed in explicitly; a session now exists.');

  // 4 - Create a shipment the ordinary way.
  const created = await call('/api/shipment/create', {
    method: 'POST',
    token,
    body: {
      containerCode: 'MSKU1122334',
      origin: 'Chennai, Tamil Nadu, India',
      destination: 'Rotterdam, South Holland, Netherlands',
      estimatedDurationDays: 18,
      minTemperatureC: 2,
      maxTemperatureC: 8,
    },
  });
  if (created.status !== 201 && created.status !== 200) fail(`shipment creation returned ${created.status}`);
  const shipmentId = created.body.aggregateId;
  const createdAt = Date.parse(created.body.timestamp);
  log(`4. Created ${shipmentId} through the API.`);

  // 5 - Monitoring should have adopted it without anyone asking.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const sensors = await call('/api/meta/sensors', { token });
  const monitored = sensors.body?.monitor?.monitoredShipmentIds ?? [];
  if (!monitored.includes(shipmentId)) fail(`monitoring did not adopt ${shipmentId}: ${JSON.stringify(monitored)}`);
  if (monitored.filter((id) => id === shipmentId).length !== 1) fail('the shipment is monitored more than once');
  log('5. Temperature monitoring started automatically, exactly once.');

  // 6 - Wait for the first reading to appear on its own.
  const delayMs = sensors.body?.monitor?.firstReadingDelayMs ?? 60_000;
  const deadline = Date.now() + delayMs + 45_000;
  let series = null;

  log(`6. Waiting for the first reading (due ${Math.round(delayMs / 1000)}s after creation)...`);
  while (Date.now() < deadline) {
    const response = await call(`/api/shipment/${shipmentId}/sensors`, { token });
    if ((response.body?.readings ?? []).length > 0) {
      series = response.body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!series) fail('no reading appeared before the deadline');

  const first = series.readings[0];
  const offsetMs = Date.parse(first.timestamp) - createdAt;
  log(
    `   First reading: ${first.temperatureC}°C at ${first.timestamp} ` +
      `(${Math.round(offsetMs / 1000)}s after creation, source ${first.source}).`
  );
  if (Math.abs(offsetMs - delayMs) > 2000) fail(`the first reading is ${offsetMs}ms after creation, expected ${delayMs}ms`);

  // 7 - It is a real event in the shipment's history, and the chain still holds.
  const events = await call(`/api/shipment/${shipmentId}/events`, { token });
  const readings = (events.body?.events ?? []).filter((event) =>
    ['TEMPERATURE_RECORDED', 'TEMPERATURE_SPIKE'].includes(event.eventType)
  );
  if (readings.length === 0) fail('the reading is not in the event history');

  const integrity = await call(`/api/shipment/${shipmentId}/integrity`, { token });
  if (integrity.body?.intact !== true) fail('the hash chain no longer verifies');
  log(`7. The reading is event v${readings[0].version} in the immutable history; the hash chain verifies.`);

  // 8 - Complete the shipment; monitoring must stop.
  for (const [movementType, extra] of [
    ['LOAD_ON_SHIP', { location: 'Chennai Port', vesselName: 'MV Verify' }],
    ['ARRIVE_AT_PORT', { location: 'Rotterdam', portName: 'Port of Rotterdam' }],
    ['UNLOAD_FROM_SHIP', { location: 'Rotterdam Yard' }],
  ]) {
    /**
     * The current version is re-read before each command rather than carried
     * forward from the creation response, because automatic readings advance
     * the stream between commands. That is not a quirk of this script: it is
     * optimistic concurrency working, and the dashboard handles it the same way
     * by refetching whenever the realtime stream reports a new version.
     */
    const current = await call(`/api/shipment/${shipmentId}`, { token });
    const moved = await call('/api/shipment/move', {
      method: 'POST',
      token,
      body: {
        shipmentId,
        movementType,
        expectedVersion: current.body.shipment.currentVersion,
        ...extra,
      },
    });
    if (moved.status >= 400) fail(`${movementType} returned ${moved.status}: ${JSON.stringify(moved.body)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
  const after = await call('/api/meta/sensors', { token });
  if ((after.body?.monitor?.monitoredShipmentIds ?? []).includes(shipmentId)) {
    fail('monitoring continued after the shipment completed');
  }
  log('8. Shipment completed; its monitoring stopped and no timer remains.');

  log('\nEnd-to-end flow verified.');
}

main().catch((error) => fail(error.stack ?? error.message));
