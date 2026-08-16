import { COLLECTIONS } from '../../config/env.js';
import {
  ConcurrencyConflictError,
  ImmutabilityViolationError,
  ValidationError,
} from '../../shared/errors/AppError.js';
import { computeEventHash, toEpoch } from '../../shared/utils/index.js';

/**
 * The Event Store (roadmap 7 / 10.2).
 *
 * The single most important property of this class is what it does **not**
 * expose. There is no `update`, no `delete`, no `replace`, no `save`. The only
 * write path in the entire application that touches the events collection is
 * `append()`, and `append()` only ever calls `insertOne`.
 *
 * Immutability is defended at four layers, which is what turns "append-only by
 * convention" into "append-only by construction" (roadmap 11.1):
 *
 *   1. **API surface** - the mutating methods do not exist. The `#forbidden`
 *      trap below exists so that if someone adds one out of habit, it throws.
 *   2. **Unique index** - `(aggregateId, version)` is unique, so history cannot
 *      be forked or overwritten even by a direct driver call.
 *   3. **Hash chain** - each event stores the SHA-256 of its own canonical body
 *      chained to its predecessor's hash. Editing any stored event breaks every
 *      subsequent link, and `verifyChain()` proves it.
 *   4. **Database permissions** - documented in docs/database/DATABASE.md: the
 *      application account is granted insert+find on this collection and
 *      explicitly not update/remove.
 */
export class EventStoreRepository {
  #collection;
  #counters;
  #logger;
  #limits;

  constructor({ db, logger, limits = { maxEventsPerQuery: 5000 } }) {
    this.#collection = db.collection(COLLECTIONS.events);
    this.#counters = db.collection(COLLECTIONS.counters);
    this.#logger = logger;
    this.#limits = limits;
  }

