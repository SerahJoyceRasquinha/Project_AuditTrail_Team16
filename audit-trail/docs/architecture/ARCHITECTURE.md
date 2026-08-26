# Architecture

## The problem this solves

A CRUD system storing `{ shipmentId, location, temperature }` and updating it in
place answers exactly one question: where is the container **now**. When a
dispute arises — when did the temperature spike, was it before or after loading,
what did we know at 14:20 on Tuesday — that system has no answer, because the
answer was overwritten.

This system never overwrites. It stores the events that happened, in order, and
derives every answer from them.

```
CONTAINER_CREATED → LOADED_ON_SHIP → TEMPERATURE_SPIKE → ARRIVED_AT_PORT
```

Current state is not stored as truth. It is what you get when you fold that
sequence.

## The four pillars

| Pillar | Where it lives |
| --- | --- |
| MongoDB Event Store | `infrastructure/eventStore/eventStoreRepository.js` |
| Node.js event-sourcing engine | `domain/shipment/` + `application/services/` |
| CQRS | `interfaces/http/commandRoutes/` and `queryRoutes/` |
| React + Recharts forensic dashboard | `frontend/src/` |

## Request flow

### Write path

```
React LifecyclePlanner  ─────── the operator ticks "Load on Ship"
   │  POST /api/shipment/move { shipmentId, movementType, location, expectedVersion }
   │  (a checkbox dispatches a command; it never writes an event)
   ▼
Command router  ────────────── separate Express Router, no query handler in scope
   ▼
Command controller ─────────── protocol translation only
   ▼
Command handler ────────────── validates the raw input
   ▼
ShipmentCommandService
   │  1. load the full event stream
   │  2. fold it into current state       ← the reducer
   │  3. compare expectedVersion          ← OCC pre-check
   │  4. ask the aggregate to decide      ← returns ONE event, persists nothing
   ▼
EventStoreRepository.append()
   │  5. re-check version, compute hash, assign global sequence
   │  6. insertOne — the only write in the system
   ▼
MongoDB shipment_events        ← append-only, unique (aggregateId, version)
```

### Read path

```
MongoDB shipment_events
   ▼
ProjectionWorker (polling on `sequence`, checkpointed)
   ▼
shipmentProjection.projectState()   ← reuses the SAME reducer
   ▼
MongoDB shipment_read_model         ← derived, disposable
   ▼
Query router → query controller → query handler
   ▼
React dashboard
```

The two paths meet only at the Event Store. Nothing on the read side can append
an event; nothing on the write side reads the projection.

## Why the reducer is shared

`domain/shipment/reducers/shipmentReducer.js` exports one function,
`(state, event) → state`, and it has three callers:

1. the command service, rebuilding state to validate a command against;
2. the projection worker, building the read model incrementally;
3. the historical-state query, rebuilding state as at an arbitrary instant.

If each had its own copy of the transitions, all three could pass their own
tests while disagreeing with each other in production. Sharing it makes that
class of bug structurally impossible rather than merely unlikely.

## Layer dependencies

```
interfaces/http   →  application  →  domain
       │                  │
       └──────────────────┴──────→  infrastructure  →  MongoDB
```

`domain/` imports nothing from `infrastructure/` or `interfaces/`. It has no
database access, no HTTP, no clock beyond timestamps passed into it. That is why
the aggregate and reducer tests need no setup at all.

Dependencies flow in one direction and are wired in exactly one place:
`app/dependencies.js`. No module in `domain/` or `application/` imports a
database singleton.

## Immutability: four layers

The roadmap's pass condition for the mid-project audit is *demonstrable*
evidence that the store is append-only, not append-only by convention. So:

| Layer | Mechanism | Test |
| --- | --- | --- |
| API surface | No `update`/`delete`/`replace` methods exist. Guard stubs throw. | `tests/database/immutability.test.js` AUDIT 2–4 |
| Database index | `(aggregateId, version)` unique | `tests/database/eventStore.test.js` |
| Hash chain | Each event stores SHA-256 of its canonical body chained to its predecessor | AUDIT 5–9, 11 |
| DB permissions | Application account granted `insert` + `find`, not `update`/`remove` | `docs/database/DATABASE.md` |

