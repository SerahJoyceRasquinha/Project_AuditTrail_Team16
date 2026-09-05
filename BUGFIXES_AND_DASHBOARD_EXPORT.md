# Bug-fix and dashboard-export round — September 2026

Three defects fixed, two changes delivered. Every defect below was found by
driving the running system, not by reading the code: both suites were green
before this round and are green after it, which is the point worth keeping in
mind about what a passing suite does and does not tell you.

Tests after this round: **307 backend** (87 unit, 148 integration, 42 API, 22
database, 8 concurrency), **159 frontend**. Previously 283 / 141.

---

## 1. Defects fixed

All three lived in `DashboardMetricsQueryHandler` and all three made the
dashboard state things that were not true.

### 1.1 Delivered shipments vanished from the state breakdown

`byState` was a hand-written literal naming three states, and the counting loop
skipped any state it did not already have a key for:

```js
byState: { CREATED: 0, IN_TRANSIT: 0, AT_PORT: 0 },
...
if (shipment.currentState && metrics.byState[shipment.currentState] !== undefined) {
```

`UNLOADED` is the fourth value of `SHIPMENT_STATES`, so every delivered shipment
was counted in `totalShipments` and then silently dropped from the breakdown.

**Observed:** one shipment driven to `UNLOADED` produced `totalShipments: 1`
with a `byState` that summed to **0**, and the dashboard pie chart emptied out
as shipments completed while the KPI cards still reported them.

**Fix:** the buckets are derived from the enum, so they cannot fall behind the
domain again — a state added to `SHIPMENT_STATES` gets a bucket for free.

```js
const byState = Object.fromEntries(Object.values(SHIPMENT_STATES).map((s) => [s, 0]));
```

The frontend had the same hard-coded list and got the same treatment; it now
renders whatever states the backend sends.

### 1.2 Metrics silently truncated at 100 shipments

The handler fetched everything in one call:

```js
const result = await this.#readModel.list({ pageSize: 10000, view: 'active' });
```

`list()` clamps `pageSize` to `limits.maxShipmentsPerPage`, which is 100. So
every figure — breaches, compliance, on-time rate, origins — was computed over
the 100 most recently touched shipments, and `totalShipments` reported that
truncated count as though it were the whole fleet. Nothing indicated a
truncation had happened.

**Observed:** with 111 shipments in the read model, the dashboard reported
`totalShipments: 100`.

**Fix:** a `#readAll()` that pages through the read model, reading the page size
back from the response rather than assuming it, so it keeps working if the limit
is reconfigured. The per-request limit is left alone — it exists to stop a single
HTTP query pulling an unbounded result set, and raising it would have traded one
problem for another.

### 1.3 `activeShipments` was a dead metric, and `totalShipments` was misnamed

The list was fetched with `view: 'active'` — which already excludes archived
shipments — and then filtered again:

```js
activeShipments: allShipments.filter(s => !s.archived).length,
```

The second filter could never remove anything, so `activeShipments` was always
exactly equal to `totalShipments`: two of the eight KPI cards were guaranteed to
show the same number. Worse, "Total Shipments" excluded archived shipments, so
filing one away made the headline total shrink.

**Observed:** archiving 1 of 2 shipments dropped the reported total from 2 to 1,
while `GET /api/shipments?view=all` correctly still reported 2.

**Fix:** read every shipment and partition here. `totalShipments` only ever
grows, `activeShipments` moves when something is archived, and a new
`archivedShipments` accounts for the difference — the three reconcile on screen.

One judgement worth flagging: breach, compliance and delivery figures are now
computed over archived shipments as well. Archiving is a filing decision, not a
retraction — a temperature excursion that happened still happened, and a forensic
dashboard that quietly forgets it would be lying by omission.

### Regression cover

