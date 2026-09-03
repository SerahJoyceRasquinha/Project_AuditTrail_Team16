# End-to-end tests

Browser-driven Playwright specs for the Audit Trail dashboard.

These are **not** part of `npm test` in either workspace, and that is deliberate.
They need a browser binary and a running stack; the unit, integration, API,
database and concurrency suites need neither, and a suite that cannot run offline
is a suite people stop running. Keeping them apart means `npm test` stays a thing
you run constantly and this stays a thing you run before a review.

## Running them

From this directory:

```bash
npm install
npx playwright install chromium   # downloads the browser; needs network access
npm test
```

Playwright starts the backend and frontend itself. The backend runs with
`PERSISTENCE=memory`, so **no MongoDB is required** and every run begins from an
empty ledger.

Useful variants:

```bash
npm run test:headed   # watch it drive a visible browser
npm run test:ui       # Playwright's interactive runner
npm run report        # open the HTML report from the last run
```

## Running against an already-running stack

Set `E2E_BASE_URL` and Playwright will not start any servers:

```bash
E2E_BASE_URL=http://localhost:8080 npm test    # e.g. a docker compose deployment
```

Note that a persistent backend keeps everything the tests create. The specs
generate unique usernames and container codes per run for exactly that reason,
so repeated runs against one database do not collide — but the ledger will grow.

## What is covered

| Spec | Covers |
| --- | --- |
| `auth.spec.js` | Unauthenticated redirect, registration leaving you signed out, wrong password refused, session surviving a reload, and a read-only account refused by the **server** rather than merely by a hidden button |
| `ledger.spec.js` | Search bar, the vertical timeline rendering the canonical four-event sequence in order, the temperature chart panel, the time scrubber, and the integrity/reconciliation panels |
| `concurrency.spec.js` | The Week 4 scenario: a page that loaded version N submits against it after someone else has moved on, and is refused with `CONCURRENCY_CONFLICT` — with the event stream checked afterwards to prove `applied: false` was true |

## Design notes

**Setup goes through the API, not the UI.** Only the one test that is *about*
registration drives the registration form. Everything else creates its accounts
and shipments over HTTP. Setup that goes through the UI turns every spec into a
test of the sign-up page, so one change there fails a dozen unrelated specs and
the report stops telling you what actually broke.

**Serial, one worker.** The tests share a backend and the ledger list is global
state. Run in parallel, an assertion about "the shipments visible on this page"
would depend on what another worker happened to create a moment earlier — which
is a flaky suite, and a flaky suite teaches people to ignore failures.

**The temperature monitor is disabled** for these runs
(`SENSOR_MONITOR_ENABLED=false`). It appends readings on a timer, which would
land underneath a test asserting on a version number and produce a failure that
looks like a bug in the command path. Monitoring has its own coverage in
`backend/tests/integration/temperatureMonitorLifecycle.test.js`, and
`backend/scripts/verifyTemperatureFlow.js` drives the whole flow over real HTTP
including the wait for an automatic reading.

**Selectors are roles and labels**, not class names — assertions about what the
page communicates rather than how it is styled.
