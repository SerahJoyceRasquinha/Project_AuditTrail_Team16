# Definition of Done — verification

Every item from the roadmap's final checklist, with where it is implemented and
where it is proved.

| # | Requirement | Implementation | Evidence |
|---|---|---|---|
| 1 | CQRS command/query separation exists | `interfaces/http/commandRoutes/`, `queryRoutes/` | `tests/api` — separate routers, `x-cqrs-side` header |
| 2 | Commands create domain events | `ShipmentAggregate` decision functions | `tests/unit/shipmentAggregate` |
| 3 | MongoDB Event Store stores raw events | `shipment_events` | `tests/database/eventStore` |
| 4 | Events are append-only | `append()` is the only write path | `tests/database/immutability` |
| 5 | Events cannot be updated | No method exists; guard throws | AUDIT 2 |
| 6 | Events cannot be deleted | No method exists; guard throws | AUDIT 3 |
| 7 | Event versions are consistent | Unique `(aggregateId, version)` | `tests/database`, `tests/concurrency` |
| 8 | Event ordering is deterministic | Sort by version; replay rejects disorder | `tests/unit/shipmentReducer` |
| 9 | Aggregate state can be reconstructed | `ReplayService.reconstructCurrentState` | `tests/integration/reconstruction` |
| 10 | Historical state can be reconstructed | `reconstructStateAt` | 7 boundary tests |
| 11 | Projection worker operates independently | `src/worker.js`, `WORKER_IN_PROCESS=false` | Manual + `/api/meta/worker` |
| 12 | Read Model is derived from events | Worker uses the shared reducer | `tests/integration` reconciliation |
| 13 | Projection failures are observable | Dead letters + `/api/meta/worker` | `checkpointRepository` |
| 14 | Duplicate processing is safe | Version-guarded upsert | `tests/integration` idempotency |
| 15 | State scrubbing works | `StateScrubber` + `/state?at=` | Frontend + integration tests |
| 16 | OCC rejects stale commands | Pre-check + unique index | `tests/concurrency` |
| 17 | Race-condition tests pass | 10 concurrent commands → 1 wins | `tests/concurrency` |
| 18 | React dashboard searches shipments | `DashboardPage` | `tests/api` list + search |
| 19 | Vertical timeline displays events | `EventTimeline` | `tests/components` |
| 20 | Recharts displays sensor information | `SensorChart` | `tests/components` |
| 21 | Sensor data aligns with event timestamps | Same events, same epoch, `eventId` on each point | `tests/integration` sensor |
| 22 | Loading/error/empty states work | `StatusBlocks` used by every panel | `tests/components` |
| 23–29 | Unit / integration / API / database / worker / frontend tests pass | — | 307 backend + 159 frontend |
| 30 | Documentation is complete | `docs/` | 12 documents |
| 31 | README allows a new developer to run the system | `README.md` | Two quick-start paths |

### Beyond the original checklist

The roadmap's checklist stops at 31. The rows below cover work added since, so
the table describes the build that exists rather than the one first specified.

| # | Requirement | Implementation | Evidence |
|---|---|---|---|
| 32 | Server-allocated `SHP-N` references are race-free | `infrastructure/identity/shipmentIdAllocator.js` | 20 simultaneous creations → 20 distinct ids |
| 33 | Country/state pairs the UI offers are pairs the validator accepts | `domain/shipment/reference/locations.js`, `GET /api/meta/locations` | `tests/unit/commandValidators` — bad pairs posted directly |
| 34 | Lifecycle scheduling is event-sourced, not a stored status | `domain/shipment/schedule/schedulePolicy.js` | `tests/unit/schedulePolicy` (38), `tests/integration/shipmentScheduling` (33) |
| 35 | Overdue status is derived, never stored | `deriveStageStatuses` | No `isOverdue` field exists anywhere |
| 36 | Schedule extensions move only unconfirmed stages | `SHIPMENT_SCHEDULE_EXTENDED` | `tests/integration/shipmentScheduling` |
| 37 | Automatic temperature monitoring issues commands, not writes | `application/services/temperatureMonitorService.js` | `tests/integration/temperatureMonitorLifecycle` (18) |
| 38 | Monitoring survives a restart without duplicating readings | `resumeActiveShipments()`, slot derivation | Simulated restart + two racing monitors |
| 39 | Reading provenance is immutable and surfaced | `source: SIMULATED / EXTERNAL / MANUAL` | Chart legend, timeline, PDF |
| 40 | Real-time refresh does not violate CQRS | `infrastructure/realtime/shipmentEventBus.js`, `GET /api/stream/shipments` | Notifications carry no data; published post-commit |
| 41 | Forensic PDF separates plans from facts | `application/queries/shipmentReport.js` | `tests/api/export` (4), incl. 300-reading pagination |
| 42 | Authentication hashes passwords and never trusts the token's role | `application/services/authService.js` | `tests/integration/authentication` (22) |
| 43 | Registration does not sign the new account in | `authService.register()`, `POST /api/auth/register` | `tests/integration/authentication`, `frontend/tests/authentication` |
| 44 | Role enforcement is server-side, not a hidden button | `requireRole` per command route | `tests/integration/authentication`, `frontend/tests/roleAccess` (7) |
| 45 | One theme system drives the app, the charts and the metrics dashboard | `frontend/src/hooks/useTheme.js` | `frontend/tests/theme.test.jsx` (14) |
| 46 | Command rate limiting throttles commands only | `shipmentCommandRoutes.js` — per-route limiter | `tests/api/rateLimitScope` (3) |
| 47 | An unknown shipment answers 404 on every query endpoint | `ReconcileShipmentQueryHandler` | `tests/api/reconciliationScope` (4) |
| 48 | Deployment configuration exists | `Dockerfile`s, `docker-compose.yml`, `docs/DEPLOYMENT.md` | `docker compose up` brings up Mongo, API, worker, dashboard |
| 49 | Browser-driven end-to-end tests exist | `e2e/` (Playwright) | Run separately from the unit suites — see `e2e/README.md` |

