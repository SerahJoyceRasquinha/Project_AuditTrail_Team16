# Changes

Two problems, fixed at their causes, plus the theme work that goes with them.

## 1. Registration signed people in

`AuthService.register` ended by issuing a session token, the route returned it,
and `AuthContext.register` passed it to the same `adopt()` that login uses. So an
account was authenticated the moment the form submitted, and the chosen password
was never checked against what had been stored.

Registration now returns `{ created: true, user, message }` and nothing else. The
form redirects to `/login`, carrying the username (not the password) so it can be
prefilled, and the sign-in page says the account was created and one step remains.
Validation, scrypt hashing, per-field errors and the permanent-role rule are all
untouched. Because nothing is written to storage, refreshing straight after
registering leaves you signed out — which was the point.

`scripts/seedHttp.js` now registers and then signs in, like any other caller.

## 2. The Temperature section was empty

Not a display problem. `TemperatureMonitorService` anchored observation slots to
whole hours: the first was `floor(createdAt / 1h) + 1h`. A shipment created at
14:05 therefore had no reading until 15:00, and with `PERSISTENCE=memory` a
restart cleared it first — so in any normal session the chart had nothing to draw.
The rest of the pipeline was intact and is unchanged.

The schedule is now derived from the stream as: **first reading
`SENSOR_FIRST_READING_DELAY_MS` after creation (60s), every later one
`SENSOR_INTERVAL_MS` after the reading before it (1h)**. Monitoring runs from
creation until the shipment is unloaded, and never while archived.

Alongside that, the monitor gained an explicit per-shipment lifecycle:

* it subscribes to the existing notification bus, so a shipment created through
  the API is adopted as soon as its creation projects — no manual start, no seed
  script;
* `resumeActiveShipments()` at startup adopts active shipments and skips
  completed ones, so a restart resumes rather than restarts;
* the sweep remains as the safety net for anything created while this process was
  down or while the bus was unavailable;
* `stop()` now interrupts the idle period between sweeps, so shutdown is
  immediate instead of waiting out the interval.

**Duplicate prevention has four independent layers.** Slot derivation is the one
that matters: a slot already on the stream is never due again, so re-sweeping,
restarting, or processing the same event twice cannot duplicate an observation.
Above it: one entry and one timer per shipment in `#monitored`, an in-flight guard
so the timer and the sweep never sample the same shipment at once, and optimistic
concurrency in the command service, where the loser yields.

Nothing bypasses the ledger. Every automatic reading is issued as an ordinary
`recordTemperature` command, classified by the aggregate into
`TEMPERATURE_RECORDED` or `TEMPERATURE_SPIKE`, appended with a version and a hash,
projected, and published to the realtime stream by the projection worker after it
commits. No new event type was needed and no historical event is touched.

## 3. Light theme, header and metrics dashboard

`.app__header` painted `rgba(11, 19, 28, 0.92)` in both themes while its text used
`--paper`, which is dark in Light mode. Fixed at the variable, not the element:
new `--header-bg`, `--surface-translucent`, `--overlay` and `--on-signal` tokens,
plus darkened light-theme signal colours (the dark-theme teal sits near 2:1 on
white). Hover, focus, `aria-current` and disabled states are covered explicitly.

`dashboard.module.css` carried a palette of its own — a blue-grey page gradient,
white cards, a purple summary banner — which is why the metrics page looked like a
different application. It now builds on the same tokens as everything else. The
layout is unchanged; only the colours moved.

`SensorChart` and `StatusDashboard` each held a private list of hex codes. Both now
draw from one `useChartPalette()`, which resolves against the active theme. SVG
attributes cannot resolve CSS variables, so this small JS mirror of the tokens is
unavoidable — but there is now one of it rather than two.

The tentative-date pickers in the lifecycle planner carry
`input--calendar-white`, which inverts the native indicator to white over a dark
control face so it stays legible in both themes. Scoped deliberately: the ledger's
date filters keep the browser's ordinary icon. The component is not replaced.

## 4. Empty and loading states

"No sensor readings" was technically true and actively misleading for a shipment
created thirty seconds earlier. The chart now distinguishes three cases: the first
reading is still pending (and says roughly how long, and that nothing needs
refreshing), the scrubber is parked before any reading exists, or monitoring has
ended. A pill beside the panel title shows whether the shipment is still being
sampled.

## Verification

`backend/scripts/verifyTemperatureFlow.js` walks the whole sequence over real
HTTP against a running server: register → protected route still closed → sign in →
create → monitoring adopted exactly once → first reading arrives on its own →
event is in the immutable history with the hash chain intact → complete the
shipment → monitoring stops.

Run against the shipped defaults, the first reading landed exactly 60 seconds
after creation, reached an SSE subscriber with no polling, and the next was
scheduled for exactly one hour later.

Backend 276 tests, frontend 137. Both suites pass.
