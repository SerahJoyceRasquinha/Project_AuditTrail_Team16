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
| 23–29 | Unit / integration / API / database / worker / frontend tests pass | — | 115 backend + 34 frontend |
| 30 | Documentation is complete | `docs/` | 8 documents |
| 31 | README allows a new developer to run the system | `README.md` | Two quick-start paths |

## Not included

**Playwright end-to-end tests.** Specified by the roadmap but omitted: they
require a browser binary and a live MongoDB, which is outside what this
deliverable can verify on its own. `docs/testing/TESTING.md` gives a manual
sequence covering the same path, and the API suite already exercises every route
over real HTTP.

**Deployment configuration.** The roadmap marks this optional, as the source
specifies no platform. Production readiness that *is* implemented: graceful
shutdown, connection retry with backoff, health checks, structured logs with
redaction, and an independently deployable worker.

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

### Known issue, not introduced here

The command router's rate limiter is mounted with `router.use`, so query
requests falling through also consume the command budget. Pre-existing; left
alone to keep this change focused.
