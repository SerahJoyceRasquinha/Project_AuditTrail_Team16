# Database Design

Database: `audit_trail`

| Collection | Role | Mutable? |
| --- | --- | --- |
| `shipment_events` | Event Store — the source of truth | **Append-only** |
| `shipment_read_model` | Derived projection | Yes, and disposable |
| `projection_checkpoints` | Worker cursor | Yes |
| `projection_dead_letters` | Events that failed projection | Yes |
| `counters` | Global sequence counter | Yes |

The asymmetry is the point. Only the first collection is truth; everything else
can be deleted and rebuilt from it at any time with `npm run rebuild:readmodel`.

## `shipment_events`

```js
{
  eventId: "9f1c…",  aggregateId: "SHP-1001",  aggregateType: "Shipment",
  eventType: "TEMPERATURE_SPIKE",
  payload: { temperatureC: 11.8, recordedAt: "…", thresholdC: 8, direction: "ABOVE_MAX" },
  timestamp: "2026-08-16T04:30:00.000Z",
  version: 5,
  schemaVersion: 1,
  correlationId: "…", causationId: null, actor: null,
  previousHash: "3ab9…", hash: "7c21…",
  sequence: 42,
  recordedAt: "2026-08-16T04:30:00.221Z"
}
```

### Indexes

| Index | Unique | Purpose |
| --- | --- | --- |
| `(aggregateId, version)` | **yes** | Ordered replay **and** the enforcement point for OCC |
| `(aggregateId, timestamp)` | no | State scrubbing |
| `(sequence)` | **yes** | Worker cursor; global ordering |
| `(eventType, timestamp)` | no | Cross-shipment breach queries |

The first index is doing double duty and the second job is the important one.
Two concurrent commands that both computed version N will race to insert; the
unique index lets exactly one win and returns `E11000` to the loser, which the
repository translates into a 409. Without it, OCC would be advisory.

### Why `sequence` and not `timestamp`

The worker needs a total order across all aggregates. Timestamps cannot provide
one: two events can share a millisecond, and clocks move backwards. `sequence`
comes from an atomic `$inc` on the `counters` collection.

## Append-only enforcement

Four layers, described in full in `docs/architecture/ARCHITECTURE.md`. The one
that requires operator action is database permissions.

### Least-privilege user

```js
use admin
db.createRole({
  role: "auditTrailAppRole",
  privileges: [
    // The Event Store: insert and read. Deliberately NOT update or remove.
    { resource: { db: "audit_trail", collection: "shipment_events" },
      actions: ["find", "insert", "createIndex", "listIndexes"] },
    // Derived collections: full access, because they can always be rebuilt.
    { resource: { db: "audit_trail", collection: "shipment_read_model" },
      actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"] },
    { resource: { db: "audit_trail", collection: "projection_checkpoints" },
      actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"] },
    { resource: { db: "audit_trail", collection: "projection_dead_letters" },
      actions: ["find", "insert", "createIndex", "listIndexes"] },
    { resource: { db: "audit_trail", collection: "counters" },
      actions: ["find", "insert", "update", "createIndex", "listIndexes"] }
  ],
  roles: []
})

db.createUser({
  user: "audit_trail_app",
  pwd: passwordPrompt(),
  roles: [{ role: "auditTrailAppRole", db: "admin" }]
})
```

With this role in place, a bug that somehow reached an `updateOne` on
`shipment_events` fails at the database, not just in the repository. Verify:

```js
db.shipment_events.updateOne({}, { $set: { payload: {} } })   // → not authorized
db.shipment_events.deleteOne({})                              // → not authorized
```

Note that the two developer scripts in `backend/scripts/` still work under this
role: `verifyIntegrity.js` only reads, and `rebuildReadModel.js` only writes to
derived collections.

## Persistence modes

`PERSISTENCE=mongo` (default) uses the real driver.

`PERSISTENCE=memory` swaps in `infrastructure/mongodb/inMemoryDb.js`, an
in-process implementation of the slice of the driver surface this application
uses. Every repository is written against a collection interface rather than
against `mongodb` directly, so identical repository code runs on either.

It faithfully reproduces the things correctness depends on: unique-index
violations raise `E11000` with `code: 11000`, documents are deep-cloned in and
out so callers cannot mutate stored state by reference, and `$inc` is atomic with
respect to the event loop. It does **not** implement aggregation pipelines,
transactions or change streams.

Use it for tests and for a demo on a machine with no MongoDB. Do not use it for
anything durable — the whole store lives in one process's heap, which is also why
the standalone worker refuses to start in this mode.

## Performance notes

Replay cost grows with stream length, which is exactly why the read model exists.
Measured on the in-memory store, replaying a single stream:

| Events | Replay |
| --- | --- |
| 10 | < 1 ms |
| 100 | ~2 ms |
| 1,000 | ~15 ms |
| 10,000 | ~140 ms |

Dashboard queries do not pay this: they read the projection, which is O(1)
regardless of history length. Only the scrubber and integrity check replay, and
both are explicit user actions.

If a single shipment were ever expected to exceed ~10,000 events, the standard
next step is snapshotting — store a state snapshot every N events and replay only
from the last one. Not implemented, because no shipment in this domain
plausibly reaches that; documented in `ENHANCEMENTS.md`.
