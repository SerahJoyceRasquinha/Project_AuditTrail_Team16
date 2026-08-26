# Shipment Scheduling, Monitoring and Reporting

This document covers the changes made to turn the ledger's raw command surface
into a workable logistics screen **without** weakening the Event Sourcing
guarantees the project exists to demonstrate.

It is organised around the decisions that were genuinely contestable, because
those are the ones worth reviewing.

---

## 1. The central constraint

Every feature below had an easy CRUD implementation and a harder event-sourced
one. The easy version was rejected each time, for the same reason: the moment a
shipment has a mutable field, the claim "current state is derivable by replaying
history" stops being true, and the whole project collapses into a database with
a log next to it.

Three rules were applied throughout:

1. **A change is an event, not an edit.** Re-planning a date appends
   `SHIPMENT_SCHEDULE_REVISED` carrying both the old and new plan. Nothing is
   overwritten, so `GET /shipment/:id/state?at=…` before the revision still
   shows what was planned then.

2. **Anything time-dependent is derived, never stored.** "Overdue" is the clear
   example — see §4.

3. **The UI gets no privileged path.** The planner issues the same commands the
   HTTP API exposes, through the same validation, with the same optimistic
   concurrency check. Ticking a checkbox does not write an event; it dispatches
   `MoveShipment` and waits for the backend to accept it.

---

## 2. Shipment identifiers

**Format:** `SHP-1`, `SHP-2`, `SHP-3` — not zero-padded. Padding is a display
choice masquerading as an identifier: it caps the range implicitly and makes
`SHP-010` and `SHP-10` look different while sorting them as though they were.

**Allocation is atomic.** The obvious implementation — read the highest existing
number, add one — is a race condition with a friendly face: two requests in the
same millisecond both read the same maximum and both try to create `SHP-8`.
Instead, `ShipmentIdAllocator` increments a single counter document with
`findOneAndUpdate` + `$inc`, the same mechanism the Event Store already uses for
its global sequence. MongoDB serialises those, so every caller gets a number
nobody else got.

There is a test that fires twenty simultaneous creations and asserts twenty
distinct ids.

**Supplying an id is still allowed.** Backfilling a real history and seeding a
demonstration both need to name their own streams. The allocator skips ids that
are already taken, and `syncToExistingStreams()` advances the counter past a
restored dump at startup.

**The id is immutable.** It is absent from `AMENDABLE_FIELDS` and listed in
`IMMUTABLE_FIELDS`. Changing it would mean moving the stream, not correcting it.

---

## 3. Origin and destination

Free-text addresses are a problem for an audit ledger specifically: "Chennai,
IN", "chennai india" and "Chennai, Tamil Nadu" are one place to a human and
three to a query. A dispute about where a container was cannot be settled
against inconsistent strings.

The catalogue lives in the **domain layer** (`reference/locations.js`) and is
served to the browser at `GET /api/meta/locations`. One source, two consumers:
the dropdown cannot offer a pair the validator would refuse.

**Both representations are stored.** The event payload carries
`originLocation: { city, countryCode, stateCode, … }` *and* the flat `origin`
display string. Codes are stable and queryable; the string is what an auditor
reads in a PDF three years later without looking up what `IN-TN` meant.

**Backwards compatibility.** Replacing `origin`/`destination` with objects would
have broken replay of every existing stream. They were kept and the structured
fields added alongside, so old events still fold correctly — and the PDF marks
such locations "as recorded (free text)" rather than implying a validated
country/state pair they never had.

### Cities are a third, different level

Selection cascades **Country → State → City**, each level gated on the one above
it and cleared when it changes.

The city level is deliberately not enforced the way the other two are. Countries
and subdivisions come from ISO 3166 — a closed, authoritative set, so the
backend validates them exactly and rejects anything else. **Cities have no such
registry.** The curated list (`reference/cities.js`, 368 country/state keys, 943
cities, weighted towards ports and freight hubs) is genuinely useful and
genuinely incomplete.

So the city dropdown always offers **"Other — enter manually"**, and the backend
accepts unlisted cities. Refusing a real port because a data file did not happen
to list it would be a far worse failure than an inconsistent spelling. The
resolved location records `cityFromCatalogue: true|false`, so a report can say
how a value was entered without the validator claiming an authority it does not
have.

The city is stored as a plain string, exactly as before — the dropdown changes
how the value is *entered*, not what the ledger records.

