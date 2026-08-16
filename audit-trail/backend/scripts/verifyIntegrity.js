import { bootstrap } from '../src/app/bootstrap.js';

/**
 * Verifies the hash chain of every stream in the Event Store.
 *
 * This is the command-line half of the Mid-Project Immutability Audit: it
 * detects tampering that happened outside the application, for example someone
 * editing a document straight from the mongo shell.
 *
 *   node scripts/verifyIntegrity.js
 *   node scripts/verifyIntegrity.js SHP-1001
 *
 * Exits non-zero if any chain is broken, so it can be wired into CI.
 */
async function main() {
  const target = process.argv[2] ?? null;
  const { container, shutdown } = await bootstrap();
  const { eventStore } = container;

  const aggregateIds = target ? [target] : await eventStore.listAggregateIds();

  if (aggregateIds.length === 0) {
    process.stdout.write('The Event Store is empty; nothing to verify.\n');
    await shutdown();
    process.exit(0);
  }

  let broken = 0;
  for (const aggregateId of aggregateIds) {
    const result = await eventStore.verifyChain(aggregateId);
    const label = result.intact ? 'INTACT ' : 'BROKEN ';
    process.stdout.write(
      `${label} ${aggregateId.padEnd(14)} events=${String(result.eventCount).padStart(4)}  head=${(result.headHash ?? '-').slice(0, 16)}\n`
    );
    if (!result.intact) {
      broken += 1;
      for (const issue of result.issues) {
        process.stdout.write(`         -> ${issue.type} at version ${issue.version ?? '?'}: ${issue.message ?? ''}\n`);
      }
    }
  }

  process.stdout.write(`\n${aggregateIds.length} stream(s) checked, ${broken} broken.\n`);
  await shutdown();
  process.exit(broken === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`Integrity verification failed: ${error.message}\n`);
  process.exit(1);
});
