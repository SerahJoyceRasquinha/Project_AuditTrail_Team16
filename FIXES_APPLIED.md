# Fixes Applied — Audit Trail

Applied against build `0ea4177`. All four findings from the verification report are fixed.

**Verification after changes:** backend 308/308 pass · frontend 172/172 pass · 27-step end-to-end all pass · `vite build` clean.

---

## 1. CRITICAL — No user-facing temperature entry

**Was:** `recordTemperature` was exported from `apiClient.js` and imported by nothing. The command endpoint worked; nothing in the application reached it.

**Now:** a "Record Temperature" panel on the shipment page.

- New: `frontend/src/components/TemperatureEntry.jsx`
- Changed: `frontend/src/pages/ShipmentPage.jsx` (mounts the panel above Shipment Schedule)
- New: `frontend/tests/temperatureEntry.test.jsx` (13 tests)

Design decisions worth knowing:

- **The panel does not classify breaches.** It sends the number; the aggregate compares it against the range recorded at creation and emits `TEMPERATURE_RECORDED` or `TEMPERATURE_SPIKE`. Classifying client-side would mean two implementations of one rule, and the wrong one would end up in the immutable payload. The panel only *previews* ("this will be recorded as a spike") — the server decides.
- **No timestamp field.** `occurredAt` exists for backfilling through the API. A reading typed now happened now, and letting an operator hand-date one is exactly how a stream acquires a timestamp that contradicts its own version order.
- Carries `expectedVersion` from the loaded shipment, so OCC applies as it does to every other command; a 409 is reported in plain language.
- Disabled with an explanatory reason for read-only accounts, archived shipments, and the historical view — matching `LifecyclePlanner`.
- `sensorId` is omitted rather than sent as an empty string.

---

## 2. HIGH — Chronology guard hole

**Was:** in `shipmentCommandService.js`, the guard read

```js
if (command?.occurredAt && previousAt && Date.parse(timestamp) < Date.parse(previousAt))
```

Two problems: no upper bound on `occurredAt` (a reading dated 2036 was accepted), and the check was skipped entirely whenever `occurredAt` was omitted — the normal path. One future-dated event therefore inverted the stream permanently, and `getEventsUntil` (which filters by timestamp) could then fold a non-prefix set and return a state that never existed.

**Now:** the two concerns are separated, because they belong in different places.

- **Chronology — `shipmentCommandService.js`.** The `command?.occurredAt &&` gate is removed, so *every* append is checked against its predecessor. This is a ledger invariant and belongs on the write path, regardless of who is writing.
- **Future bound — `commandValidators.js`, `optionalOccurredAt`.** Client-supplied `occurredAt` may not sit more than 5 minutes ahead of the server clock (ordinary skew; a mistyped year is refused).

The bound lives in the validator rather than the command service deliberately. The temperature monitor is a trusted in-process producer that drives its own clock — the test suite advances it hours ahead to exercise hourly sampling — so a bound on `Date.now()` inside `#execute` broke three legitimate monitor tests. Validators guard client input; `#execute` guards ledger invariants. Putting each rule at its own layer fixes the reported hole without hobbling the monitor.

Backdating remains allowed, as backfilling requires.

---

## 3. MEDIUM — Wrong error for a nonexistent aggregate

**Was:** the OCC pre-check ran before the existence check, and since `expectedVersion` is validated as ≥ 1 it could never match a stored version of 0. Every command against an unknown shipment returned `409 CONCURRENCY_CONFLICT` — telling the operator to reload and retry something that was never there. The existence branch logged a warning and then fell through without throwing.

**Now:** the existence check runs first and throws `AggregateNotFoundError`. Unknown shipments return `404 AGGREGATE_NOT_FOUND`; genuine conflicts still return 409.

Changed: `backend/src/application/services/shipmentCommandService.js`

---

## 4. MEDIUM — Replay accepted gapped and jumped version sequences

**Was:** `replay()` checked `event.version <= previousVersion` — ascending, but not contiguous. Deleting event 3 left `[1, 2, 4]`, which folded cleanly and returned a confident state silently missing whatever event 3 recorded. A jump from 4 to 99 replayed as `version 99`.

**Now:** `event.version !== previousVersion + 1` throws. A gap means the history is incomplete, and an incomplete history fails loudly rather than producing a plausible wrong answer. `/integrity` already reported this as `VERSION_GAP`; the reconstruction path now refuses it too.

Changed: `backend/src/domain/shipment/reducers/shipmentReducer.js`