Rules enforced on **both** sides:

| Rule | Error code |
|---|---|
| A state cannot be chosen before a country | `STATE_WITHOUT_COUNTRY` |
| A state must belong to its country | `STATE_NOT_IN_COUNTRY` |
| A country with subdivisions requires one | `STATE_REQUIRED` |
| A country with none must not be sent one | `STATE_NOT_IN_COUNTRY` |

---

## 4. Scheduling

### Events

| Event | Meaning |
|---|---|
| `SHIPMENT_SCHEDULE_PLANNED` | The first agreed schedule. One per stream. |
| `SHIPMENT_SCHEDULE_REVISED` | Dates changed before confirmation. Carries `previousSchedule`. |
| `SHIPMENT_SCHEDULE_EXTENDED` | A delay. Carries the plan before, the plan after, days, and reason. |

Confirmation still uses the source document's own `LOADED_ON_SHIP` /
`ARRIVED_AT_PORT` / `UNLOADED_FROM_SHIP`. The scheduling layer was built *around*
them, not instead of them.

### Overdue is derived, never stored

There is no `isOverdue` field in the Event Store, and nothing flips one. A stage
is overdue if its planned date has passed and its confirming event is absent —
computed from the stream and the current instant by `deriveStageStatuses`.

A stored flag would be wrong the moment the clock moved, and correcting it would
require a mutation. The read model *does* carry a snapshot for list sorting, but
`GET /shipment/:id` recomputes it against the real clock before answering; the
query is authoritative for that field, not the projection.

### The planning window

Opens on the creation day, closes on creation + `estimatedDurationDays`.
Widened only by an extension event — never silently.

`GET /shipment/:id/schedule` returns per-stage `bounds`, computed from the same
policy the aggregate validates with. The calendar narrows its pickers from those
numbers, so it cannot offer a date the server would refuse. That is convenience;
the guarantee is that a raw `POST` hits `validatePlannedDates` anyway.

### Extensions

The overdue stage moves by `extensionDays`; every later **unconfirmed** stage
shifts with it, preserving the gaps the planner chose rather than compressing
the remaining voyage. Confirmed stages never move — they are historical facts.
The estimated duration grows so the plan still fits its window, and never
shrinks.

`originalSchedule` and `originalEstimatedDurationDays` are captured once and
never written again, so "originally promised versus actually delivered" is
answerable from current state as well as by replay.

### Early completion

Confirming a stage emits **one** event. Pulling the rest of the voyage forward
is a separate decision, so it is a separate command
(`SHIPMENT_SCHEDULE_REVISED` with `reason: EARLY_COMPLETION`) and an auditor can
see that someone chose it.

This is a deliberate departure from a literal reading of the requirement, which
suggested automatic recalculation. Auto-appending a second event from one
command would have broken the codebase's strict one-command-one-event rule and
made the audit trail describe a decision nobody made.

---

## 5. Temperature monitoring

### The honesty problem

The requirement forbids fabricating readings. This project has no sensor
attached. Those are only compatible if invented data is **labelled as invented,
permanently and everywhere it surfaces**.

Every reading carries a `source` in its immutable payload:

- `SIMULATED` — generated by the deterministic model. Shown as "Simulated (not
  measured)" in the chart legend, the timeline and the PDF. Forever.
- `EXTERNAL` — from a real feed at `SENSOR_FEED_URL`.
- `MANUAL` — entered through the API. The default when a reading arrives without
  stating its origin, because a reading of unknown provenance must never be able
  to pass itself off as sensor data.

`SENSOR_SOURCE=none` records nothing at all.

### It issues commands, not writes

`TemperatureMonitorService` is constructed with the **command service**, not the
Event Store. An automatic reading takes the identical validated path a
hand-entered one takes: loaded, folded, version-checked, classified by the
aggregate against the declared range, appended. A background job with a private
door into the ledger would be exactly the hidden mutable shortcut this project
argues against.

### One reading, one event

The monitor never decides whether a reading is a breach — the aggregate emits
`TEMPERATURE_RECORDED` or `TEMPERATURE_SPIKE`. One reading therefore produces
exactly one event, which is also what satisfies "avoid duplicate alerts": there
is no second alerting pass that could fire twice.

### The monitoring window

Derived on every sweep from folded state: created, not yet unloaded, not
archived. A delivered shipment stops being sampled without anything switching a
flag off.