`backend/tests/integration/dashboardMetrics.test.js` — 9 tests. Verified as
genuine regression tests by stashing the fix and re-running: **8 of the 9 fail
without it.** The assertions are about invariants ("the buckets sum to the
total", "active and archived partition the total") rather than fixture-specific
numbers, so they keep their meaning when the fixtures change.

---

## 2. Export buttons reduced to two

The event-history panel had four export buttons. Two called the backend; two
exported from the browser's copy of the **filtered** event list.

The client-side pair were the wrong artefact for this system. Their output
depended on whatever was typed in the search box, so two people could export
"the audit history" of the same shipment on the same day and get different
files, with nothing in either one saying so. For a ledger whose entire purpose
is being *the* record, that is a quietly dangerous thing to hand someone.

Now two buttons — **PDF, CSV**, in that order — both asking the backend for the
complete history including the hash chain. An export is the same evidence
regardless of what the screen was showing when the button was pressed.

`frontend/src/utils/exportAudit.js` and its test were deleted rather than left
as tested dead code once nothing referenced them.

---

## 3. Dashboard export, with every metric explained

### The endpoint

`GET /api/meta/dashboard-metrics/export?format=pdf|csv`

Served by the **query** router, so it requires a session like any other read and
needs no role beyond that — a read-only User can export the dashboard. It reuses
`DashboardMetricsQueryHandler` rather than re-querying, so an exported figure is
by construction the same figure the screen shows.

### Definitions have one home

`backend/src/application/queries/metricDefinitions.js` holds, for every metric:

- `plain` — no jargon, no schema. What the number counts and what it would mean
  if it moved.
- `technical` — which projection field, over which set of shipments, and where
  the honest edges are.
- `formula` — stated explicitly, because a KPI whose arithmetic is written down
  nowhere gets re-derived by guesswork the first time someone disputes it.

These are served at `GET /api/meta/metric-definitions` and used by the report, so
the caption on the card and the paragraph in the PDF are the same sentence by
construction. This follows the existing precedent of serving the event catalog
from the same constants the reducer validates against.

The definitions are deliberately honest about the awkward parts — that
Temperature Compliance counts shipments rather than readings, that a shipment
with no declared thresholds is counted as compliant without that being evidence
of good handling, and that the geographic bars are truncated to the top five and
therefore do not sum to the total.

### Charts are exported too

The four charts are redrawn server-side in pdfkit from the same numbers the
tables use. Rasterising the browser's SVG would have meant either shipping a
headless browser or trusting the client to upload an image it claims is its own
chart; drawing them from the source numbers means the picture and the table
cannot disagree, and the export works from `curl` with no browser involved.

The output was rasterised and inspected during development: pie proportions,
bar widths, legends and accented place names all render correctly, and the
all-zero case says "No data yet" rather than drawing a mysterious blank circle.

### CSV is self-describing

One row per metric with both explanations and the formula as columns, so the file
still makes sense to whoever opens it months later. Breakdowns are flattened to
one row per entry rather than stringified into a single unreadable cell, and a
UTF-8 BOM keeps spreadsheet software from mangling accented place names.

### On screen

Every KPI card and every chart now carries both explanations inline, plus a
"how to read this" note stating source, scope and freshness once at the top.

Inline rather than hover tooltips, deliberately: a tooltip is unreachable on a
touchscreen, invisible when the page is printed, and never discovered by the
person who most needs it — someone reading the board in a meeting who did not
build it.

The freshness note earns its place. The read model trails the event log by the
projection worker's lag, so a command issued seconds ago may not be counted yet;
a dashboard that does not say so invites someone to conclude their command was
lost.

An **Archived Shipments** card was added so that active + archived visibly
reconciles to the total.

Losing the definitions degrades the dashboard rather than breaking it — if the
definitions request fails the numbers still render, because they are still worth
showing.

---

## 4. Verified, beyond the suites

Checked against a running server this round:

- **Registration and login.** Duplicate usernames rejected including
  case-variants; mass assignment (`passwordHash`, `_id`, `createdAt` in the
  register body) correctly ignored; role escalation to `admin` rejected; empty
  bodies produce structured 400s rather than 500s; wrong password and unknown
  user return byte-identical 401s.
- **Token forgery.** A tampered payload with a grafted valid signature is
  rejected 401, because the signature is verified before the body is parsed.
- **Role matrix.** All 8 command endpoints return 403 for a User and 401 with no
  token; all query endpoints return 200 for a User.
- **Rate-limiter scoping** (an earlier regression). 20 queries do not consume the
  command budget; commands cut off at the configured limit; queries keep working
  after commands are throttled.
- **SSE stream.** Rejects a missing or bad token; a valid token receives the
  `connected` event and then live `shipment` notifications.
- **Lifecycle.** create → load → temperature → arrive → unload → amend → archive
  → restore, with correct 409 on a stale `expectedVersion`, container-code
  normalisation, auto-ID allocation, and hash-chain integrity intact.

One thing that looked like a defect and was not: a 12.4 °C reading produced
`TEMPERATURE_RECORDED` rather than a breach. That is correct — `TEMPERATURE_POLICY`
states that with no `minTemperatureC`/`maxTemperatureC` declared at creation, no
breach is inferred. With thresholds set, a 19.5 °C reading correctly produced
`TEMPERATURE_SPIKE` and propagated through to the compliance figure.

## 5. Not covered

The Playwright e2e suite was not executed here — it needs browser binaries this
environment does not have. Its specs were checked and none reference the removed
export buttons, so nothing in it should have been invalidated, but it has not
been run since these changes.
