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
