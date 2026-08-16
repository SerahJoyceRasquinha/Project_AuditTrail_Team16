import { newId } from '../../shared/utils/index.js';

/**
 * A small, faithful in-process implementation of the slice of the MongoDB
 * driver surface this application uses.
 *
 * Why this exists
 * ---------------
 * Event Sourcing correctness (append-only guarantees, version uniqueness, OCC
 * races, projection catch-up) has to be *tested*, and those tests should not
 * require a developer or a CI runner to have a MongoDB server. Every repository
 * in this codebase is written against a collection interface rather than
 * against `mongodb` directly, so the identical repository code runs on top of
 * either driver.
 *
 * What is faithfully reproduced
 * -----------------------------
 *  - unique index violations raise `E11000 duplicate key` with `code: 11000`,
 *    which is exactly what the OCC path catches;
 *  - documents are deep-cloned in and out, so callers cannot mutate stored
 *    state by holding a reference (a real driver serialises over the wire);
 *  - `findOneAndUpdate` with `$inc` is atomic with respect to the single-
 *    threaded event loop, which is what the global sequence counter needs.
 *
 * What is NOT reproduced: aggregation pipelines, transactions, change streams,
 * geospatial/text queries, and anything else the application does not use.
 * Production runs on the real driver (PERSISTENCE=mongo).
 */

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function getPath(doc, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

function setPath(doc, path, value) {
  const keys = path.split('.');
  let cursor = doc;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof cursor[keys[i]] !== 'object' || cursor[keys[i]] === null) cursor[keys[i]] = {};
    cursor = cursor[keys[i]];
  }
  cursor[keys[keys.length - 1]] = value;
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return a < b ? -1 : 1;
}

function matchesOperator(actual, operator, expected) {
  switch (operator) {
    case '$eq':
      return compare(actual, expected) === 0;
    case '$ne':
      return compare(actual, expected) !== 0;
    case '$gt':
      return compare(actual, expected) > 0;
    case '$gte':
      return compare(actual, expected) >= 0;
    case '$lt':
      return compare(actual, expected) < 0;
    case '$lte':
      return compare(actual, expected) <= 0;
    case '$in':
      return expected.some((candidate) => compare(actual, candidate) === 0);
    case '$nin':
      return !expected.some((candidate) => compare(actual, candidate) === 0);
    case '$exists':
      return (actual !== undefined) === Boolean(expected);
    case '$regex': {
      const regex =
        expected instanceof RegExp ? expected : new RegExp(expected, operator.options ?? undefined);
      return typeof actual === 'string' && regex.test(actual);
    }
    // Consumed by the $regex branch above; present as a sibling key in the
    // same condition object, exactly as the real driver expects it.
    case '$options':
      return true;
    default:
      throw new Error(`inMemoryDb: unsupported query operator '${operator}'.`);
  }
}

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return condition.some((sub) => matches(doc, sub));
    if (key === '$and') return condition.every((sub) => matches(doc, sub));
    if (key === '$nor') return !condition.some((sub) => matches(doc, sub));

    const actual = getPath(doc, key);
    if (condition instanceof RegExp) return typeof actual === 'string' && condition.test(actual);
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      const operators = Object.keys(condition);
      if (operators.length > 0 && operators.every((op) => op.startsWith('$'))) {
        return operators.every((op) => {
          if (op === '$regex' && condition.$options !== undefined) {
            const regex = new RegExp(condition.$regex, condition.$options);
            return typeof actual === 'string' && regex.test(actual);
          }
          return matchesOperator(actual, op, condition[op]);
        });
      }
    }
    return compare(actual, condition) === 0;
  });
}

