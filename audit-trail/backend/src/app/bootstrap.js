import { loadConfig } from '../config/env.js';
import { connectDatabase } from '../config/database.js';
import { createLogger } from '../shared/logging/logger.js';
import { buildContainer } from './dependencies.js';
import { createApp } from './app.js';

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

  return {
    app,
    container,
    config,
    logger,
    db,
    client,
    persistence,
    shutdown: async () => {
      await container.projectionWorker.stop().catch(() => {});
      await close();
    },
  };
}
