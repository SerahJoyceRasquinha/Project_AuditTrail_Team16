import { COLLECTIONS } from '../../config/env.js';

/**
 * Worker checkpoint + dead-letter storage (roadmap 12.3 / 12.5).
 *
 * The checkpoint records the last global sequence the worker successfully
 * projected. On restart the worker resumes from there rather than reprocessing
 * the whole store - and because projection writes are idempotent, resuming
 * slightly early is harmless.
 *
 * Events that fail repeatedly are moved to a dead-letter collection with their
 * error context. They are never dropped and, crucially, the Event Store is
 * never touched: a projection failure is a read-side problem, and history stays
 * exactly as it was (roadmap 12.5).
 */
export class CheckpointRepository {
  #checkpoints;
  #deadLetters;

  constructor({ db }) {
    this.#checkpoints = db.collection(COLLECTIONS.checkpoints);
    this.#deadLetters = db.collection(COLLECTIONS.deadLetters);
  }

  async load(workerName) {
    const existing = await this.#checkpoints.findOne({ workerName }, { projection: { _id: 0 } });
    if (existing) return existing;

    const fresh = {
      workerName,
      lastSequence: 0,
      processedCount: 0,
      failureCount: 0,
      updatedAt: new Date().toISOString(),
      status: 'IDLE',
    };
    await this.#checkpoints.updateOne({ workerName }, { $set: fresh }, { upsert: true });
    return fresh;
  }

  async save(workerName, { lastSequence, processedCount = 0, status = 'RUNNING' }) {
    await this.#checkpoints.updateOne(
      { workerName },
      {
        $set: { lastSequence, status, updatedAt: new Date().toISOString() },
        $inc: { processedCount },
      },
      { upsert: true }
    );
  }

  async recordFailure(workerName) {
    await this.#checkpoints.updateOne(
      { workerName },
      { $inc: { failureCount: 1 }, $set: { updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
  }

  async setStatus(workerName, status) {
    await this.#checkpoints.updateOne(
      { workerName },
      { $set: { status, updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
  }

  async reset(workerName) {
    await this.#checkpoints.updateOne(
      { workerName },
      {
        $set: {
          lastSequence: 0,
          processedCount: 0,
          failureCount: 0,
          status: 'RESET',
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true }
    );
  }

  async deadLetter({ workerName, event, error, attempts }) {
    await this.#deadLetters.insertOne({
      workerName,
      eventId: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      version: event.version,
      sequence: event.sequence,
      attempts,
      error: { message: error.message, code: error.code ?? null },
      deadLetteredAt: new Date().toISOString(),
    });
  }

  async listDeadLetters({ limit = 50 } = {}) {
    return this.#deadLetters
      .find({}, { projection: { _id: 0 } })
      .sort({ deadLetteredAt: -1 })
      .limit(limit)
      .toArray();
  }

  async countDeadLetters() {
    return this.#deadLetters.countDocuments({});
  }
}
