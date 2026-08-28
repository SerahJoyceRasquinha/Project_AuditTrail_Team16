import { COLLECTIONS } from '../../config/env.js';

/**
 * Account storage.
 *
 * Accounts live in their own collection, entirely separate from the Event
 * Store. That separation is a requirement rather than a preference: an account
 * is mutable by nature (a password can be changed, an account can be closed),
 * and the shipment event log is append-only by construction. Putting a mutable
 * record anywhere near that collection would mean either giving the events
 * collection an update path or pretending accounts are immutable. Keeping them
 * apart lets each be exactly what it is, and leaves every existing immutability
 * guarantee - the missing update/delete methods, the unique (aggregateId,
 * version) index, the hash chain, the database grants - untouched.
 *
 * Nothing in this class can write to `shipment_events`; it only ever addresses
 * the users collection.
 */
export class UserRepository {
  #collection;

  constructor({ db }) {
    this.#collection = db.collection(COLLECTIONS.users);
  }

  /**
   * Lookup by the canonical (lower-cased) username.
   *
   * Returns the stored record including the password hash, because the auth
   * service needs it to verify a login. Callers that send anything to a client
   * must go through `toPublicUser` rather than passing this object on.
   */
  async findByUsername(username) {
    if (!username) return null;
    return this.#collection.findOne({ username: String(username).toLowerCase() });
  }

  async exists(username) {
    return (await this.findByUsername(username)) !== null;
  }

  /**
   * Inserts a new account.
   *
   * Uniqueness is enforced by the unique index on `username`, not by the
   * `exists()` check above. The check exists to produce a good error message in
   * the ordinary case; the index is what actually prevents two simultaneous
   * registrations of the same name from both succeeding. This is the same
   * two-layer approach the Event Store takes with OCC, for the same reason.
   */
  async insert(user) {
    await this.#collection.insertOne(user);
    return user;
  }

  async count() {
    return this.#collection.countDocuments({});
  }
}

/**
 * The client-safe projection of an account.
 *
 * The password hash and salt never leave the backend, so they cannot appear in
 * an API response, in React state, or in a log line that happened to serialise
 * a user object. Everything the frontend legitimately needs - who am I, what
 * may I do - is here and nothing else is.
 */
export function toPublicUser(record) {
  if (!record) return null;
  return {
    username: record.username,
    displayName: record.displayName,
    role: record.role,
    createdAt: record.createdAt,
  };
}
