import { COLLECTIONS } from '../../config/env.js';
import { InfrastructureError } from '../../shared/errors/AppError.js';

/**
 * Allocates human-readable shipment identifiers: SHP-1, SHP-2, SHP-3, ...
 *
 * Why not `max(id) + 1`
 * ---------------------
 * The obvious implementation - find the highest existing number and add one -
 * is a race condition with a friendly face. Two requests arriving in the same
 * millisecond both read the same maximum, both compute the same successor, and
 * both try to create SHP-8. In an append-only ledger that is worse than a
 * duplicate row: one of them either fails after the user thought it succeeded,
 * or two unrelated shipments end up sharing a stream. The requirement calls
 * this out specifically, and it is correct to.
 *
 * What this does instead is the same trick the Event Store already uses for its
 * global sequence: a single counter document incremented with an atomic
 * `findOneAndUpdate` + `$inc`. MongoDB serialises those against one another, so
 * every caller receives a number nobody else received. No locking, no retry
 * loop in the common case, and correct under any amount of concurrency.
 *
 * Format
 * ------
 * `SHP-1`, not `SHP-001`. Zero padding is a display choice masquerading as an
 * identifier: it caps the range implicitly, and it makes SHP-010 and SHP-10
 * look like different things while sorting them as though they were.
 */
export class ShipmentIdAllocator {
  #counters;
  #eventStore;
  #logger;
  #prefix;
  #counterId = 'shipment_id_sequence';

  constructor({ db, eventStore, logger, prefix = 'SHP-' }) {
    this.#counters = db.collection(COLLECTIONS.counters);
    this.#eventStore = eventStore;
    this.#logger = logger;
    this.#prefix = prefix;
  }

  format(sequence) {
    return `${this.#prefix}${sequence}`;
  }

  /** Parses `SHP-12` back to `12`; returns null for anything else. */
  parse(shipmentId) {
    if (typeof shipmentId !== 'string' || !shipmentId.startsWith(this.#prefix)) return null;
    const suffix = shipmentId.slice(this.#prefix.length);
    if (!/^[1-9]\d*$/.test(suffix)) return null;
    return Number.parseInt(suffix, 10);
  }

  async #increment() {
    const result = await this.#counters.findOneAndUpdate(
      { _id: this.#counterId },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    const value = result?.value?.value ?? result?.value ?? null;
    if (typeof value === 'number') return value;
    // Some driver versions return the document directly rather than under
    // `.value`; the Event Store's sequence counter handles this the same way.
    const doc = await this.#counters.findOne({ _id: this.#counterId });
    return doc.value;
  }

  /**
   * Returns the next unused identifier.
   *
   * The counter alone is enough to guarantee uniqueness *among allocated ids*.
   * The existence check exists for a different case: a stream created with an
   * explicitly supplied id - a backfill, an import, a seeded demo - can occupy
   * a number the counter has not reached yet. Rather than let the counter
   * eventually collide with it, the allocator skips over anything already
   * taken and carries on.
   *
   * Even if that check were somehow raced, nothing corrupts: the unique index
   * on `(aggregateId, version)` refuses the second CONTAINER_CREATED and the
   * caller receives a concurrency conflict. This is the polite layer above a
   * guarantee that already exists.
   */
  async allocate({ maxAttempts = 25 } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const sequence = await this.#increment();
      const candidate = this.format(sequence);

      if (!(await this.#eventStore.exists(candidate))) {
        return { shipmentId: candidate, sequence };
      }

      this.#logger?.warn('Allocated shipment id was already in use; skipping it.', {
        shipmentId: candidate,
        attempt: attempt + 1,
      });
    }

    throw new InfrastructureError(
      'Could not allocate a free shipment identifier. The identifier counter appears to be far behind the existing streams; run the reseed tooling to advance it.'
    );
  }

  /**
   * Advances the counter past the highest existing `SHP-N` stream.
   *
   * Called once at startup so that a database restored from a dump - or seeded
   * with explicit ids - does not make the allocator walk through hundreds of
   * taken numbers on its first request. Purely an optimisation: correctness
   * does not depend on it.
   */
  async syncToExistingStreams() {
    const ids = await this.#eventStore.listAggregateIds();
    const highest = ids.reduce((max, id) => Math.max(max, this.parse(id) ?? 0), 0);
    if (highest === 0) return { advancedTo: null };

    const current = await this.#counters.findOne({ _id: this.#counterId });
    if ((current?.value ?? 0) >= highest) return { advancedTo: current?.value ?? 0 };

    await this.#counters.updateOne(
      { _id: this.#counterId },
      { $max: { value: highest } },
      { upsert: true }
    );
    this.#logger?.info('Shipment id counter advanced past existing streams.', { advancedTo: highest });
    return { advancedTo: highest };
  }
}