**Test updated, not weakened:** `tests/unit/shipmentReducer.test.js` asserted on the old message text (`/ascending version order/`). Its expectation now matches the stricter message, and a new test covers the gap case that previously slipped through. Test count 307 → 308.

---

## Files touched

| File | Change |
|---|---|
| `backend/src/application/services/shipmentCommandService.js` | Findings 2 and 3 |
| `backend/src/domain/shipment/validators/commandValidators.js` | Finding 2 (future bound) |
| `backend/src/domain/shipment/reducers/shipmentReducer.js` | Finding 4 |
| `backend/tests/unit/shipmentReducer.test.js` | Updated assertion + new gap test |
| `frontend/src/components/TemperatureEntry.jsx` | **new** — Finding 1 |
| `frontend/src/pages/ShipmentPage.jsx` | Mounts the panel |
| `frontend/tests/temperatureEntry.test.jsx` | **new** — 13 tests |

Nothing else was modified. No requirement was weakened, no historical event altered, no validation bypassed, and Event Sourcing was not replaced with CRUD anywhere.

---

## Still worth knowing

- **MongoDB was never available in the test environment.** Everything ran on `PERSISTENCE=memory`, which does enforce the unique indexes and raise real `E11000`. Please re-run `npm test` and a manual pass against a real MongoDB before trusting these fixes in a deployment.
- **The Playwright specs in `audit-trail/e2e/` were never executed** — no browser binaries. The new panel is covered by 13 jsdom tests, not by a browser test. Running the e2e suite locally is worth doing.
- The `dist/` build output was removed before packaging; run `npm install` in `backend/` and `frontend/` as usual.

---

# Round 2 — metrics, dependencies, launcher

**Verification:** backend **311/311** · frontend **179/179** · `vite build` clean · `npm audit` **0 vulnerabilities** in both projects.

---

## 5. Dashboard metrics did not agree with the shipment they described

**Reported as:** "graphs and readings don't correspond to the shipment temperature readings."

**Reproduced.** Recreating the screenshot — one shipment, range 15–45 °C, five readings with one at 50 °C — the metrics endpoint returned `overallTemperatureCompliance: 0`, which the dashboard drew as **"Breaches: 100% / Compliant: 0%"** while that same shipment's page said **"5 readings · 1 breach"**.

**Root cause.** `overallTemperatureCompliance` counts *shipments*, not readings: one shipment that breached once out of five readings is 0% by that definition. The figure was correct; putting it under a heading a reader takes to mean readings was not. Two different questions were sharing one name.

**Fixed:**

- **New reading-level metrics** — `totalTemperatureReadings`, `breachReadings`, `readingTemperatureCompliance`. The scenario above now reports **80%**, matching the shipment page exactly.
- **The compliance pie now uses the reading-level figure**, with the raw counts printed under the title (`20 readings · 2 outside range`) so the arithmetic can be checked without leaving the page.
- **Both figures are kept**, under honest separate names: *Reading Compliance* and *Shipments Fully Compliant*. Neither was deleted — they answer different questions and both are worth knowing.
- **`onTimeDeliveryRate` and `averageDeliveryTime` are `null`, not `0`, when nothing has been delivered.** Zero read as "we are failing 100% of deliveries" for a fleet that had simply not delivered anything yet. The UI shows `—`.
- **`readingTemperatureCompliance` is `null` when no readings exist**, and the pie is replaced by text saying so — *"This is not the same as 0% compliant."*

Changed: `backend/src/application/queries/queryHandlers.js`, `backend/src/application/queries/metricDefinitions.js`, `frontend/src/components/StatusDashboard.jsx`

## 6. The lifecycle pie printed its labels on top of each other

Visible in the screenshot as `BtnRandtl:0O` — three zero-count states (`In Transit: 0`, `At Port: 0`, `Unloaded: 0`) each got a label from Recharts, all placed at the same point on a zero-width slice.

The obvious fix — dropping empty buckets — was **wrong**, and an existing test says so: a state with no shipments must not silently vanish from the breakdown. So the buckets are all still there; only the *label* is suppressed for a zero slice, and the full breakdown is printed as text beneath the chart (`Created: 1 · In Transit: 1 · At Port: 0 · Unloaded: 2`). Empty states are now more visible than before, not less.

## 7. The dashboard did not update when a reading was recorded

It polled every 30 seconds, so a temperature entered on the shipment page left the fleet totals stale — which is what "it isn't working properly" looks like from the outside.

