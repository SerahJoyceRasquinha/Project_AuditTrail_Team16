import { bootstrap } from './app/bootstrap.js';

/**
 * API server entry point (roadmap 21 - production readiness).
 *
 * The projection worker runs in-process by default so that `npm run dev` gives
 * a working system in one terminal. Set WORKER_IN_PROCESS=false and run
 * `npm run start:worker` separately to demonstrate the worker as an
 * independently deployable process, which is the arrangement roadmap 21
 * describes for production.
 */
async function main() {
  const { app, container, config, logger, shutdown } = await bootstrap();

  if (config.worker.enabled && config.worker.inProcess) {
    await container.projectionWorker.start();
  } else if (!config.worker.inProcess) {
    logger.info('Projection worker is not started in-process. Run `npm run start:worker` separately.', {
      workerName: config.worker.name,
    });
  }

  const server = app.listen(config.port, () => {
    logger.info('Audit Trail API listening.', {
      port: config.port,
      nodeEnv: config.nodeEnv,
      persistence: config.persistence,
      corsOrigin: config.corsOrigin,
      workerInProcess: config.worker.inProcess && config.worker.enabled,
    });
  });

  // Graceful shutdown: stop accepting connections, let the worker finish its
  // current batch, then close the database. A worker killed mid-batch is safe
  // anyway - it resumes from its checkpoint and projection writes are
  // idempotent - but draining cleanly keeps the logs honest.
  let shuttingDown = false;
  const stop = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutdown signal received; draining.', { signal });

    server.close(async () => {
      await shutdown();
      logger.info('Shutdown complete.');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection.', { reason: String(reason) });
  });
}

main().catch((error) => {
  // The logger may not exist yet if config or the database failed, so this one
  // path writes directly to stderr.
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'Fatal error during startup.',
      reason: error.message,
    })}\n`
  );
  process.exit(1);
});
