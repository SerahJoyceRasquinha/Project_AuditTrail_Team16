# Testing

```bash
cd backend  && npm test     # 283 tests
cd frontend && npm test     # 141 tests
```

All counts in this document were re-run against this build rather than carried
forward from an earlier revision.

Backend tests use Node's built-in test runner and `PERSISTENCE=memory`, so they
need no MongoDB and no test framework dependency. Each test builds its own
isolated system through the **production wiring** (`buildContainer`, `createApp`)
rather than a parallel test-only arrangement that could quietly diverge.

## Backend suites

| Suite | Count | Covers |
| --- | ---: | --- |
| `tests/unit/` | 84 | Reducer, aggregate rules, validators, schedule policy — pure, no I/O |
| `tests/integration/` | 139 | Full lifecycle, projection, **the reconstruction check**, scrub boundaries, scheduling, temperature monitoring, authentication |
| `tests/api/` | 30 | Real HTTP over an ephemeral port: status codes, headers, error envelopes, middleware scope |
| `tests/database/` | 22 | Append behaviour, indexes, ordering, **the immutability audit** |
| `tests/concurrency/` | 8 | OCC, races, version-sequence integrity |
| **Total** | **283** | |

Per file:

| File | Count |
| --- | ---: |
| `unit/schedulePolicy.test.js` | 38 |
| `unit/commandValidators.test.js` | 18 |
| `unit/shipmentAggregate.test.js` | 14 |
| `unit/shipmentReducer.test.js` | 14 |
| `integration/shipmentScheduling.test.js` | 33 |
| `integration/authentication.test.js` | 22 |
| `integration/temperatureMonitorLifecycle.test.js` | 18 |
| `integration/temperatureMonitoring.test.js` | 18 |
| `integration/shipmentManagement.test.js` | 17 |
| `integration/eventLifecycle.test.js` | 13 |
| `integration/reconstruction.test.js` | 12 |
| `integration/demoAccounts.test.js` | 6 |
| `api/shipmentApi.test.js` | 19 |
| `api/export.test.js` | 4 |
| `api/reconciliationScope.test.js` | 4 |
| `api/rateLimitScope.test.js` | 3 |
| `database/eventStore.test.js` | 11 |
| `database/immutability.test.js` | 11 |
| `concurrency/optimisticConcurrency.test.js` | 8 |

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

### Middleware scope

Two API suites exist because middleware mounted on the command router is reached
by *every* `/api` request — both routers mount on the same path, so a request
only falls through to the query side when no command path matches. That makes
"which requests does this middleware actually run for?" a question worth pinning
with tests rather than reasoning about.

**`api/rateLimitScope.test.js`** (3 tests). The command rate limit must throttle
commands and nothing else: reads are never charged to it, commands still share
one budget across every command endpoint, and reads keep working after that
budget is exhausted — a throttled write surface must not blind the audit
surface.

**`api/reconciliationScope.test.js`** (4 tests). An unknown shipment is a 404 on
the reconciliation endpoint exactly as on every other query, rather than a
`consistent: true` green tick for a record that was never created. The internal
`reconcileAll` sweep keeps the opposite behaviour — an identifier nobody used is
not a read-model defect — and a test holds that distinction in place.

## Frontend suites

Vitest + Testing Library + jsdom. 141 tests over the timeline, scrubber, chart,
summary, banners, conflict dialog, status blocks, store reducer, the lifecycle
planner, authentication, the role matrix and theming.

| File | Count | Covers |
| --- | ---: | --- |
| `components.test.jsx` | 44 | Timeline, scrubber, chart, summary, banners, status blocks, store |
| `shipmentLifecycle.test.jsx` | 42 | Lifecycle planner: plan, confirm, extend, overdue display |
| `authentication.test.jsx` | 31 | Register/sign-in split, session restore, token handling |
| `theme.test.jsx` | 14 | Light/Dark tokens shared by the app, charts and metrics dashboard |
| `roleAccess.test.jsx` | 7 | Operator sees command affordances; User does not |
| `loginPage.test.jsx` | 2 | Sign-in flow and redirect |
| `exportAudit.test.js` | 1 | Export helper |
| **Total** | **141** | |

The tests that matter most are the ones asserting the current/historical
distinction, since conflating them is the failure mode the whole project exists
to avoid:

- the summary labels live vs reconstructed views differently
- scrubbing clears the event selection
- switching shipment resets all derived state
- events after the scrub cutoff are dimmed, not hidden
- the consistency banner explains lag without claiming failure

**Expected noise.** Recharts logs a width/height warning under jsdom, which has
no layout engine, and React Router logs v7 future-flag notices. Both are
cosmetic; the components mount and the assertions pass.

## End-to-end tests

Browser-driven Playwright specs live in `e2e/`. They are **not** part of
`npm test` — they need a browser binary and a running backend and frontend, so
the default suites stay self-contained and offline. See `e2e/README.md`, or
`docs/DEPLOYMENT.md` for the containerised way to stand the stack up.

```bash
cd e2e
npm install
npx playwright install chromium
npm test
```

`backend/scripts/verifyTemperatureFlow.js` remains the complementary check: it
drives the monitoring lifecycle over real HTTP and spends real time waiting for
an automatic reading, which is not something a fast suite should do.

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
   curl localhost:4001/api/shipment/SHP-1001/integrity   # intact: false
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