It now subscribes to the same SSE notification stream the ledger already uses. The notification only says something changed; the response is to re-run the ordinary query, so no second source of truth is introduced and CQRS is untouched. The 30-second poll stays as a fallback for when the stream is unavailable. The first load still shows a skeleton; later refreshes update in place rather than tearing the page down.

## 8. The chart called manual readings simulated

`SensorChart` showed *"Readings are simulated, not measured"* if **any** reading had `source: SIMULATED` — so once manual entry existed, an operator's own measurement was labelled as invented. It now distinguishes all / some / none, and says *"N of M readings are simulated; the rest were entered manually"* for a mixed series.

## 9. Dependency vulnerabilities — now zero in both projects

**Backend (3 moderate).** All from `qs`, pinned transitively by Express 4, so `npm audit fix` could not resolve it. Rather than force an Express 4 → 5 major upgrade for a DoS and a parsing bypass, an `overrides` entry pins `qs` to `^6.16.0`, which is API-compatible with what Express 4 expects. → **0 vulnerabilities.**

**Frontend (5 moderate, 1 high, 1 critical).**

| Package | Was | Now | Why |
|---|---|---|---|
| `vitest` | ^2.1.2 | ^3.2.7 | critical — arbitrary file read/execute via the UI server |
| `vite` | ^5.4.8 | ^7.3.6 | high — path traversal, `server.fs.deny` bypass |
| `react-router-dom` | ^6.26.2 | ^7.18.3 | moderate — open redirect leading to XSS |
| `@vitejs/plugin-react` | ^4.3.1 | ^5.2.0 | peer of vite 7 |
| `jsdom` | ^25.0.0 | ^30.0.1 | carried along |

The React Router 6 → 7 major was low-risk here because the app only uses the declarative API (`BrowserRouter`, `Routes`, `Route`, `Link`, `Navigate`, `useNavigate`, `useLocation`, `useParams`, `Outlet`), none of which changed. It also clears the v7 future-flag warnings that used to fill the test output. → **0 vulnerabilities**, 179/179 tests passing, build clean.

**Not changed: `recharts`.** npm warns that 2.x is deprecated, but a deprecation is not a vulnerability and `npm audit` reports nothing against it. A 2 → 3 upgrade rewrites chart internals and would touch every visualisation in the project; that deserves its own change with its own testing, not a quiet ride along with a security fix.

## 10. START_PROJECT.bat

**Root cause, visible in your own terminal output:** the project sat in `...\Project_AuditTrail_Team16_fixed (1)\...`. Batch parses a multi-line `if ( ... )` block by scanning for the closing bracket, so a path containing `)` closed the block early and the script died on a syntax error before starting anything. `%ProgramFiles(x86)%` — which carries a bracket in its own name — had the same problem. Windows names every second copy of a download `(1)`, so this was going to happen to anyone who downloaded the zip twice.

**Rewritten with no multi-line bracket blocks at all.** Every branch is a `goto` to a label, every path is quoted, and `%ProgramFiles(x86)%` is expanded only inside its own subroutine.

Also improved while there:

- `npm` is checked separately from `node` — they can be missing independently.
- Node's major version is checked against the required 20.11+, with a clear message instead of a confusing runtime error.
- **Dependencies install in the launcher window, not in the server terminals.** Previously a failed `npm install` scrolled past inside a window that immediately tried to start a server, so the real error was easy to miss. Now the launcher stops, says which project failed, and prints the two commands to run by hand.
- Install is skipped when `node_modules` is already populated, so a second run starts in seconds.

**Caveat:** this could not be executed on Windows from the analysis environment. It has been statically validated — no multi-line bracket blocks, no missing `goto` targets, CRLF line endings throughout — but please double-click it once and report anything that still trips.

---

## Files touched in round 2

| File | Change |
|---|---|
| `backend/src/application/queries/queryHandlers.js` | Reading-level metrics; null for unmeasured rates |
| `backend/src/application/queries/metricDefinitions.js` | Definitions for the three new metrics; corrected the pie's description |
| `backend/tests/integration/dashboardMetrics.test.js` | 3 new tests |
| `backend/package.json` | `overrides` pinning `qs` |
| `frontend/src/components/StatusDashboard.jsx` | Pie source, zero-label suppression, null handling, SSE refresh |
| `frontend/src/components/SensorChart.jsx` | Accurate provenance caption |
| `frontend/src/styles/dashboard.module.css` | `.chartCaption`, `.emptyChart` |
| `frontend/tests/statusDashboard.test.jsx` | 7 new tests; fixture extended |
| `frontend/package.json` | Security upgrades |
| `START_PROJECT.bat` | Rewritten |
