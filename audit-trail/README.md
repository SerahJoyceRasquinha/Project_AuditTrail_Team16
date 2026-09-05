# Audit Trail — Event-Sourced Inventory & Logistics Ledger

A logistics ledger that never overwrites anything.

In a conventional CRUD system, updating a container's location or temperature
destroys the previous value. That system can answer *where is this container
now*, and nothing else. When a dispute arises — when exactly did the temperature
spike, was it before or after loading, what did we know at 14:20 on Tuesday —
the answer has already been overwritten.

This system stores the events that happened, in order, and derives every answer
from them:

```
CONTAINER_CREATED → LOADED_ON_SHIP → TEMPERATURE_SPIKE → ARRIVED_AT_PORT
```

Current state is not stored as truth. It is what you get when you fold that
sequence. History is append-only, hash-chained, and can be replayed to any
instant.

**Stack:** Node.js · Express · MongoDB · CQRS · Event Sourcing · React · Recharts

---

## Quick start

### Option A — no database required

Useful for a demo or a first look on a machine without MongoDB.

```bash
# Terminal 1
cd backend
npm install
PERSISTENCE=memory npm start

# Terminal 2
cd frontend
npm install
npm run dev
```

The ledger starts empty. With the backend running, load the demonstration data
in a third terminal:

```bash
cd backend
npm run seed:http
```

Open **http://localhost:5173** and search for `SHP-1001`. Data lives in the API
process's memory and is lost on restart.

### Option B — with MongoDB (the real thing)

```bash
cd backend
npm install
cp .env.example .env          # defaults point at mongodb://127.0.0.1:27017
npm run seed                  # loads four demonstration shipments
npm start

cd ../frontend
npm install
npm run dev
```

Requires Node.js 20.11+ and a running MongoDB 6+ (standalone is fine — no replica
set needed).

### Running the worker as its own process

The default runs the projection worker inside the API process so one terminal is
enough. To demonstrate CQRS properly, with write side, read side and projection
pipeline as three separate processes:

```bash
# .env
WORKER_IN_PROCESS=false

npm start           # terminal 1 — API
npm run start:worker  # terminal 2 — projection worker
```

---

## Working with a shipment

The dashboard's shipment screen is organised around the job rather than the
storage layer:

1. **Create Shipment** — the reference (`SHP-1`, `SHP-2`, …) and the creation
   timestamp are both assigned by the server. Origin and destination cascade
   through country → state → city dropdowns, each gated on the one above it
   (with manual entry available for ports the curated list does not cover); the
   container code upper-cases as you type. An estimated duration in whole days is required, because it fixes the
   window every later date is checked against.

2. **Shipment Schedule** — plan tentative dates for *Load on Ship → Arrive at
   Port → Unload from Ship*. The calendar only offers dates the backend would
   accept, and dependent stages narrow as earlier ones are chosen.

3. **Lifecycle Stages** — tick a stage when it actually happens. The tick does
   not write an event: it dispatches a command carrying the version the screen
   was loaded against, and the backend checks the prerequisite, the duplicate
   and the version before anything is recorded.

4. **Overdue and delays** — a stage past its date is flagged in red and offers a
   schedule extension. The extension is an event; the original plan stays
   readable.

5. **Temperature** — readings are collected automatically on an hourly cadence.
   Out-of-range readings raise permanent alerts on the timeline, which is what
   makes "when did the temperature spike?" answerable after the fact.

> **On simulated data.** With `SENSOR_SOURCE=simulated` (the default, so a fresh
> checkout demonstrates monitoring without hardware) every reading is stamped
> `SIMULATED` in its immutable payload and labelled "Simulated (not measured)"
> in the chart, timeline and PDF. Set `SENSOR_SOURCE=none` to record nothing
> rather than invent anything.

## Tests

```bash
cd backend  && npm test    # 307 tests — no MongoDB needed
cd frontend && npm test    # 159 tests
```

Backend tests use Node's built-in runner against in-memory persistence, through
the same wiring production uses. Two suites matter most:

- `tests/database/immutability.test.js` — reaches **past** the application, edits
  events through the raw driver, and proves the tampering is detected
- `tests/integration/reconstruction.test.js` — replays raw events with the worker
  stopped, so no read-model assumption can leak into the check
- `tests/integration/shipmentScheduling.test.js` — fires twenty simultaneous
  creations and asserts twenty distinct identifiers; rejects out-of-order
  lifecycle confirmations posted directly to the API; proves a stale version is
  refused rather than applied
- `tests/integration/temperatureMonitoring.test.js` — automatic hourly
  collection, alert creation, duplicate prevention, and a 300-reading history
  that still produces a readable paginated PDF

---

## What is where

```
backend/src/
├── domain/shipment/        # Pure. No database, no HTTP, no framework.
│   ├── aggregate/          #   decision functions: (state, command) → event
│   ├── reducers/           #   the fold: (state, event) → state
│   ├── events/             #   event catalog + factory
│   └── validators/         #   structural command validation
├── application/
│   ├── commands/           # write-side handlers
│   ├── queries/            # read-side handlers
│   └── services/           # command, replay, sensor, reconciliation
├── infrastructure/
│   ├── eventStore/         # append-only repository + hash chain
│   ├── readModel/          # derived projection
│   ├── projections/        # projection handler + checkpoints
│   └── mongodb/            # driver + in-memory implementation
├── interfaces/http/
│   ├── commandRoutes/      # ── separate routers, the CQRS split
│   └── queryRoutes/        # ──
├── workers/projectionWorker/
└── app/dependencies.js     # the only place the object graph is wired

frontend/src/
├── components/             # timeline, scrubber, chart, command panel, dialogs
├── hooks/                  # async resource, abort handling, worker polling
├── store/                  # context + reducer: live vs historical mode
└── services/apiClient.js   # the only place the frontend calls the API
```

