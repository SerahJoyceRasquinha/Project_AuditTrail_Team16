import { loadConfig } from '../config/env.js';
import { connectDatabase } from '../config/database.js';
import { createLogger } from '../shared/logging/logger.js';
import { buildContainer } from './dependencies.js';
import { createApp } from './app.js';
import { seedDemoAccounts } from '../application/services/demoAccounts.js';

/**
 * One bootstrap used by the API server, the standalone worker, the seed script
 * and the tests. Having a single path means the tests exercise the same wiring
 * production uses, rather than a parallel arrangement that can quietly diverge.
 */
export async function bootstrap({ configOverrides = {}, logger: providedLogger } = {}) {
  const config = loadConfig(configOverrides);
  const logger = providedLogger ?? createLogger({ level: config.logLevel });

  const { db, client, close, persistence } = await connectDatabase({ config, logger });
  const container = buildContainer({ db, config, logger });
  const app = createApp({ container });

  /**
   * Advance the identifier counter past any streams that already exist.
   *
   * Only an optimisation - the allocator skips taken ids anyway - but without
   * it a database restored from a dump would make the first few creations walk
   * through every number the dump already used.
   */
  await container.shipmentIdAllocator.syncToExistingStreams().catch((error) => {
    logger.warn('Could not synchronise the shipment id counter at startup.', {
      reason: error.message,
    });
  });

  /**
   * Demo accounts, only when explicitly asked for. See demoAccounts.js - they
   * are created through the ordinary registration path, and a failure here is
   * never allowed to stop the server booting.
   */
  if (config.auth.enabled && config.auth.seedDemoAccounts) {
    await seedDemoAccounts({
      authService: container.authService,
      userRepository: container.userRepository,
      logger,
    }).catch((error) => {
      logger.warn('Could not seed the demo accounts.', { reason: error.message });
    });
  }

  return {
    app,
    container,
    config,
    logger,
    db,
    client,
    persistence,
    shutdown: async () => {
      await container.temperatureMonitor.stop().catch(() => {});
      await container.projectionWorker.stop().catch(() => {});
      await close();
    },
  };
}