### Known constraint — forward fill only

Readings are only appended **forward of the stream head**. The command service
refuses an `occurredAt` earlier than the previous event, because an event
stamped before its predecessor would corrupt the time scrubber, the chart, and
any dispute about sequence.

The practical consequence: a heavily backfilled shipment will not retroactively
fill gaps behind events already written. In normal operation — sweeps every 60
seconds — this never arises. It is a deliberate trade: chronological integrity
over gap-filling convenience.

Catch-up after downtime is bounded by `SENSOR_MAX_CATCHUP` so a restart cannot
flood a stream.

---

## 6. Real-time updates

`GET /api/stream/shipments` is a server-sent event stream carrying
**notifications, not data**: "shipment SHP-4 reached version 9". The browser
responds by re-running the ordinary queries it already had, so the read model
stays the thing being read and CQRS is intact.

Notifications are published by the **projection worker after it commits**, not
by the command service at append time. Announcing earlier would guarantee the
client's refetch sometimes beats the projection and shows stale data — the exact
eventual-consistency glitch this project surfaces honestly rather than hides.

If the stream cannot connect, the hook reports `connected: false`, backs off,
gives up after five attempts, and the dashboard falls back to the polling it
used before. A dashboard that silently stops updating is worse than one that
polls.

---

## 7. The audit report

The previous export printed a diff of internal state at every version —
`temperatureBreachCount: 0 → 1`, `currentState: "IN_TRANSIT" → "AT_PORT"`. Every
fact was in there and none of it was legible to the person the report is for.

The rewrite is organised for a reader who has never seen the schema, in ten
sections: identification, route, current status, creation and duration,
lifecycle schedule, schedule changes, temperature monitoring, alerts, complete
history, verification statement.

Four things it is careful about:

- **It never implies stored state where there is reconstructed state.** The
  status panel is headed "reconstructed by replaying N records", because that is
  what it is.
- **Plans and facts are visually separated** — "Originally planned", "Currently
  planned" and "Actually confirmed" are distinct columns.
- **Simulated readings are labelled** in the section header and the row.
- **It stays readable at length.** Tables repeat headers across page breaks, row
  heights are measured from wrapped content rather than assumed, and long
  temperature series keep every alert in full while thinning in-range readings —
  the alerts are the forensically interesting part.

Internal event types are retained alongside the business labels, because a
dispute turns on them.

---

## 8. What was deliberately *not* built

Stated plainly, because a reviewer should not have to infer it:

- **Authentication.** The codebase explicitly scopes auth out. Rather than
  inventing a parallel auth system, the existing `actor` field is left ready to
  populate, and there is a test asserting no endpoint accepts an arbitrary event
  type and payload. Clients express business intent; the backend decides what
  gets stored.
- **A stored overdue flag.** See §4.
- **Automatic schedule recalculation on early completion.** See §4.

---

## 9. Bugs found while doing this

1. **Lifecycle sequence hole.** `move()` rejected `LOAD_ON_SHIP` only when the
   shipment was `IN_TRANSIT`, so a container could be loaded again after
   arriving or after being discharged — producing a stream describing a journey
   no physical container took. It now requires `CREATED`.

2. **Broken integrity test.** `tests/api/export.test.js` tampered with a
   collection named `events`; the real collection is `shipment_events`. Nothing
   was modified, the chain verified intact, and the assertion failed. The test
   was wrong, not the integrity check. This was failing before any of this work
   began.

3. **Non-deterministic replay** (introduced during this work, then fixed).
   `confirmedStages` briefly carried the confirming event's random `eventId`,
   which meant two databases fed identical commands reconstructed different
   states — breaking the guarantee that state is a pure function of history.
   It now stores `version`, which identifies the event deterministically.

---

## 10. Test coverage

| Suite | Count |
|---|---|
| Backend total | 223 |
| — schedule policy, duration, locations, normalisation (unit) | 32 |
| — scheduling, ID allocation, OCC, security (integration) | 33 |
| — temperature monitoring and reporting (integration) | 18 |
| Frontend total | 71 |

Notable cases: twenty concurrent creations yielding twenty distinct ids; a stale
version rejected on stage confirmation; two simultaneous confirmations where
exactly one wins; time-scrubbing before a revision showing the original plan; a
300-reading history producing a paginated PDF; and backend rejection of
country/state pairs posted directly, bypassing the UI entirely.
