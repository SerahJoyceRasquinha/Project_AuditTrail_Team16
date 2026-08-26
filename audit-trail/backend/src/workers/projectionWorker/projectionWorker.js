import {
  applyEventToState,
  projectState,
  stateFromProjection,
} from '../../infrastructure/projections/shipmentProjection.js';
import { sleep } from '../../shared/utils/index.js';

/**
 * The background projection worker (roadmap 12.3 - 12.6).
 *
 * Strategy: polling with a checkpoint on the global `sequence`. Roadmap 26
 * offers change streams or polling; polling was chosen because change streams
 * require a replica set, which would make the project impossible to run on a
 * standalone `mongod` - a real constraint for anyone marking or demoing it. The
 * worker is written so that swapping in a change-stream source would only
 * replace `#fetchBatch`.
 *
 * The three hard cases from roadmap 12.4 are all handled explicitly:
 *
 *   incoming.version <= projection.version    -> already applied, skip (safe)
 *   incoming.version === projection.version+1 -> apply
 *   incoming.version >  projection.version+1  -> a gap. Do NOT apply out of
 *                                                order. Heal by reading the
 *                                                missing versions from the
 *                                                Event Store and applying them
 *                                                first.
 *
 * That last branch is why the worker can be killed mid-batch, restarted, or run
 * against a store it has never seen, and still converge.
 */
export class ProjectionWorker {
  #eventStore;
  #readModel;
  #checkpoints;
  #logger;
  #config;
  #eventBus;

  #running = false;
  #stopping = false;
  #loopPromise = null;

