import { bootstrap } from '../src/app/bootstrap.js';

/**
 * Destroys and rebuilds the entire read model from the Event Store.
 *
 * This is the recovery procedure whenever the projection is suspected of having
 * drifted (roadmap 22 - "Read Model inconsistent"). It is safe to run at any
 * time, because the read model is derived data: everything it contains can be
 * recomputed from events, and nothing in it is a source of truth.
 *
 *   node scripts/rebuildReadModel.js
 *   node scripts/rebuildReadModel.js --check   # report drift, change nothing
 */
async function main() {
  const checkOnly = process.argv.includes('--check');
  const { container, config, shutdown } = await bootstrap();
  const { reconciliationService, checkpointRepository, eventStore } = container;

  if (checkOnly) {
    const report = await reconciliationService.reconcileAll();
    process.stdout.write(
      `Checked ${report.checked} aggregate(s): ${report.consistent} consistent, ${report.inconsistent} inconsistent.\n`
    );
    for (const result of report.results.filter((r) => !r.consistent)) {
      process.stdout.write(`  ${result.aggregateId}: expected v${result.expectedVersion}, projected v${result.actualVersion}\n`);
      for (const d of result.discrepancies.slice(0, 8)) {
        process.stdout.write(`    - ${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}\n`);
      }
    }
    await shutdown();
    process.exit(report.inconsistent === 0 ? 0 : 1);
  }

  const { rebuilt, latestSequence } = await reconciliationService.rebuildAll();

  // The checkpoint is advanced to the sequence the rebuild covered, so the
  // worker resumes from there instead of reprocessing the whole store.
  await checkpointRepository.save(config.worker.name, {
    lastSequence: latestSequence,
    processedCount: 0,
    status: 'REBUILT',
  });

  process.stdout.write(
    `Rebuilt ${rebuilt} projection(s) from ${await eventStore.countEvents()} event(s). Checkpoint set to sequence ${latestSequence}.\n`
  );
  await shutdown();
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`Rebuild failed: ${error.message}\n`);
  process.exit(1);
});
