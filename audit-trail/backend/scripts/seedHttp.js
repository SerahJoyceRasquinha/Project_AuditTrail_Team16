/**
 * Seeds the demonstration dataset over HTTP, against an already-running API.
 *
 *   npm run seed:http
 *
 * Why this exists alongside `seed.js`:
 *
 * `seed.js` boots its own copy of the application and writes directly through
 * the command service. That is fine for MongoDB, where both processes share a
 * database — but useless with `PERSISTENCE=memory`, where the store lives in one
 * process's heap. A second process seeding its own private store leaves the
 * running server exactly as empty as before.
 *
 * This script instead sends real HTTP commands to the server you are actually
 * looking at, so it works in both modes. It is also the honest demonstration:
 * every shipment below is built the same way a user would build it, through the
 * public command API, with version numbers threaded through by hand exactly as
 * a client must.
 */

const BASE = process.env.SEED_API_BASE ?? 'http://localhost:4000';
const HOUR = 3600 * 1000;
const hoursAgo = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

async function send(path, body) {
  const response = await fetch(`${BASE}/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    const issues = payload?.error?.details?.issues;
    throw new Error(issues ? `${message} ${JSON.stringify(issues)}` : message);
  }
  return payload;
}

const SHIPMENTS = [
  {
    shipmentId: 'SHP-1001',
    containerCode: 'MSKU7845123',
    estimatedDurationDays: 21,
    origin: 'Chennai, IN',
    destination: 'Rotterdam, NL',
    cargoDescription: 'Pharmaceutical cold chain - vaccine consignment',
    carrier: 'Maersk Line',
    minTemperatureC: 2,
    maxTemperatureC: 8,
    script: [
      { type: 'temp', c: 4.1, at: 70 },
      { type: 'move', at: 68, movementType: 'LOAD_ON_SHIP', location: 'Chennai Port, Berth 4', vesselName: 'MV Ganges Star', voyageNumber: 'VY-2291' },
      { type: 'temp', c: 4.4, at: 60 },
      { type: 'temp', c: 5.2, at: 52 },
      // The excursion the dispute scenario is built around.
      { type: 'temp', c: 11.8, at: 44 },
      { type: 'temp', c: 12.6, at: 42 },
      { type: 'temp', c: 7.9, at: 40 },
      { type: 'temp', c: 5.1, at: 30 },
      { type: 'move', at: 12, movementType: 'ARRIVE_AT_PORT', location: 'Rotterdam, NL', portName: 'Port of Rotterdam', berth: 'ECT Delta 7' },
      { type: 'temp', c: 4.8, at: 6 },
    ],
  },
  {
    shipmentId: 'SHP-1002',
    containerCode: 'TGHU4410982',
    estimatedDurationDays: 21,
    origin: 'Nhava Sheva, IN',
    destination: 'Jebel Ali, AE',
    cargoDescription: 'Textiles - dry cargo',
    carrier: 'CMA CGM',
    script: [
      { type: 'move', at: 96, movementType: 'LOAD_ON_SHIP', location: 'Nhava Sheva Terminal 2', vesselName: 'CMA CGM Kerala', voyageNumber: 'VY-8830' },
      { type: 'move', at: 40, movementType: 'ARRIVE_AT_PORT', location: 'Jebel Ali, AE', portName: 'Jebel Ali Port', berth: 'T3-11' },
      { type: 'move', at: 36, movementType: 'UNLOAD_FROM_SHIP', location: 'Jebel Ali Yard B', yardBlock: 'B-14' },
    ],
  },
  {
    shipmentId: 'SHP-1003',
    containerCode: 'CSQU3054383',
    estimatedDurationDays: 21,
    origin: 'Mundra, IN',
    destination: 'Singapore, SG',
    cargoDescription: 'Frozen seafood',
    carrier: 'Ocean Network Express',
    minTemperatureC: -22,
    maxTemperatureC: -16,
    script: [
      { type: 'temp', c: -19.4, at: 30 },
      { type: 'move', at: 28, movementType: 'LOAD_ON_SHIP', location: 'Mundra Port, Berth 9', vesselName: 'ONE Meridian', voyageNumber: 'VY-4417' },
      { type: 'temp', c: -18.9, at: 24 },
      { type: 'temp', c: -14.2, at: 18 },
      { type: 'temp', c: -20.1, at: 10 },
    ],
  },
  {
    shipmentId: 'SHP-1004',
    containerCode: 'HLXU8123447',
    estimatedDurationDays: 21,
    origin: 'Kolkata, IN',
    destination: 'Colombo, LK',
    cargoDescription: 'Machinery parts',
    carrier: 'Hapag-Lloyd',
    // Deliberately left with no movements, so there is a shipment to drive
    // through the lifecycle by hand during a demonstration.
    script: [],
  },
];

async function main() {
  try {
    const health = await fetch(`${BASE}/health`).then((response) => response.json());
    process.stdout.write(`Seeding ${BASE} (persistence: ${health.persistence})\n\n`);
  } catch {
    process.stderr.write(
      `Could not reach the API at ${BASE}.\nStart the backend first (npm run dev), then run this again.\n`
    );
    process.exit(1);
  }

  let created = 0;
  let skipped = 0;

  for (const spec of SHIPMENTS) {
    const firstStepAt = spec.script.length > 0 ? spec.script[0].at ?? 2 : 2;

    let version;
    try {
      const result = await send('shipment/create', {
        occurredAt: hoursAgo(firstStepAt + 2),
        shipmentId: spec.shipmentId,
        estimatedDurationDays: spec.estimatedDurationDays,
        containerCode: spec.containerCode,
        origin: spec.origin,
        destination: spec.destination,
        cargoDescription: spec.cargoDescription,
        carrier: spec.carrier,
        minTemperatureC: spec.minTemperatureC ?? null,
        maxTemperatureC: spec.maxTemperatureC ?? null,
      });
      version = result.version;
    } catch (error) {
      if (/already exists/i.test(error.message)) {
        process.stdout.write(`  ${spec.shipmentId}  already in the ledger, skipping\n`);
        skipped += 1;
        continue;
      }
      throw error;
    }

    for (const step of spec.script) {
      const outcome =
        step.type === 'temp'
          ? await send('shipment/temperature', {
              occurredAt: hoursAgo(step.at),
              shipmentId: spec.shipmentId,
              temperatureC: step.c,
              recordedAt: hoursAgo(step.at),
              sensorId: 'REEFER-01',
              expectedVersion: version,
            })
          : await send('shipment/move', {
              occurredAt: hoursAgo(step.at),
              shipmentId: spec.shipmentId,
              movementType: step.movementType,
              location: step.location,
              vesselName: step.vesselName ?? null,
              voyageNumber: step.voyageNumber ?? null,
              portName: step.portName ?? null,
              berth: step.berth ?? null,
              expectedVersion: version,
            });
      version = outcome.version;
    }

    created += 1;
    process.stdout.write(`  ${spec.shipmentId}  seeded to version ${version}\n`);
  }

  process.stdout.write(`\n${created} shipment(s) seeded, ${skipped} skipped.\n`);
  process.stdout.write('Open http://localhost:5173 and search for SHP-1001.\n');
}

main().catch((error) => {
  process.stderr.write(`\nSeeding failed: ${error.message}\n`);
  process.exit(1);
});