function applyUpdate(doc, update) {
  for (const [operator, fields] of Object.entries(update)) {
    switch (operator) {
      case '$set':
        for (const [path, value] of Object.entries(fields)) setPath(doc, path, clone(value));
        break;
      case '$setOnInsert':
        break; // handled by the caller, only on insert
      case '$inc':
        for (const [path, value] of Object.entries(fields)) {
          setPath(doc, path, (getPath(doc, path) ?? 0) + value);
        }
        break;
      case '$max':
        for (const [path, value] of Object.entries(fields)) {
          const current = getPath(doc, path);
          if (current === undefined || compare(value, current) > 0) setPath(doc, path, clone(value));
        }
        break;
      case '$unset':
        for (const path of Object.keys(fields)) setPath(doc, path, undefined);
        break;
      case '$push':
        for (const [path, value] of Object.entries(fields)) {
          const current = getPath(doc, path);
          setPath(doc, path, Array.isArray(current) ? [...current, clone(value)] : [clone(value)]);
        }
        break;
      default:
        throw new Error(`inMemoryDb: unsupported update operator '${operator}'.`);
    }
  }
  return doc;
}

function duplicateKeyError(collectionName, indexName, keyValue) {
  const error = new Error(
    `E11000 duplicate key error collection: ${collectionName} index: ${indexName} dup key: ${JSON.stringify(keyValue)}`
  );
  error.code = 11000;
  error.keyValue = keyValue;
  error.index = indexName;
  return error;
}

class InMemoryCursor {
  #docs;

  constructor(docs) {
    this.#docs = docs;
  }

  sort(spec) {
    const entries = Object.entries(spec);
    this.#docs = [...this.#docs].sort((a, b) => {
      for (const [field, direction] of entries) {
        const result = compare(getPath(a, field), getPath(b, field));
        if (result !== 0) return direction >= 0 ? result : -result;
      }
      return 0;
    });
    return this;
  }

  skip(count) {
    this.#docs = this.#docs.slice(count);
    return this;
  }

  limit(count) {
    this.#docs = this.#docs.slice(0, count);
    return this;
  }

  project(projection) {
    if (!projection) return this;
    const excluded = Object.entries(projection)
      .filter(([, include]) => include === 0)
      .map(([field]) => field);
    if (excluded.length > 0) {
      this.#docs = this.#docs.map((doc) => {
        const copy = { ...doc };
        excluded.forEach((field) => delete copy[field]);
        return copy;
      });
    }
    return this;
  }

  async toArray() {
    return this.#docs.map(clone);
  }

  async *[Symbol.asyncIterator]() {
    for (const doc of this.#docs) yield clone(doc);
  }
}

class InMemoryCollection {
  constructor(name) {
    this.collectionName = name;
    this.documents = [];
    this.indexes = [];
  }

  async createIndex(spec, options = {}) {
    const fields = Object.keys(spec);
    const name = options.name ?? fields.map((f) => `${f}_${spec[f]}`).join('_');
    if (!this.indexes.some((index) => index.name === name)) {
      this.indexes.push({ name, fields, unique: Boolean(options.unique), spec, options });
    }
    return name;
  }

  async indexes_() {
    return this.indexes.map(({ name, spec, unique }) => ({ name, key: spec, unique }));
  }

  async listIndexes() {
    const list = await this.indexes_();
    return { toArray: async () => list };
  }

