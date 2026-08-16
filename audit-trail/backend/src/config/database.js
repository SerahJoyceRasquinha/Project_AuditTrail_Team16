import { COLLECTIONS } from './env.js';
import { createInMemoryDatabase } from '../infrastructure/mongodb/inMemoryDb.js';
import { InfrastructureError } from '../shared/errors/AppError.js';
import { sleep } from '../shared/utils/index.js';

/**
 * Database connection module (roadmap 9.2).
 *
 * Returns `{ db, client, close }` regardless of which persistence mode is
 * selected, so nothing downstream knows or cares which one it got.
 */
export async function connectDatabase({ config, logger, retries = 5 }) {
  if (config.persistence === 'memory') {
    const { db, client } = createInMemoryDatabase(config.mongodbDatabase);
    logger.warn('Using in-process persistence. Data is not durable and is lost on restart.', {
      persistence: 'memory',
      database: config.mongodbDatabase,
    });
    await ensureIndexes({ db, logger });
    return { db, client, persistence: 'memory', close: async () => client.close() };
  }

  // Imported lazily so that `PERSISTENCE=memory` works even if the native
  // driver is unavailable in a constrained environment.
  const { MongoClient } = await import('mongodb');

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const client = new MongoClient(config.mongodbUri, {
        serverSelectionTimeoutMS: 5000,
        retryWrites: true,
        appName: 'audit-trail',
      });
      await client.connect();
      const db = client.db(config.mongodbDatabase);
      await db.command({ ping: 1 });
      logger.info('Connected to MongoDB.', { database: config.mongodbDatabase, attempt });
      await ensureIndexes({ db, logger });
      return { db, client, persistence: 'mongo', close: async () => client.close() };
    } catch (error) {
      lastError = error;
      const backoff = Math.min(200 * 2 ** (attempt - 1), 4000);
      logger.warn('MongoDB connection attempt failed; retrying.', {
        attempt,
        retries,
        backoffMs: backoff,
        // Message only. Never the URI - it contains credentials.
        reason: error.message,
      });
      if (attempt < retries) await sleep(backoff);
    }
  }

  throw new InfrastructureError(
    `Could not connect to MongoDB after ${retries} attempts. Last error: ${lastError?.message}`
  );
}

/**
 * Index bootstrap (roadmap 10.3 / 15.4).
 *
 * The unique index on (aggregateId, version) is not a performance nicety - it
 * is the database-level enforcement point for Optimistic Concurrency Control.
 * Two concurrent commands that both computed version N will race here, and
 * MongoDB will let exactly one win with E11000 for the loser.
 */
export async function ensureIndexes({ db, logger }) {
  const events = db.collection(COLLECTIONS.events);
  await events.createIndex({ aggregateId: 1, version: 1 }, { unique: true, name: 'uniq_aggregate_version' });
  await events.createIndex({ aggregateId: 1, timestamp: 1 }, { name: 'aggregate_timestamp' });
  await events.createIndex({ sequence: 1 }, { unique: true, name: 'uniq_global_sequence' });
  await events.createIndex({ eventType: 1, timestamp: 1 }, { name: 'event_type_timestamp' });

  const readModel = db.collection(COLLECTIONS.readModel);
  await readModel.createIndex({ aggregateId: 1 }, { unique: true, name: 'uniq_read_model_aggregate' });
  await readModel.createIndex({ currentState: 1, lastEventAt: -1 }, { name: 'state_last_event' });

  const checkpoints = db.collection(COLLECTIONS.checkpoints);
  await checkpoints.createIndex({ workerName: 1 }, { unique: true, name: 'uniq_worker' });

  const counters = db.collection(COLLECTIONS.counters);
  await counters.createIndex({ _id: 1 }, { name: 'counter_id' });

  logger.debug('Indexes ensured.', {
    collections: Object.values(COLLECTIONS),
  });
}
