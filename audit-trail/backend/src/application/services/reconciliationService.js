import { projectState } from '../../infrastructure/projections/shipmentProjection.js';
import { replay } from '../../domain/shipment/reducers/shipmentReducer.js';

/**
 * Read-model validation (roadmap 12.7).
 *
 * Answers one question: does the derived projection still agree with what the
 * events actually say? The Event Store is treated as authoritative throughout -
 * a disagreement is reported as a projection defect, never as an event defect.
 *
 * This also backs `rebuildReadModel.js`: because the read model is pure derived
 * data, the recovery procedure for any discrepancy is simply to delete it and
 * replay.
 */
export class ReconciliationService {
  #eventStore;
  #readModel;
  #logger;
  #workerName;

  constructor({ eventStore, readModelRepository, logger, config }) {
    this.#eventStore = eventStore;
    this.#readModel = readModelRepository;
    this.#logger = logger;
    this.#workerName = config?.worker?.name ?? 'reconciliation';
  }

  /** Compares one aggregate's projection against a fresh replay. */
  async reconcileOne(aggregateId) {
    const events = await this.#eventStore.getEvents(aggregateId);
    const projection = await this.#readModel.findById(aggregateId);

    if (events.length === 0) {
      return {
        aggregateId,
        /**
         * `eventCount` is reported so a caller can tell "consistent" from
         * "there is nothing here". The sweep below legitimately treats an
         * empty stream with no projection as consistent, but the HTTP handler
         * must not: an auditor who mistypes an identifier has to be told the
         * shipment does not exist, not shown a green tick for it.
         */
        eventCount: 0,
        consistent: projection === null,
        discrepancies: projection ? [{ field: '*', message: 'Projection exists for an empty event stream.' }] : [],
      };
    }

    const expected = projectState(replay(events), {
      lastSequence: events[events.length - 1].sequence ?? 0,
      workerName: this.#workerName,
    });

    if (!projection) {
      return {
        aggregateId,
        eventCount: events.length,
        consistent: false,
        discrepancies: [{ field: '*', message: 'No projection exists for a non-empty event stream.' }],
        expectedVersion: expected.currentVersion,
        actualVersion: null,
      };
    }

    // projectionMetadata is bookkeeping, not derived truth, so it is excluded
    // from the comparison.
    const comparableFields = Object.keys(expected).filter((field) => field !== 'projectionMetadata');
    const discrepancies = comparableFields
      .filter((field) => JSON.stringify(expected[field]) !== JSON.stringify(projection[field]))
      .map((field) => ({
        field,
        expected: expected[field] ?? null,
        actual: projection[field] ?? null,
      }));

    return {
      aggregateId,
      eventCount: events.length,
      consistent: discrepancies.length === 0,
      discrepancies,
      expectedVersion: expected.currentVersion,
      actualVersion: projection.currentVersion,
      lagVersions: Math.max(expected.currentVersion - projection.currentVersion, 0),
    };
  }

  /** Sweeps every aggregate in the store. */
  async reconcileAll() {
    const aggregateIds = await this.#eventStore.listAggregateIds();
    const results = [];
    for (const aggregateId of aggregateIds) {
      results.push(await this.reconcileOne(aggregateId));
    }

    const inconsistent = results.filter((result) => !result.consistent);
    if (inconsistent.length > 0) {
      this.#logger.warn('Read model discrepancies detected. The Event Store is authoritative.', {
        inconsistentCount: inconsistent.length,
        aggregateIds: inconsistent.map((result) => result.aggregateId),
      });
    }

    return {
      checked: results.length,
      consistent: results.length - inconsistent.length,
      inconsistent: inconsistent.length,
      results,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Destroys and rebuilds every projection from history.
   *
   * Safe by definition: nothing is lost, because nothing here is a source of
   * truth.
   */
  async rebuildAll() {
    const aggregateIds = await this.#eventStore.listAggregateIds();
    await this.#readModel.deleteAll();

    let rebuilt = 0;
    let latestSequence = 0;

    for (const aggregateId of aggregateIds) {
      const events = await this.#eventStore.getEvents(aggregateId);
      if (events.length === 0) continue;
      const lastSequence = events[events.length - 1].sequence ?? 0;
      latestSequence = Math.max(latestSequence, lastSequence);
      await this.#readModel.saveProjection(
        projectState(replay(events), { lastSequence, workerName: this.#workerName })
      );
      rebuilt += 1;
    }

    this.#logger.info('Read model rebuilt from the Event Store.', { rebuilt, latestSequence });
    return { rebuilt, latestSequence };
  }
}