  #assertUnique(doc) {
    for (const index of this.indexes.filter((i) => i.unique)) {
      const keyValue = Object.fromEntries(index.fields.map((field) => [field, getPath(doc, field)]));
      const clash = this.documents.some((existing) =>
        index.fields.every((field) => compare(getPath(existing, field), getPath(doc, field)) === 0)
      );
      if (clash) throw duplicateKeyError(this.collectionName, index.name, keyValue);
    }
  }

  async insertOne(doc) {
    const stored = clone(doc);
    if (stored._id === undefined) stored._id = newId();
    this.#assertUnique(stored);
    this.documents.push(stored);
    return { acknowledged: true, insertedId: stored._id };
  }

  async insertMany(docs) {
    const insertedIds = {};
    for (const [index, doc] of docs.entries()) {
      const result = await this.insertOne(doc);
      insertedIds[index] = result.insertedId;
    }
    return { acknowledged: true, insertedCount: docs.length, insertedIds };
  }

  find(filter = {}, options = {}) {
    const cursor = new InMemoryCursor(this.documents.filter((doc) => matches(doc, filter)));
    if (options.sort) cursor.sort(options.sort);
    if (options.skip) cursor.skip(options.skip);
    if (options.limit) cursor.limit(options.limit);
    if (options.projection) cursor.project(options.projection);
    return cursor;
  }

  async findOne(filter = {}, options = {}) {
    const results = await this.find(filter, { ...options, limit: options.sort ? undefined : 1 }).toArray();
    return results[0] ?? null;
  }

  async countDocuments(filter = {}) {
    return this.documents.filter((doc) => matches(doc, filter)).length;
  }

  async estimatedDocumentCount() {
    return this.documents.length;
  }

  async distinct(field, filter = {}) {
    const values = new Set();
    this.documents.filter((doc) => matches(doc, filter)).forEach((doc) => values.add(getPath(doc, field)));
    return [...values];
  }

  async updateOne(filter, update, options = {}) {
    const target = this.documents.find((doc) => matches(doc, filter));
    if (!target) {
      if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
      const seed = { _id: newId() };
      for (const [key, value] of Object.entries(filter)) {
        if (!key.startsWith('$') && (typeof value !== 'object' || value === null)) setPath(seed, key, value);
      }
      if (update.$setOnInsert) {
        for (const [path, value] of Object.entries(update.$setOnInsert)) setPath(seed, path, clone(value));
      }
      applyUpdate(seed, update);
      this.#assertUnique(seed);
      this.documents.push(seed);
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: seed._id };
    }
    applyUpdate(target, update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const before = this.documents.find((doc) => matches(doc, filter));
    await this.updateOne(filter, update, options);
    const after = this.documents.find((doc) => matches(doc, filter)) ?? null;
    const chosen = options.returnDocument === 'before' ? before : after;
    const value = clone(chosen) ?? null;
    return { value, ...value };
  }

  async replaceOne(filter, replacement, options = {}) {
    const index = this.documents.findIndex((doc) => matches(doc, filter));
    if (index === -1) {
      if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      return this.insertOne(replacement);
    }
    const stored = clone(replacement);
    stored._id = this.documents[index]._id;
    this.documents[index] = stored;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((doc) => matches(doc, filter));
    if (index === -1) return { acknowledged: true, deletedCount: 0 };
    this.documents.splice(index, 1);
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(filter = {}) {
    const remaining = this.documents.filter((doc) => !matches(doc, filter));
    const deletedCount = this.documents.length - remaining.length;
    this.documents = remaining;
    return { acknowledged: true, deletedCount };
  }

  async drop() {
    this.documents = [];
    this.indexes = [];
    return true;
  }
}

class InMemoryDatabase {
  constructor(name) {
    this.databaseName = name;
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new InMemoryCollection(name));
    return this.collections.get(name);
  }

  async listCollections() {
    const list = [...this.collections.keys()].map((name) => ({ name }));
    return { toArray: async () => list };
  }

  async command(cmd) {
    if (cmd?.ping) return { ok: 1 };
    throw new Error(`inMemoryDb: unsupported database command ${JSON.stringify(cmd)}`);
  }

  async dropDatabase() {
    this.collections.clear();
    return true;
  }
}

/**
 * @returns {{ db: InMemoryDatabase, client: { close(): Promise<void>, db(): InMemoryDatabase } }}
 */
export function createInMemoryDatabase(databaseName = 'audit_trail_memory') {
  const db = new InMemoryDatabase(databaseName);
  const client = {
    db: () => db,
    close: async () => {},
    topology: { isConnected: () => true },
  };
  return { db, client };
}