  // ---------------------------------------------------------------------------
  // Forbidden operations - present only so that misuse fails loudly.
  // ---------------------------------------------------------------------------
  #forbidden(operation) {
    this.#logger.error('Blocked an attempt to mutate the Event Store.', { operation });
    throw new ImmutabilityViolationError(operation);
  }

  updateEvent() {
    return this.#forbidden('updateEvent');
  }

  deleteEvent() {
    return this.#forbidden('deleteEvent');
  }

  replaceEvent() {
    return this.#forbidden('replaceEvent');
  }

  truncate() {
    return this.#forbidden('truncate');
  }

  // ---------------------------------------------------------------------------
  // The one and only write path.
  // ---------------------------------------------------------------------------

  /**
   * Appends a single event.
   *
   * OCC (roadmap 10.4 / 13.1) is enforced in two steps, and it is important
   * that both exist:
   *
   *   - an explicit pre-check against the stored version, which produces a
   *     clear 409 with both version numbers for the UI to explain; and
   *   - the unique index, which catches the genuine race that the pre-check
   *     cannot - two requests that both pass the check microseconds apart.
   *
   * The second is the real guarantee; the first exists to give a good error
   * message in the common case.
   */
  async append(event, { expectedVersion } = {}) {
    assertWellFormedEvent(event);

    const currentVersion = await this.getCurrentVersion(event.aggregateId);

    if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== currentVersion) {
      throw new ConcurrencyConflictError({
        aggregateId: event.aggregateId,
        expectedVersion,
        currentVersion,
      });
    }

    if (event.version !== currentVersion + 1) {
      throw new ConcurrencyConflictError({
        aggregateId: event.aggregateId,
        expectedVersion: event.version - 1,
        currentVersion,
      });
    }

    const previous = currentVersion === 0 ? null : await this.#collection.findOne(
      { aggregateId: event.aggregateId, version: currentVersion },
      { projection: { hash: 1 } }
    );

    const previousHash = previous?.hash ?? null;
    const hash = computeEventHash(event, previousHash);
    const sequence = await this.#nextSequence();

    const document = {
      ...event,
      previousHash,
      hash,
      sequence,
      recordedAt: new Date().toISOString(),
    };

    try {
      await this.#collection.insertOne(document);
    } catch (error) {
      // E11000 on uniq_aggregate_version means another writer won the race
      // between our pre-check and our insert. That is precisely the case OCC
      // exists for, so it is translated into the same 409 the client would
      // have got from the pre-check.
      if (error?.code === 11000) {
        const actual = await this.getCurrentVersion(event.aggregateId);
        throw new ConcurrencyConflictError({
          aggregateId: event.aggregateId,
          expectedVersion: event.version - 1,
          currentVersion: actual,
        });
      }
      throw error;
    }

    this.#logger.info('Event appended.', {
      eventId: document.eventId,
      aggregateId: document.aggregateId,
      eventType: document.eventType,
      version: document.version,
      sequence: document.sequence,
    });

    return document;
  }

  /**
   * A strictly increasing global sequence, used by the projection worker as its
   * checkpoint cursor. Timestamps are unsuitable for that job: two events can
   * share a millisecond, and clocks move backwards.
   */
  async #nextSequence() {
    const result = await this.#counters.findOneAndUpdate(
      { _id: 'event_sequence' },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    const value = result?.value?.value ?? result?.value ?? null;
    if (typeof value === 'number') return value;
    // Some driver versions return the document directly rather than in `.value`.
    const doc = await this.#counters.findOne({ _id: 'event_sequence' });
    return doc.value;
  }

  // ---------------------------------------------------------------------------
  // Read paths.
  // ---------------------------------------------------------------------------

  /** Full stream, ascending by version. */
  async getEvents(aggregateId, { limit } = {}) {
    return this.#collection
      .find({ aggregateId }, { projection: { _id: 0 } })
      .sort({ version: 1 })
      .limit(limit ?? this.#limits.maxEventsPerQuery)
      .toArray();
  }

  async getEventsAfterVersion(aggregateId, version) {
    return this.#collection
      .find({ aggregateId, version: { $gt: version } }, { projection: { _id: 0 } })
      .sort({ version: 1 })
      .limit(this.#limits.maxEventsPerQuery)
      .toArray();
  }

  /**
   * Events at or before an instant, for state scrubbing (roadmap 12.8).
   *
   * The boundary rule is **inclusive**: an event stamped exactly at `at` is
   * included. Roadmap 12.9 requires this to be decided and documented rather
   * than left to chance; it is also asserted by a test.
   */
  async getEventsUntil(aggregateId, isoTimestamp) {
    const events = await this.#collection
      .find({ aggregateId }, { projection: { _id: 0 } })
      .sort({ version: 1 })
      .limit(this.#limits.maxEventsPerQuery)
      .toArray();

    const boundary = toEpoch(isoTimestamp);
    return events.filter((event) => toEpoch(event.timestamp) <= boundary);
  }

  async getCurrentVersion(aggregateId) {
    const latest = await this.#collection.findOne(
      { aggregateId },
      { sort: { version: -1 }, projection: { version: 1 } }
    );
    return latest?.version ?? 0;
  }

  async exists(aggregateId) {
    return (await this.getCurrentVersion(aggregateId)) > 0;
  }

  /** Global stream slice, ascending by sequence - the worker's read path. */
  async getEventsAfterSequence(sequence, batchSize) {
    return this.#collection
      .find({ sequence: { $gt: sequence } }, { projection: { _id: 0 } })
      .sort({ sequence: 1 })
      .limit(batchSize)
      .toArray();
  }

  async getLatestSequence() {
    const latest = await this.#collection.findOne({}, { sort: { sequence: -1 }, projection: { sequence: 1 } });
    return latest?.sequence ?? 0;
  }

  /** Distinct aggregate ids - used by read-model rebuild and reconciliation. */
  async listAggregateIds() {
    return this.#collection.distinct('aggregateId', {});
  }

  async countEvents(aggregateId) {
    return this.#collection.countDocuments(aggregateId ? { aggregateId } : {});
  }

  /**
   * Verifies the hash chain of one stream.
   *
   * This is the honest, implemented version of the source document's phrase
   * "cryptographic proof of the event sequence". What it proves: no stored
   * event has been edited, and none has been removed from the middle, without
   * the tampering being detectable. What it does not prove: that an attacker
   * with write access could not rewrite the entire chain from the point of
   * tampering onwards. Doing that would additionally require signing or an
   * external anchor, and is written up as a documented enhancement rather than
   * claimed here.
   */
  async verifyChain(aggregateId) {
    const events = await this.getEvents(aggregateId);
    const issues = [];
    let previousHash = null;
    let expectedVersion = 1;

    for (const event of events) {
      if (event.version !== expectedVersion) {
        issues.push({
          type: 'VERSION_GAP',
          eventId: event.eventId,
          expectedVersion,
          actualVersion: event.version,
        });
        expectedVersion = event.version;
      }
      if ((event.previousHash ?? null) !== previousHash) {
        issues.push({
          type: 'BROKEN_LINK',
          eventId: event.eventId,
          version: event.version,
          message: 'previousHash does not match the hash of the preceding event.',
        });
      }
      const recomputed = computeEventHash(event, previousHash);
      if (recomputed !== event.hash) {
        issues.push({
          type: 'CONTENT_TAMPERED',
          eventId: event.eventId,
          version: event.version,
          message: 'The stored hash does not match a hash recomputed from the stored event body.',
        });
      }
      previousHash = event.hash;
      expectedVersion += 1;
    }

    return {
      aggregateId,
      eventCount: events.length,
      intact: issues.length === 0,
      issues,
      headHash: previousHash,
      verifiedAt: new Date().toISOString(),
    };
  }
}

function assertWellFormedEvent(event) {
  const required = ['aggregateId', 'eventType', 'payload', 'timestamp', 'version', 'eventId'];
  const missing = required.filter((field) => event?.[field] === undefined || event?.[field] === null);
  if (missing.length > 0) {
    throw new ValidationError(`Cannot append a malformed event; missing: ${missing.join(', ')}.`, {
      missing,
    });
  }
  if (!Number.isInteger(event.version) || event.version < 1) {
    throw new ValidationError('Cannot append an event with a non-integer or non-positive version.', {
      version: event.version,
    });
  }
  if (Number.isNaN(Date.parse(event.timestamp))) {
    throw new ValidationError('Cannot append an event with an unparseable timestamp.', {
      timestamp: event.timestamp,
    });
  }
}