  #stats = {
    startedAt: null,
    batches: 0,
    eventsProcessed: 0,
    eventsSkipped: 0,
    gapsHealed: 0,
    failures: 0,
    deadLettered: 0,
    lastSequence: 0,
    lastError: null,
  };

  constructor({ eventStore, readModelRepository, checkpointRepository, logger, config, eventBus = null }) {
    this.#eventStore = eventStore;
    this.#readModel = readModelRepository;
    this.#checkpoints = checkpointRepository;
    this.#logger = logger.child({ component: 'projection-worker', worker: config.worker.name });
    this.#config = config;
    this.#eventBus = eventBus;
  }

  get isRunning() {
    return this.#running;
  }

  get stats() {
    return { ...this.#stats };
  }

  async start() {
    if (this.#running) return;
    const checkpoint = await this.#checkpoints.load(this.#config.worker.name);
    this.#stats.startedAt = new Date().toISOString();
    this.#stats.lastSequence = checkpoint.lastSequence;
    this.#running = true;
    this.#stopping = false;

    this.#logger.info('Projection worker started.', {
      resumingFromSequence: checkpoint.lastSequence,
      pollIntervalMs: this.#config.worker.pollIntervalMs,
    });

    this.#loopPromise = this.#loop();
  }

  async stop() {
    if (!this.#running) return;
    this.#stopping = true;
    await this.#loopPromise?.catch(() => {});
    this.#running = false;
    await this.#checkpoints.setStatus(this.#config.worker.name, 'STOPPED');
    this.#logger.info('Projection worker stopped.', this.stats);
  }

  async #loop() {
    while (!this.#stopping) {
      try {
        const processed = await this.runOnce();
        // Only idle when there was nothing to do; otherwise keep draining so a
        // burst of commands does not sit behind a fixed poll interval.
        if (processed === 0) await sleep(this.#config.worker.pollIntervalMs);
      } catch (error) {
        this.#stats.failures += 1;
        this.#stats.lastError = error.message;
        await this.#checkpoints.recordFailure(this.#config.worker.name);
        this.#logger.error('Projection loop iteration failed; will retry.', {
          reason: error.message,
        });
        await sleep(this.#config.worker.pollIntervalMs);
      }
    }
  }

  /**
   * Processes one batch. Exposed separately from the loop so tests can drive
   * the worker deterministically instead of racing a timer.
   *
   * @returns {Promise<number>} number of events consumed from the batch.
   */
  async runOnce() {
    const checkpoint = await this.#checkpoints.load(this.#config.worker.name);
    const events = await this.#eventStore.getEventsAfterSequence(
      checkpoint.lastSequence,
      this.#config.worker.batchSize
    );

    if (events.length === 0) return 0;

    this.#stats.batches += 1;
    let lastSequence = checkpoint.lastSequence;
    let processedCount = 0;

    for (const event of events) {
      const outcome = await this.#processWithRetry(event);
      if (outcome === 'processed') {
        this.#stats.eventsProcessed += 1;
        processedCount += 1;
        /**
         * Announced only after the projection has been written. Telling the UI
         * earlier would guarantee its refetch sometimes beat the read model and
         * showed stale data - which is exactly the confusing eventual-
         * consistency glitch this project surfaces honestly rather than hides.
         *
         * The notification carries no shipment data, only an identifier and a
         * version: it is a hint to re-query, never a second read path.
         */
        this.#eventBus?.publish({
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          version: event.version,
          sequence: event.sequence,
          occurredAt: event.timestamp,
        });
      } else if (outcome === 'skipped') {
        this.#stats.eventsSkipped += 1;
      }
      // The checkpoint advances even for a dead-lettered event, otherwise one
      // permanently poisonous event would block every later event forever. The
      // failure is not lost: it is in the dead-letter collection.
      lastSequence = event.sequence;
    }

    await this.#checkpoints.save(this.#config.worker.name, {
      lastSequence,
      processedCount,
      status: 'RUNNING',
    });
    this.#stats.lastSequence = lastSequence;

    return events.length;
  }

  async #processWithRetry(event) {
    const { maxRetries, retryBackoffMs } = this.#config.worker;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.#processEvent(event);
      } catch (error) {
        this.#stats.failures += 1;
        this.#logger.warn('Failed to project an event.', {
          eventId: event.eventId,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          version: event.version,
          attempt,
          maxRetries,
          reason: error.message,
        });

        if (attempt === maxRetries) {
          await this.#checkpoints.deadLetter({
            workerName: this.#config.worker.name,
            event,
            error,
            attempts: attempt,
          });
          this.#stats.deadLettered += 1;
          this.#logger.error('Event dead-lettered after exhausting retries. The Event Store is unchanged.', {
            eventId: event.eventId,
            aggregateId: event.aggregateId,
            version: event.version,
          });
          return 'dead-lettered';
        }

        await sleep(retryBackoffMs * attempt);
      }
    }

    return 'dead-lettered';
  }

  async #processEvent(event) {
    const existing = await this.#readModel.findById(event.aggregateId);
    const projectedVersion = existing?.currentVersion ?? 0;

    // Case 1 - already applied. At-least-once delivery makes this normal, not
    // exceptional, so it is logged at debug level.
    if (event.version <= projectedVersion) {
      this.#logger.debug('Skipping an already-projected event.', {
        eventId: event.eventId,
        aggregateId: event.aggregateId,
        version: event.version,
        projectedVersion,
      });
      return 'skipped';
    }

    // Case 3 - a gap. Applying this event now would produce a projection built
    // on state that never existed, so the missing versions are fetched and
    // folded first.
    if (event.version > projectedVersion + 1) {
      this.#logger.warn('Version gap detected; healing from the Event Store before applying.', {
        aggregateId: event.aggregateId,
        projectedVersion,
        incomingVersion: event.version,
      });
      this.#stats.gapsHealed += 1;
      await this.#healGap(event, projectedVersion, existing);
      return 'processed';
    }

    // Case 2 - the happy path.
    const state = applyEventToState(stateFromProjection(existing), event);
    const projection = projectState(state, {
      lastSequence: event.sequence,
      workerName: this.#config.worker.name,
    });
    const result = await this.#readModel.saveProjection(projection);

    if (!result.applied) {
      // Another worker instance won the race. Idempotency held; nothing to do.
      this.#logger.debug('Projection write was a no-op (concurrent worker already applied it).', {
        aggregateId: event.aggregateId,
        version: event.version,
        reason: result.reason,
      });
      return 'skipped';
    }

    return 'processed';
  }

  async #healGap(triggerEvent, projectedVersion, existingProjection) {
    const missing = await this.#eventStore.getEventsAfterVersion(
      triggerEvent.aggregateId,
      projectedVersion
    );

    let state = stateFromProjection(existingProjection);
    let lastSequence = existingProjection?.projectionMetadata?.lastProcessedSequence ?? 0;

    for (const event of missing) {
      if (event.version > triggerEvent.version) break;
      state = applyEventToState(state, event);
      lastSequence = event.sequence ?? lastSequence;
    }

    const projection = projectState(state, {
      lastSequence,
      workerName: this.#config.worker.name,
    });
    await this.#readModel.saveProjection(projection);

    this.#logger.info('Gap healed.', {
      aggregateId: triggerEvent.aggregateId,
      fromVersion: projectedVersion,
      toVersion: state.version,
      eventsApplied: missing.length,
    });
  }

  /**
   * Drains the backlog until the worker has caught up with the store.
   *
   * Used by tests and by the seed script so they can assert on a converged read
   * model rather than sleeping and hoping.
   */
  async catchUp({ maxIterations = 200 } = {}) {
    for (let i = 0; i < maxIterations; i += 1) {
      const processed = await this.runOnce();
      if (processed === 0) return true;
    }
    return false;
  }
}
