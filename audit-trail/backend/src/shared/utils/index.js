import { createHash, randomUUID } from 'node:crypto';

/** UUID v4 - used for eventId, correlationId, causationId. */
export const newId = () => randomUUID();

/** Everything is stored in UTC (roadmap 12.9 timezone policy). */
export const nowIso = () => new Date().toISOString();

/**
 * Deterministic JSON: object keys sorted recursively.
 *
 * The event hash chain is only meaningful if two processes serialising the same
 * event produce byte-identical input, and `JSON.stringify` preserves insertion
 * order rather than sorting. Hence this.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Hash of a single event, chained to its predecessor.
 *
 * This is the *implemented* answer to the source document's phrase
 * "cryptographic proof of the event sequence". See docs/architecture for the
 * explicit statement of what this does and does not guarantee.
 */
export function computeEventHash(event, previousHash) {
  const body = {
    aggregateId: event.aggregateId,
    aggregateType: event.aggregateType,
    eventId: event.eventId,
    eventType: event.eventType,
    payload: event.payload,
    schemaVersion: event.schemaVersion,
    timestamp: event.timestamp,
    version: event.version,
  };
  return sha256(`${previousHash ?? 'GENESIS'}|${canonicalJson(body)}`);
}

/** ISO-8601 validity check that also rejects `new Date('garbage')`. */
export function isValidIsoTimestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export function toEpoch(value) {
  return Date.parse(value);
}

/** Structured-clone based deep freeze helper for immutable state objects. */
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.getOwnPropertyNames(obj).forEach((key) => deepFreeze(obj[key]));
  return Object.freeze(obj);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