Full walkthrough in [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md).

---

## The four guarantees, and where to see them

### 1. Events are append-only

The Event Store repository has no `update`, `delete` or `replace` method. Beyond
that: a unique `(aggregateId, version)` index, a SHA-256 chain linking each event
to its predecessor, and a least-privilege MongoDB role that withholds `update`
and `remove` on the events collection ([setup](docs/database/DATABASE.md)).

```bash
# Edit history behind the application's back:
mongosh audit_trail --eval 'db.shipment_events.updateOne({aggregateId:"SHP-1001",version:5},{$set:{"payload.temperatureC":4}})'

curl localhost:4001/api/shipment/SHP-1001/integrity   # → intact: false
npm run verify:integrity                              # → exits non-zero
```

**On "cryptographic proof".** The source document uses that phrase. What is
actually implemented is tamper *evidence*: no stored event can be edited, and
none removed from a stream's middle, without detection. It does **not** stop an
attacker with write access recomputing the whole chain — that needs signing or
external anchoring, both written up in
[`ENHANCEMENTS.md`](docs/architecture/ENHANCEMENTS.md) rather than claimed here.

### 2. State is reconstructed, never read from a stored copy

One reducer, three callers: the command service validating a command, the worker
building the read model, and the historical query rebuilding state at an
arbitrary instant. They cannot disagree, because they are the same function.

### 3. Stale commands are rejected

Every command carries `expectedVersion`. Two checks enforce it — a pre-check that
produces a clear 409 naming both versions, and the unique index that catches the
genuine microsecond race the pre-check cannot.

Open the same shipment in two browser tabs, submit in one, then the other. The
second gets a dialog stating both versions and that **nothing was written**.

### 4. Eventual consistency is visible, not hidden

There is a real window where an event exists and the projection has not caught
up. Rather than serving stale data silently, `GET /api/shipment/:id` replays from
the Event Store and says so:

```json
"consistency": { "source": "event-store-replay", "projected": false, "lagVersions": 2 }
```

The dashboard turns that into a "Synchronising" banner that resolves itself, and
the header shows live projection lag at all times.

---

## Operations

| Command | Purpose |
| --- | --- |
| `npm run seed:http` | **Optional.** Loads the four demonstration shipments over HTTP against a running server, in either persistence mode. Convenient for a demo with pre-built history; *not required* — shipments are created, amended and archived from the dashboard itself. |
| `npm run seed` | Same dataset, written directly. Requires `PERSISTENCE=mongo` — an in-memory store is not shared between processes. |
| `npm run verify:integrity` | Verify every hash chain; non-zero exit on tampering |
| `npm run rebuild:readmodel` | Destroy and rebuild all projections from history |
| `npm run rebuild:readmodel -- --check` | Report drift, change nothing |

The read model is disposable by design. If it is ever wrong, delete it and
replay — nothing is lost, because nothing in it is a source of truth.

---

## Configuration

Copy `backend/.env.example` to `backend/.env`. Every variable has a working
default; nothing is required for local development.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4000` | |
| `PERSISTENCE` | `mongo` | `memory` runs with no database |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | Never commit a real one |
| `MONGODB_DATABASE` | `audit_trail` | |
| `CORS_ORIGIN` | `http://localhost:5173` | |
| `WORKER_IN_PROCESS` | `true` | `false` to run the worker separately |
| `WORKER_POLL_INTERVAL_MS` | `500` | |
| `LOG_LEVEL` | `info` | |

Configuration is read in exactly one module. Nothing else touches `process.env`,
which is why the whole backend is testable without setting any.

---

## Documentation

- [`docs/architecture/SCHEDULING_AND_MONITORING.md`](docs/architecture/SCHEDULING_AND_MONITORING.md)
  — how planning, delays, temperature monitoring and the audit report stay
  event-sourced, and the three requirements that were deliberately *not*
  implemented as written.


| Document | Contents |
| --- | --- |
| [Architecture](docs/architecture/ARCHITECTURE.md) | Request flows, layer rules, immutability layers, OCC, worker design, every design decision |
| [API](docs/api/API.md) | Every endpoint, request and response shape, full error table |
| [Event catalog](docs/events/EVENT_CATALOG.md) | Envelope, each event type, lifecycle, temperature policy, versioning |
| [Database](docs/database/DATABASE.md) | Collections, indexes, least-privilege role setup, persistence modes |
| [Testing](docs/testing/TESTING.md) | Suite breakdown, mid-project gate, manual verification steps |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Symptom-first fixes |
| [Demonstration](docs/DEMONSTRATION.md) | A 10-minute walkthrough script |
| [Enhancements](docs/architecture/ENHANCEMENTS.md) | Deliberate omissions, with reasons |

---

## Design decisions the source document left open

The source specifies the event names but not everything around them. Where it was
silent, a decision was made and recorded rather than assumed quietly:

- **Temperature thresholds** come from each shipment's `CONTAINER_CREATED`
  payload, never a global constant. A shipment created without a range never has
  a breach inferred.
- **A temperature spike does not change lifecycle state.** The source names the
  event but defines no consequence — no quarantine, no rejection. Inventing one
  would write an unsourced business rule into an audit trail. The aggregate
  records the breach and leaves interpretation to the operator.
- **The scrub boundary is inclusive** — an event stamped exactly at `at` is
  included. Asserted by test.
- **Timestamps are stored UTC, displayed local with the zone visible**, so a
  dispute about when a spike happened cannot become an argument about timezones.

The full list is in the architecture document. Every event type in the catalog is
marked either `source` or `design-decision`, and that catalog is served live at
`GET /api/meta/event-catalog` from the same constants the reducer validates
against — so it cannot drift from the code.
