import { COLLECTIONS } from '../../config/env.js';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The Read Model repository (roadmap 12.2).
 *
 * Everything in this collection is **derived**. If it ever disagrees with the
 * Event Store, the Event Store wins and the projection is rebuilt - that is the
 * rule in roadmap 22 and "Mistake 7", and `rebuildReadModel.js` is the tool
 * that enforces it.
 *
 * Unlike the Event Store, this repository *does* expose update and delete.
 * That is not an inconsistency: deleting a projection destroys nothing, because
 * it can always be recomputed from the events.
 */
export class ShipmentReadModelRepository {
  #collection;
  #limits;

  constructor({ db, limits = { maxShipmentsPerPage: 100 } }) {
    this.#collection = db.collection(COLLECTIONS.readModel);
    this.#limits = limits;
  }

  async findById(aggregateId) {
    return this.#collection.findOne({ aggregateId }, { projection: { _id: 0 } });
  }

  async list({
    page = 1,
    pageSize = 20,
    state = null,
    search = null,
    origin = null,
    destination = null,
    hasBreach = null,
    minTemperature = null,
    maxTemperature = null,
    lastEventFrom = null,
    lastEventTo = null,
  } = {}) {
    const safePageSize = Math.min(Math.max(pageSize, 1), this.#limits.maxShipmentsPerPage);
    const safePage = Math.max(page, 1);

    const filter = {};
    if (state) filter.currentState = state;
    if (search) {
      const escaped = escapeRegex(search);
      filter.$or = [
        { aggregateId: { $regex: escaped, $options: 'i' } },
        { containerCode: { $regex: escaped, $options: 'i' } },
      ];
    }
    if (origin) filter.origin = { $regex: escapeRegex(origin), $options: 'i' };
    if (destination) filter.destination = { $regex: escapeRegex(destination), $options: 'i' };
    if (hasBreach === true) filter.temperatureBreachCount = { $gt: 0 };
    if (hasBreach === false) filter.temperatureBreachCount = { $eq: 0 };
    if (minTemperature !== null || maxTemperature !== null) {
      filter.latestTemperatureC = {};
      if (minTemperature !== null) filter.latestTemperatureC.$gte = minTemperature;
      if (maxTemperature !== null) filter.latestTemperatureC.$lte = maxTemperature;
    }
    if (lastEventFrom || lastEventTo) {
      filter.lastEventAt = {};
      if (lastEventFrom) filter.lastEventAt.$gte = lastEventFrom;
      if (lastEventTo) filter.lastEventAt.$lte = lastEventTo;
    }

    const [items, total] = await Promise.all([
      this.#collection
        .find(filter, { projection: { _id: 0 } })
        .sort({ lastEventAt: -1 })
        .skip((safePage - 1) * safePageSize)
        .limit(safePageSize)
        .toArray(),
      this.#collection.countDocuments(filter),
    ]);

    return {
      items,
      pagination: {
        page: safePage,
        pageSize: safePageSize,
        total,
        totalPages: Math.max(Math.ceil(total / safePageSize), 1),
      },
    };
  }

  /**
   * Upsert guarded by version.
   *
   * The `currentVersion: { $lt: version }` clause makes projection writes
   * idempotent at the database level: replaying an already-processed event
   * matches nothing and changes nothing. This is what makes worker retries and
   * at-least-once delivery safe (roadmap 12.4).
   */
  async saveProjection(projection) {
    const { aggregateId, currentVersion } = projection;

    const existing = await this.#collection.findOne({ aggregateId }, { projection: { currentVersion: 1 } });

    if (!existing) {
      await this.#collection.updateOne(
        { aggregateId },
        { $set: { ...projection }, $setOnInsert: { aggregateId } },
        { upsert: true }
      );
      return { applied: true, reason: 'inserted' };
    }

    if (existing.currentVersion >= currentVersion) {
      return { applied: false, reason: 'stale-or-duplicate', storedVersion: existing.currentVersion };
    }

    await this.#collection.updateOne(
      { aggregateId, currentVersion: { $lt: currentVersion } },
      { $set: { ...projection } }
    );
    return { applied: true, reason: 'updated' };
  }

  async deleteAll() {
    return this.#collection.deleteMany({});
  }

  async count() {
    return this.#collection.countDocuments({});
  }
}
