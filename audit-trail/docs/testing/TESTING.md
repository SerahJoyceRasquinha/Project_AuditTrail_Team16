# Testing

```bash
cd backend  && npm test     # 115 tests
cd frontend && npm test     #  34 tests
```

Backend tests use Node's built-in test runner and `PERSISTENCE=memory`, so they
need no MongoDB and no test framework dependency. Each test builds its own
isolated system through the **production wiring** (`buildContainer`, `createApp`)
rather than a parallel test-only arrangement that could quietly diverge.

## Backend suites

| Suite | Covers |
| --- | --- |
| `tests/unit/` | Reducer, aggregate rules, validators — pure, no I/O |
| `tests/database/` | Append behaviour, indexes, ordering, **the immutability audit** |
| `tests/integration/` | Full lifecycle, projection, **the reconstruction check**, scrub boundaries |
| `tests/concurrency/` | OCC, races, version-sequence integrity |
| `tests/api/` | Real HTTP over an ephemeral port: status codes, headers, error envelopes |

### The mid-project gate

Two suites correspond to the roadmap's mandatory mid-project checks.

**Immutability audit** (`tests/database/immutability.test.js`, 11 tests). It does
not only check that the application refuses to mutate events — that would be
circular. It reaches past the application, edits documents through the raw
driver, and proves the tampering is detected:

- editing a payload, a timestamp, an event type or a version → detected
- deleting an event from the middle of a stream → detected
- an untampered chain → verifies clean, so the audit is not vacuous

**Reconstruction check** (`tests/integration/reconstruction.test.js`). Reads raw
events and replays them; the worker is never started, so no read-model assumption
can leak in. Asserts the expected state after *every* version, and that a clean
database reproduces identical state.

### Scrub boundary coverage

Every case from roadmap 12.9 has a test: before the first event, exactly on an
event, exactly on the spike, between events, at the last event, after the last
event, and an invalid timestamp.

### Concurrency

The headline test issues ten simultaneous commands at the same version and
asserts exactly one succeeds, nine receive `CONCURRENCY_CONFLICT`, and the stored
version sequence is `[1,2,3]` — gapless, no duplicates. A second test proves the
remediation path the error advertises actually works.

## Frontend suites

Vitest + Testing Library + jsdom. 34 tests over the timeline, scrubber, chart,
summary, banners, conflict dialog, status blocks and store reducer.

The tests that matter most are the ones asserting the current/historical
distinction, since conflating them is the failure mode the whole project exists
to avoid:

- the summary labels live vs reconstructed views differently
- scrubbing clears the event selection
- switching shipment resets all derived state
- events after the scrub cutoff are dimmed, not hidden
- the consistency banner explains lag without claiming failure

**Expected noise.** Recharts logs a width/height warning under jsdom, which has
no layout engine. It is cosmetic; the chart mounts and the assertions pass.

## Manual verification

```bash
# 1. Start MongoDB, then:
cd backend && npm run seed
npm start                     # terminal 1
cd frontend && npm run dev    # terminal 2
```

1. **Search** `SHP-1001` on the dashboard.
2. **Timeline** — four+ events in version order; click one to expand its payload
   and hash link.
3. **Scrub** to before the spike; the summary turns violet, the breach flag
   disappears, later events dim, the chart truncates.
4. **Chart** — the amber point sits exactly on the timeline's spike; the shaded
   band is the agreed range.
5. **Immutability** —
   ```bash
   mongosh audit_trail --eval 'db.shipment_events.updateOne({aggregateId:"SHP-1001",version:3},{$set:{"payload.temperatureC":4}})'
   curl localhost:4000/api/shipment/SHP-1001/integrity   # intact: false
   npm run verify:integrity                              # exits non-zero
   ```
6. **OCC** — open the same shipment in two tabs. Submit a command in tab A, then
   in tab B. Tab B gets the conflict dialog naming both versions.
7. **Eventual consistency** — set `WORKER_ENABLED=false`, restart, send a
   command. The "Synchronising" banner appears and the data is still correct.
8. **Rebuild** —
   ```bash
   mongosh audit_trail --eval 'db.shipment_read_model.deleteMany({})'
   npm run rebuild:readmodel
   ```
   The dashboard is fully restored from events alone.

## What is not covered

Playwright end-to-end tests are specified by the roadmap but not included: they
would need a browser binary and a running MongoDB, which puts them outside what
this deliverable can verify on its own. The manual sequence above walks the same
path, and the API suite already exercises every backend route over real HTTP.
