# Running the project, and what was fixed

## Running it

Double-click **`START_PROJECT.bat`** in this folder.

It finds the project wherever you unzipped it, opens a **BACKEND** terminal and a
**FRONTEND** terminal, and opens the dashboard in Chrome once both are actually
serving. Nothing else to type.

| | |
|---|---|
| Dashboard | http://localhost:5173/ |
| API health | http://localhost:4001/health |

**Demo logins** (created automatically by the launcher):

| Account | Role | Can do |
|---|---|---|
| `operator` / `operator123` | Operator | run shipment commands |
| `viewer` / `viewer123` | User | read-only |

You can also register your own account from the sign-in page.

### What it does, in order

1. Finds the project folder and checks Node.js is installed.
2. Warns if ports 4001 or 5173 are already in use.
3. Opens the BACKEND terminal: `npm install`, then `PERSISTENCE=memory`, then `npm run dev`.
4. **Waits until port 4001 actually accepts a connection** before continuing.
5. Opens the FRONTEND terminal: `npm install`, then `npm run dev`.
6. **Waits until port 5173 actually accepts a connection.**
7. Opens Chrome (falls back to your default browser if Chrome isn't installed).

The waits are real connection probes, not fixed `sleep` calls. That matters on the
first run, where `npm install` can take a few minutes — a timer-based launcher
would open the browser on a dead page.

### Notes

- **First run is slow** — both `npm install` steps have to complete. Later runs are quick.
- **Data is in memory only.** `PERSISTENCE=memory` means no MongoDB is needed, and
  restarting the backend clears every shipment. This is the same mode you were
  running by hand.
- **To stop:** close the two server terminals (or Ctrl+C in each). The launcher
  window closes itself and can be closed at any time without affecting the servers.
- **Demo accounts:** the launcher sets `AUTH_SEED_DEMO_ACCOUNTS=true` so you can sign
  in immediately. It only ever *creates* accounts that don't exist and never
  overwrites one. If you'd rather register your own account each time, delete the
  `$env:AUTH_SEED_DEMO_ACCOUNTS='true';` fragment from the BACKEND line in the .bat.
- If a terminal reports `npm install failed`, the launcher stops there rather than
  starting a server that would only crash — read the error in that window.

---

## Bugs found and fixed

Both were found by running the live system, not by the test suites — both suites
were fully green before and after.

### 1. The command rate limiter was throttling the entire query side

**Severity: high.** This would have shown up during a demo.

`shipmentCommandRoutes.js` attaches `requireRole` per route, with a comment
explaining exactly why: both routers mount on `/api`, so *every* request —
including every GET — enters the command router's middleware first and only falls
through to the query router when no path matches. A router-level guard would
therefore reject legitimate reads.

That reasoning was correct but wasn't applied to the `rateLimiter` two lines below,
which was still `router.use(...)`. So every read was charged to the command budget.
Measured, with the limit set to 5, using a **read-only** account that cannot issue a
single command:

```
before:  12x GET /api/shipments  ->  {"200":5, "429":7}
         GET /api/meta/dashboard-metrics -> 429 RATE_LIMITED

after:   12x GET /api/shipments  ->  {"200":12}
         GET /api/meta/dashboard-metrics -> 200
```

At the default 300 requests/minute, an open dashboard polling the list, metrics,
timeline, sensors, schedule and worker endpoints could exhaust the budget and start
429-ing its own reads.

**Fix:** one limiter instance, attached per command route — mirroring what was
already done for `requireRole`. The budget stays *shared across all commands* (it is
a limit on commanding, not a separate allowance per endpoint) while queries are
never counted against it.

### 2. Reconciliation reported a non-existent shipment as consistent

`GET /api/shipment/SHP-99999/reconciliation` returned `200 {"consistent": true,
"discrepancies": []}` while every other query endpoint correctly returned 404.

In `reconciliationService.js`, the empty-stream branch returns
`consistent: projection === null`. That is the right answer for the internal
`reconcileAll` sweep, which asks "does the read model disagree with the events
anywhere?" and must not be tripped by an identifier nobody ever used. Served to an
auditor who typed an identifier, the same answer is a confident wrong one — a green
integrity tick for a record that was never created.

**Fix:** the service now reports `eventCount`, and the distinction is drawn at the
HTTP edge, where the caller's question is known. `ReconcileShipmentQueryHandler`
throws `AggregateNotFoundError` on an empty stream; the sweep keeps the semantics it
needs.

### Regression tests added

`backend/tests/api/rateLimitScope.test.js` (3 tests) and
`backend/tests/api/reconciliationScope.test.js` (4 tests).

Verified to **fail against the original code** (5 of 7 fail) and pass against the
fix. The two that pass either way deliberately pin behaviour that was already
correct — that commands are still rate limited and share one budget, and that the
sweep still tolerates an empty store — so the fixes cannot be over-applied later.

---

## Verification performed

| Check | Result |
|---|---|
| Backend suite (`npm test`) | **283 passed**, 0 failed (was 276 + 7 new) |
| Frontend suite (`npm test`) | **141 passed**, 0 failed |
| Frontend production build | succeeds, 862 modules |
| Live end-to-end API script | **47/47 passed** |
| Utility scripts | `seed`, `verify:integrity`, `rebuild:readmodel` all behave correctly |

The end-to-end script drove the running server rather than the test harness:
registration, login, `/auth/me`, forged and stale tokens, shipment creation,
container-code normalisation, the full move chain, temperature recording and spike
classification, amend, archive/restore, schedule plan/revise/extend, timeline,
integrity, reconciliation, state scrubber, sensors, pagination, dashboard metrics,
and CSV + PDF export.

Also confirmed live: SSE frames genuinely arrive on `/api/stream/shipments`; the
automatic temperature monitor writes readings on its own schedule (verified with a
compressed interval — four readings landed and the hash chain stayed intact); role
enforcement is genuinely server-side, so a read-only account posting straight to a
command endpoint with curl gets a 403 rather than relying on a hidden button; and
`PUT`/`DELETE`/`PATCH` are not routed anywhere on the shipment surface.

### Not verified

The `.bat` itself could not be executed here — this environment is Linux, so there
is no `cmd.exe` or PowerShell to run it against. It is written defensively (path
resolution, Node check, port checks, real connection probes, npm-install failure
handling), but its first real run is on your machine.

The UI was verified through its 141-test suite, a clean production build and a code
read — not by clicking through a browser, as no Chromium was available here.
