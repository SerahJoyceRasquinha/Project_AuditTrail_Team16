import { bootstrap } from './app/bootstrap.js';

/**
 * Standalone projection-worker process (roadmap 21 - "Deploy independently").
 *
 * Running this alongside the API with WORKER_IN_PROCESS=false is the honest
 * demonstration of CQRS: the write side, the read side and the projection
 * pipeline are three separate processes sharing only the Event Store.
 *
 * Note that it does not start an HTTP listener. It is a pure consumer.
 *
 * This entry point requires durable persistence: with PERSISTENCE=memory each
 * process has its own store, so a separate worker would have nothing to read.
 */
async function main() {
  const { container, config, logger, shutdown } = await bootstrap();

  if (config.persistence === 'memory') {
    logger.error(
      'The standalone worker cannot run with PERSISTENCE=memory, because it would not share a store with the API. Use PERSISTENCE=mongo, or run the worker in-process.'
    );
    process.exit(1);
  }

  await container.projectionWorker.start();
  logger.info('Standalone projection worker running.', { workerName: config.worker.name });

  const stop = async (signal) => {
    logger.info('Shutdown signal received; finishing the current batch.', { signal });
    await shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'Fatal error while starting the projection worker.',
      reason: error.message,
    })}\n`
  );
  process.exit(1);
});
