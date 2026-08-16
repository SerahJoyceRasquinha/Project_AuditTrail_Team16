import { bootstrap } from '../src/app/bootstrap.js';

/**
 * Seeds a demonstrable dataset.
 *
 * The first shipment reproduces the exact sequence named in the source
 * document - CONTAINER_CREATED -> LOADED_ON_SHIP -> TEMPERATURE_SPIKE ->
 * ARRIVED_AT_PORT - so the demonstration script in docs can be followed
 * verbatim. The others give the dashboard a realistic mix of states, an
 * excursion to investigate, and enough temperature readings to make the chart
 * worth looking at.
 *
 * Note what the seed does NOT do: it never inserts events directly. Every
 * event here is produced by sending a real command through the real command
 * service, so the seeded history is subject to the same validation, the same
 * version sequencing and the same hash chaining as production traffic.
 *
 *   node scripts/seed.js            # seed
 *   node scripts/seed.js --reset    # drop read model first, then seed
 */

const HOUR = 3600 * 1000;

function isoOffset(hoursAgo) {
  return new Date(Date.now() - hoursAgo * HOUR).toISOString();
}

const SHIPMENTS = [
  {
    shipmentId: 'SHP-1001',
    containerCode: 'MSKU7845123',
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
      // The excursion the source's dispute scenario is built around.
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
    origin: 'Nhava Sheva, IN',
    destination: 'Jebel Ali, AE',
    cargoDescription: 'Textiles - dry cargo',
    carrier: 'CMA CGM',
    minTemperatureC: null,
    maxTemperatureC: null,
    script: [
      { type: 'move', at: 96, movementType: 'LOAD_ON_SHIP', location: 'Nhava Sheva Terminal 2', vesselName: 'CMA CGM Kerala', voyageNumber: 'VY-8830' },
      { type: 'move', at: 40, movementType: 'ARRIVE_AT_PORT', location: 'Jebel Ali, AE', portName: 'Jebel Ali Port', berth: 'T3-11' },
      { type: 'move', at: 36, movementType: 'UNLOAD_FROM_SHIP', location: 'Jebel Ali Yard B', yardBlock: 'B-14' },
    ],
  },
  {
    shipmentId: 'SHP-1003',
    containerCode: 'CSQU3054383',
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
    origin: 'Kolkata, IN',
    destination: 'Colombo, LK',
    cargoDescription: 'Machinery parts',
    carrier: 'Hapag-Lloyd',
    minTemperatureC: null,
    maxTemperatureC: null,
    script: [],
  },
];

async function main() {
  const reset = process.argv.includes('--reset');
  const { container, config, logger, shutdown } = await bootstrap();

  if (config.persistence === 'memory') {
    logger.error(
      'Seeding an in-memory store has no effect once this process exits. Set PERSISTENCE=mongo in your .env before seeding.'
    );
    await shutdown();
    process.exit(1);
  }

  const { shipmentCommandService, readModelRepository, projectionWorker, eventStore } = container;

  if (reset) {
    // Only the read model is cleared. The Event Store is append-only and is
    // never truncated - if you need a clean event history, drop the database
    // yourself, deliberately.
    const deleted = await readModelRepository.deleteAll();
    logger.info('Read model cleared before seeding. The Event Store was not touched.', {
      deletedProjections: deleted.deletedCount,
    });
  }

  let created = 0;
  let skipped = 0;

  for (const spec of SHIPMENTS) {
    if (await eventStore.exists(spec.shipmentId)) {
      logger.info('Shipment already exists; skipping.', { shipmentId: spec.shipmentId });
      skipped += 1;
      continue;
    }

    // The creation event is dated just before the shipment's first scripted
    // step, so the whole stream spans real time rather than collapsing into the
    // instant the seed script happened to run.
    const firstStepHoursAgo = spec.script.length > 0 ? spec.script[0].at ?? 2 : 2;

    let version = 0;
    const result = await shipmentCommandService.createShipment({
      occurredAt: isoOffset(firstStepHoursAgo + 2),
      shipmentId: spec.shipmentId,
      containerCode: spec.containerCode,
      origin: spec.origin,
      destination: spec.destination,
      cargoDescription: spec.cargoDescription,
      carrier: spec.carrier,
      minTemperatureC: spec.minTemperatureC,
      maxTemperatureC: spec.maxTemperatureC,
    });
    version = result.version;

    for (const step of spec.script) {
      if (step.type === 'temp') {
        const outcome = await shipmentCommandService.recordTemperature({
          occurredAt: isoOffset(step.at),
          shipmentId: spec.shipmentId,
          temperatureC: step.c,
          recordedAt: isoOffset(step.at),
          sensorId: 'REEFER-01',
          expectedVersion: version,
        });
        version = outcome.version;
      } else {
        const outcome = await shipmentCommandService.moveShipment({
          occurredAt: isoOffset(step.at),
          shipmentId: spec.shipmentId,
          movementType: step.movementType,
          location: step.location,
          vesselName: step.vesselName ?? null,
          voyageNumber: step.voyageNumber ?? null,
          portName: step.portName ?? null,
          berth: step.berth ?? null,
          notes: step.notes ?? null,
          expectedVersion: version,
        });
        version = outcome.version;
      }
    }

    created += 1;
    logger.info('Seeded shipment.', { shipmentId: spec.shipmentId, finalVersion: version });
  }

  // Drain the projection backlog so the dashboard is immediately useful rather
  // than showing a synchronising banner on first load.
  await projectionWorker.catchUp();

  const totalEvents = await eventStore.countEvents();
  logger.info('Seeding complete.', {
    shipmentsCreated: created,
    shipmentsSkipped: skipped,
    totalEventsInStore: totalEvents,
    readModelDocuments: await readModelRepository.count(),
  });

  await shutdown();
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`Seeding failed: ${error.message}\n`);
  process.exit(1);
});