### What the hash chain does and does not prove

The source document uses the phrase "cryptographic proof of the event sequence".
The roadmap is explicit that such a claim must not be made unless it is
implemented, so here is the precise scope:

**It proves.** No individual event has been edited, and no event has been removed
from the middle of a stream, without detection. Editing any field of any stored
event changes its hash and breaks every link after it.
`GET /api/shipment/:id/integrity` and `npm run verify:integrity` detect it.

**It does not prove.** An attacker with write access to the collection could
recompute the entire chain from the point of tampering onwards. Defending
against that requires either signing events with a key the database server does
not hold, or periodically anchoring the head hash somewhere outside the
database. Neither is implemented, so neither is claimed. Both are written up in
`docs/architecture/ENHANCEMENTS.md`.

## Optimistic Concurrency Control

Two checks, and both are needed:

1. **Pre-check** in `ShipmentCommandService`: compares `expectedVersion` against
   the folded state. Produces a clear 409 naming both versions.
2. **Unique index** in the Event Store: catches the genuine race that the
   pre-check cannot — two requests microseconds apart that both pass step 1.
   MongoDB returns `E11000`, which is translated into the same 409.

The second is the real guarantee. The first exists so the common case gets a good
error message. `tests/concurrency/` asserts that ten simultaneous commands at the
same version produce exactly one event and a gapless version sequence.

## Eventual consistency, handled honestly

A command returns `readModelConsistency: 'eventual'`. There is a real window
where the event exists and the projection does not know about it yet.

Rather than hiding this, `GET /api/shipment/:id` reports it:

- projection current → served from the read model, `projected: true`
- projection behind → **replayed from the Event Store**, `projected: false`,
  with `lagVersions`

The data is always correct; the response says where it came from. The dashboard
turns that into a visible "Synchronising" banner that resolves itself. The header
shows live projection lag at all times.

## Worker design

Polling with a checkpoint on a global `sequence` counter, rather than change
streams. Change streams require a replica set, which would make the project
impossible to run against a standalone `mongod` — a real constraint for anyone
marking or demoing it. Swapping the strategy would mean replacing one method,
`#fetchBatch`.

Three cases, all explicit:

```
incoming.version <= projected.version      → already applied, skip
incoming.version === projected.version + 1 → apply
incoming.version >  projected.version + 1  → gap: read the missing versions from
                                             the Event Store and fold them first
```

The gap branch is why the worker can be killed mid-batch, restarted, or pointed
at a store it has never seen, and still converge. Events that fail repeatedly go
to a dead-letter collection with their error context; the checkpoint advances
past them so one poison event cannot block the stream forever, and the Event
Store is never touched.

## Design decisions not specified by the source

| Question | Decision | Rationale |
| --- | --- | --- |
| Aggregate name | `Shipment` | The source uses "shipment" and "container" interchangeably; one name is used everywhere in code, API and docs. |
| Temperature threshold | Per shipment, from `CONTAINER_CREATED.payload` | The source names `TEMPERATURE_SPIKE` but defines no threshold. A global constant would be an invented business rule. |
| Effect of a spike | Records the breach; no lifecycle change | The source defines no consequence. Inventing quarantine or rejection would put unsourced rules into an audit trail. |
| Extra event types | `TEMPERATURE_RECORDED`, `UNLOADED_FROM_SHIP` | "Fluctuations" cannot be plotted from breaches alone. Both are marked `design-decision` in the catalog. |
| Scrub boundary | Inclusive — an event exactly at `at` is included | Roadmap 12.9 requires the rule to be decided and documented. Asserted by test. |
| Timezone | Store UTC, display local with the zone visible | A dispute about when a spike happened must not become an argument about timezones. |
| Authentication | Out of scope | Roadmap 26. `actor` is present on every event, null until auth exists. |
| Worker mechanism | Polling + checkpoint | See above. |
| DI | Manual composition root | The graph is small enough to read top to bottom. |