## Previously not included — now built

**Playwright end-to-end tests.** Previously scoped out. Now present in `e2e/`,
and deliberately kept *out* of `npm test`: they need a browser binary and a
running stack, and the default suites are worth keeping self-contained and
offline. `docs/testing/TESTING.md` documents how to run them, and the manual
click-through it describes remains valid for anyone who would rather not install
a browser.

**Deployment configuration.** Previously scoped out because the roadmap named no
target platform. Now provided as containers, which commits to no vendor: a
backend image, a static-build frontend image behind nginx, and a compose file
wiring them to MongoDB with the projection worker as its own service — the
independently deployable worker the architecture always allowed for, actually
deployed independently. See `docs/DEPLOYMENT.md`. Production readiness that was
already in place regardless: graceful shutdown, connection retry with backoff,
health checks, and structured logs with redaction.

---

## Accounts, authentication and role-based access (Aug 2026)

Authentication was added as a layer *around* the existing architecture, not as a
change to it. No command bypasses the Event Sourcing pipeline, the Event Store
remains append-only, and CQRS separation is untouched.

### Roles

Two roles, fixed at registration and stored on the account:

| | Queries | Shipment commands |
|---|---|---|
| **User** | yes | no (403) |
| **Operator** | yes | yes |
| *unauthenticated* | no (401) | no (401) |

There is no administrator role. The requirement specifies Operator vs User, and
adding a superuser would mean adding an escalation path nothing asked for.

### Where authority comes from

The browser stores **only** a signed token. Identity and role are re-derived on
every request from the stored account record (`AuthService.verifyToken`), so:

- a token cannot claim a role its account does not have;
- editing `localStorage` cannot upgrade a session, only end one;
- `GET /api/auth/me` restores the session after a refresh without trusting
  anything the client kept.

Authorization runs in `requireRole`, attached per command route so it executes
before the controller, handler, aggregate and Event Store — a forbidden command
appends nothing. It is attached per route rather than via `router.use` because
both routers mount on `/api`, so a router-level guard would also reject queries
falling through to the query side.

### Passwords

scrypt (N=16384) over a per-account random salt, compared in constant time. A
sign-in for a non-existent account still performs a comparison, so timing does
not reveal which usernames exist, and both failures return the same message.
Hashes never leave the backend.

### Accounts are not events

Accounts live in their own `users` collection with a unique index on `username`.
An account is mutable by nature; the shipment log is append-only by
construction. Keeping them apart lets each be what it is, and leaves every
existing immutability guarantee intact.

### Configuration

`AUTH_ENABLED` (default true; the test suite disables it), `AUTH_TOKEN_SECRET`
(set in any real deployment so sessions survive a restart) and
`AUTH_TOKEN_TTL_MS` (default 12h). See `.env.example`.

### Seeding

`npm run seed:http` registers and signs in as `seed.operator`, then issues the
same authorised commands any client would. Override with `SEED_USERNAME` /
`SEED_PASSWORD`.

### Pre-existing defects fixed along the way

These were blocking verification and are unrelated to auth:

1. `createShipment` referenced an undefined `shipmentId` (a merge dropped the id
   allocation from commit `3213da5`), throwing on **every** write and failing 222
   of 341 backend tests.
2. `ShipmentPage` used `useAsyncResource` and `useShipmentStream` without
   importing them, and called a non-existent `api.getShipmentSchedule` — the
   shipment detail page could not render.
3. `getLocationCatalogue` was imported by `data/locations.js` but never exported.
4. `exportShipment` never sent the bearer token, and the SSE stream could not
   (EventSource cannot set headers; it now passes the token as a query
   parameter, verified by the same code path).

### Known issue, since fixed

The command router's rate limiter was mounted with `router.use`, so query
requests falling through to the query side also consumed the command budget —
a read-only account, which cannot issue a single command, could be throttled out
of the dashboard by a limit on commands. It is now attached per command route,
mirroring what `requireRole` already did and for the same reason. One limiter
instance is shared across the command routes, so the budget remains a limit on
commanding rather than a separate allowance per endpoint. Pinned by
`tests/api/rateLimitScope.test.js`.

Fixed alongside it: `GET /api/shipment/:id/reconciliation` returned
`200 {"consistent": true}` for a shipment that does not exist, while every other
query endpoint returned 404 — a green integrity tick for a record that was never
created. The service keeps that answer for the `reconcileAll` sweep, where it is
correct; the 404 is now raised at the HTTP edge, where the caller's question is
known. Pinned by `tests/api/reconciliationScope.test.js`.
