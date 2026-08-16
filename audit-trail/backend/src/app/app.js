import express from 'express';
import cors from 'cors';
import { registerRoutes } from './routes.js';
import { errorHandler, notFoundHandler, requestLogger } from '../interfaces/http/middleware/index.js';

/**
 * Builds the Express application from an already-constructed container.
 *
 * The app is a pure function of its dependencies: it never connects to a
 * database, never starts a worker, never reads `process.env`. That is what lets
 * the API tests spin up a full HTTP server against in-memory persistence in a
 * couple of lines.
 */
export function createApp({ container }) {
  const { config, logger } = container;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((value) => value.trim()),
      exposedHeaders: ['x-correlation-id', 'x-cqrs-side'],
    })
  );

  // Commands are small. A tight body limit is the cheapest possible defence
  // against a trivially malicious payload.
  app.use(express.json({ limit: '256kb' }));
  app.use(requestLogger(logger));

  registerRoutes({ app, container });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
