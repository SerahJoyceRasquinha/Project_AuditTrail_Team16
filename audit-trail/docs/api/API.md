# API Reference

Base URL: `http://localhost:4001/api`

Commands and queries are served by **separate Express routers**, mounted under
the same `/api` prefix. That matches the source document literally: "Create
separate routers for Commands (e.g., `POST /shipment/move`) and Queries (e.g.,
`GET /shipment/:id`)". The separation lives in the routers, not the URLs.

Every response carries `x-correlation-id`; command responses also carry
`x-cqrs-side: command`, queries `x-cqrs-side: query`.

---

## Authentication

Every endpoint below requires a session **except** `register` and `login`, which
are how one is obtained. Send the token as `Authorization: Bearer <token>`. A
missing or invalid token is **401**; a valid token whose account lacks the role
for a command is **403**.

Two roles exist and only two: `operator` may issue commands, `user` is strictly
read-only. There is no administrator. A role is chosen once at registration and
no endpoint can change it afterwards.

The role is read from the **stored account record on every request**, never from
the token body, so a token cannot assert authority its account does not have.

### `POST /api/auth/register`

```json
{
  "username": "jdoe",
  "password": "a-password-of-8-or-more",
  "confirmPassword": "a-password-of-8-or-more",
  "displayName": "J. Doe",
  "role": "operator"
}
```

`role` defaults to `user` and must be `operator` or `user`; anything else is
**400**. `confirmPassword` is only checked when supplied, so an API client is not
forced to send a field that exists for the registration form.

**201** — `{ "created": true, "user": { "username", "displayName", "role", "createdAt" }, "message": "…" }`

**Registering does not sign you in.** No token is issued here, deliberately:
creating an account and proving you hold its credentials are two operations, and
collapsing them means the chosen password is never actually checked against what
was stored. A caller who wants a session sends the new credentials to
`/api/auth/login`, which is the only endpoint that issues one. The frontend does
exactly this — the registration form redirects to the sign-in page.

**409 `USERNAME_TAKEN`** if the name is in use.

### `POST /api/auth/login`

```json
{ "username": "jdoe", "password": "a-password-of-8-or-more" }
```

**200** — `{ "token": "…", "user": { … } }`. This is the only response in the API
that carries a session token.

**401 `INVALID_CREDENTIALS`** for both a wrong password and a username that does
not exist, with the identical message and comparable timing, so the endpoint
cannot be used to discover which accounts are real.

### `GET /api/auth/me`

**200** — `{ "user": { … } }`, re-derived from the stored account. This is what
lets a page refresh restore a session without the frontend trusting anything it
stored locally: editing `localStorage` changes nothing that matters.

The password hash and salt never appear in any of these responses.

### Demo accounts

Set `AUTH_SEED_DEMO_ACCOUNTS=true` to create `operator` / `operator123` and
`viewer` / `viewer123` at startup, which are the two the sign-in page offers as
one-click access. They are created through the ordinary registration path, so
they get the same hashing and the same role rules as any other account, and an
existing account sharing a username is never overwritten.

Off by default — their passwords are published, so they must never appear in a
deployment by accident.

---

## Commands (write side)

### `POST /api/shipment/create`

Creates a shipment stream. Emits `CONTAINER_CREATED` at version 1.

`shipmentId` is **optional**. Omitting it - which is what the dashboard does -
asks the server to allocate the next `SHP-N` from an atomic counter. Supplying
one is still permitted so a backfill or a seed can name its own streams.

`origin` and `destination` take a **structured location**, resolved against the
same country/subdivision catalogue the form's dropdowns are built from
(`GET /api/meta/locations`), so a pair the UI offers is by construction a pair
the backend accepts:

```json
{
  "containerCode": "MSKU7845123",
  "origin":      { "countryCode": "IN", "stateCode": "TN", "city": "Chennai" },
  "destination": { "countryCode": "NL", "stateCode": "ZH", "city": "Rotterdam" },
  "estimatedDurationDays": 21,
  "cargoDescription": "Pharmaceutical cold chain",
  "carrier": "Maersk Line",
  "minTemperatureC": 2,
  "maxTemperatureC": 8
}
```

A plain string (`"origin": "Chennai, IN"`) is still accepted for the backfill and
seed paths. When one is given the free-text value is stored as-is and no
normalised location object is produced, so the PDF shows the location "as
recorded" rather than implying a validated country/state pair it never had.

`estimatedDurationDays` is **required** - a positive whole number of days. It
defines the planning window that `schedule/plan` validates against.

`containerCode` is normalised on the backend before it reaches the aggregate:
whitespace stripped, upper-cased. `"  msku 784 5123 "` is stored as
`"MSKU7845123"`.

`minTemperatureC` / `maxTemperatureC` are optional but must be supplied **both or
neither** — a one-sided range cannot classify a breach. If omitted, no reading is
ever classified as a spike for this shipment.

**201**

```json
{
  "accepted": true,
  "aggregateId": "SHP-1001",
  "eventId": "9f1c…",
  "eventType": "CONTAINER_CREATED",
  "version": 1,
  "timestamp": "2026-08-16T09:12:44.113Z",
  "correlationId": "…",
  "hash": "3ab9…",
  "readModelConsistency": "eventual"
}
```

### `POST /api/shipment/move`

The command named by the source document.

```json
{
  "shipmentId": "SHP-1001",
  "movementType": "LOAD_ON_SHIP",
  "location": "Chennai Port, Berth 4",
  "vesselName": "MV Ganges Star",
  "voyageNumber": "VY-2291",
  "expectedVersion": 1
}
```

| `movementType` | Emits | Requires | Legal from |
| --- | --- | --- | --- |
| `LOAD_ON_SHIP` | `LOADED_ON_SHIP` | `vesselName` | `CREATED`, `AT_PORT`, `UNLOADED` |
| `ARRIVE_AT_PORT` | `ARRIVED_AT_PORT` | `portName` | `IN_TRANSIT` |
| `UNLOAD_FROM_SHIP` | `UNLOADED_FROM_SHIP` | — | `AT_PORT` |

### `POST /api/shipment/temperature`

```json
{
  "shipmentId": "SHP-1001",
  "temperatureC": 11.8,
  "recordedAt": "2026-08-16T04:30:00.000Z",
  "sensorId": "REEFER-01",
  "expectedVersion": 2
}
```

Emits `TEMPERATURE_SPIKE` if the reading falls outside the range declared at
creation, otherwise `TEMPERATURE_RECORDED`. The classification is decided at
write time and stored in the event, so changing a threshold later cannot
retroactively reclassify past readings.

`recordedAt` is when the sensor sampled; the event `timestamp` is when the event
occurred. Both are kept.

### `POST /api/shipment/amend`

Corrects the manifest details declared at creation. Emits
`SHIPMENT_DETAILS_AMENDED`. **The `CONTAINER_CREATED` event is not touched** —
this appends a new event describing what changed.

```json
{
  "shipmentId": "SHP-1001",
  "destination": "Hamburg, DE",
  "carrier": "Hapag-Lloyd",
  "reason": "Consignee redirected the container",
  "expectedVersion": 4
}
```

Amendable fields: `containerCode`, `origin`, `destination`, `cargoDescription`,
`carrier`, `minTemperatureC`, `maxTemperatureC`. Send only what changes; an
omitted field is *not amended*, and an empty string is treated the same way
rather than as a request to blank a stored value.

`shipmentId` is never amendable — it is the aggregate identity, and changing it
would mean moving the stream rather than correcting it.

Refused with **409 `DOMAIN_RULE_VIOLATION`** if the amendment would change
nothing, or if the shipment is archived. `expectedVersion` is **required**: an
amendment is exactly the kind of edit OCC exists to protect.

**200** — same envelope as `move`, with `"eventType": "SHIPMENT_DETAILS_AMENDED"`.

### `POST /api/shipment/schedule/plan`

Records the first tentative schedule for the three lifecycle stages.

```json
{
  "shipmentId": "SHP-1",
  "expectedVersion": 1,
  "schedule": {
    "LOAD_ON_SHIP":     { "plannedDate": "2026-03-03", "details": { "vesselName": "MV Ganges Star" } },
    "ARRIVE_AT_PORT":   { "plannedDate": "2026-03-14", "details": { "portName": "Port of Rotterdam" } },
    "UNLOAD_FROM_SHIP": { "plannedDate": "2026-03-16", "details": { "yardBlock": "D7" } }
  }
}
```

Emits `SHIPMENT_SCHEDULE_PLANNED`. Only one per stream — later changes are
revisions, so the original commitment stays readable.

Dates are `YYYY-MM-DD` UTC calendar days and must fall inside the planning
window (creation day → creation + `estimatedDurationDays`) and follow lifecycle
order. Both rules are enforced here regardless of what the UI allowed.

**409 codes:** `BEFORE_SHIPMENT_CREATION`, `OUTSIDE_PLANNING_WINDOW`,
`STAGE_ORDER_VIOLATION`, `STAGE_ALREADY_CONFIRMED`.

---

### `POST /api/shipment/schedule/revise`

Changes tentative dates for stages that have not yet been confirmed. Same body
as `plan`, plus an optional `reason` (`REPLAN` | `DELAY_EXTENSION` |
`EARLY_COMPLETION`).

Emits `SHIPMENT_SCHEDULE_REVISED`, carrying `previousSchedule` alongside the new
one so the change is legible from a single event. A revision that changes
nothing is refused; a confirmed stage can never be re-planned.

---

### `POST /api/shipment/schedule/extend`

Records a delay against an overdue stage.

```json
{
  "shipmentId": "SHP-1",
  "stage": "LOAD_ON_SHIP",
  "extensionDays": 3,
  "reason": "Port congestion at origin",
  "expectedVersion": 2
}
```

Emits `SHIPMENT_SCHEDULE_EXTENDED`. The stage moves by `extensionDays` and every
later *unconfirmed* stage shifts with it; confirmed stages never move. The
estimated duration grows so the plan still fits its window, and never shrinks.

`extensionDays` must be a positive whole number — zero, negatives, decimals and
text are all rejected with 400.

---

### `POST /api/shipment/archive`

The closest thing this API has to "delete", and deliberately not close. Emits
`SHIPMENT_ARCHIVED`, which withdraws the shipment from the default active
listing. **No event is removed.** The stream, its hash chain, its timeline and
its time scrubber all remain fully available, and `GET /api/shipment/:id`
continues to serve it.

```json
{ "shipmentId": "SHP-1001", "reason": "Claim settled", "expectedVersion": 5 }
```

An archived shipment refuses further `move`, `temperature` and `amend` commands
with **409 `DOMAIN_RULE_VIOLATION`** until it is restored.

### `POST /api/shipment/restore`

Emits `SHIPMENT_RESTORED` and returns the shipment to the active listing. Note
that this *appends* — it does not remove the `SHIPMENT_ARCHIVED` event. An
archival that could be undone by deletion would defeat the point of the ledger.

```json
{ "shipmentId": "SHP-1001", "reason": "Dispute reopened", "expectedVersion": 6 }
```

There is no `PUT` and no `DELETE` anywhere in this API. Editing and removing a
shipment are commands that append events, exactly like moving one.

### `occurredAt` — optional, on all commands

When the event happened in the real world, as distinct from when the system
recorded it. Defaults to now.

It exists for **backfilling**: importing a shipment's existing history, or
seeding a demonstration dataset whose events span days. Without it, every
imported event would be stamped with the import time, collapsing the timeline
into a single instant and leaving the time scrubber with nothing to move across.

Two safeguards, because a backdating facility in an audit system needs them:

- the Event Store independently records its own wall-clock `recordedAt` on every
  document, so a claimed event time and the actual write time can always be
  compared;
- an `occurredAt` earlier than the shipment's previous event is rejected with
  `VALIDATION_ERROR`. Version already fixes replay order, but a timestamp
  contradicting that order would corrupt every time-based reading of the ledger.

---

## Queries (read side)

### `GET /api/shipment/:id`

The endpoint named by the source. Returns the projection, plus an explicit
statement of read-side consistency.

```json
{
  "shipment": { "aggregateId": "SHP-1001", "currentState": "AT_PORT", "currentVersion": 10, "…": "…" },
  "consistency": {
    "source": "read-model",
    "projected": true,
    "storeVersion": 10,
    "projectedVersion": 10,
    "lagVersions": 0
  }
}
```

When the worker is behind, `source` becomes `event-store-replay` and `projected`
is `false`. The data is still correct — it was rebuilt from the authoritative
store — and the client is told so rather than being served silently stale data.

### `GET /api/shipment/:id/events`

The raw stream, ascending by version. This is what the timeline renders; clients
must not re-sort it.

### `GET /api/shipment/:id/state?at=<ISO-8601>`

Historical reconstruction — the scrubber's backend. The `at` boundary is
**inclusive**.

| Situation | `boundary` | Notes |
| --- | --- | --- |
| Before the first event | `BEFORE_FIRST_EVENT` | `existedAt: false`, `state: null` |
| Exactly on an event | `EXACTLY_ON_EVENT` | That event is included |
| Between events | `BETWEEN_EVENTS` | State after the most recent preceding event |
| At or after the last | `AT_OR_AFTER_LAST_EVENT` | `isCurrent: true` |

### `GET /api/shipment/:id/sensors[?at=<ISO-8601>]`

Temperature series for Recharts. Derived from the same events as the timeline, so
the chart and the timeline share one temporal coordinate system. Every reading
carries the `eventId` and `version` it came from.

Pass `at` to truncate the series to the same instant as a reconstructed state, so
a live temperature can never appear beside a historical state.

### `GET /api/shipment/:id/schedule`

The planner's read endpoint: the plan, each stage's status derived against the
current instant, and the per-stage `bounds` the calendar must respect.

```json
{
  "planned": true,
  "window": { "earliest": "2026-03-01", "latest": "2026-03-21" },
  "plan": { "LOAD_ON_SHIP": { "plannedDate": "2026-03-03", "originalPlannedDate": "2026-03-03" } },
  "stages": [
    { "stage": "LOAD_ON_SHIP", "status": "OVERDUE", "overdueByDays": 5, "isBlocked": false }
  ],
  "bounds": { "ARRIVE_AT_PORT": { "selectable": true, "min": "2026-03-03", "max": "2026-03-21" } },
  "isOverdue": true
}
```

`bounds` are computed from the same policy that validates the command, so the
browser's date pickers cannot offer a date the server would refuse.

Stage statuses: `CONFIRMED`, `IN_PROGRESS`, `PLANNED`, `OVERDUE`, `UNPLANNED`.
**None of them is stored** — see `docs/architecture/SCHEDULING_AND_MONITORING.md`.

---

### `GET /api/stream/shipments[?shipmentId=SHP-1]`

Server-sent events. Carries *notifications*, not data:

```
event: shipment
data: {"aggregateId":"SHP-1","eventType":"LOADED_ON_SHIP","version":5}
```

The client re-runs its ordinary queries in response. Published by the projection
worker **after** it commits, so a refetch triggered by a notification finds the
read model already able to serve it. Disable with `REALTIME_ENABLED=false`; the
dashboard falls back to polling.

---

### `GET /api/shipment/:id/integrity`

Hash-chain verification. `intact: true/false` plus any `issues`
(`CONTENT_TAMPERED`, `BROKEN_LINK`, `VERSION_GAP`).

### `GET /api/shipment/:id/export?format=csv|pdf`

Downloads a stream of the full shipment event history as a file, along with a human-readable diff of payload changes and the current integrity statement. Returns headers for file download in the browser.

### `GET /api/shipment/:id/reconciliation`

Compares the projection against a fresh replay. Reports `consistent` and any
field-level `discrepancies`. The Event Store is always treated as authoritative.

### `GET /api/shipments?page=&pageSize=&state=&search=&view=`

Paginated dashboard list from the read model.

---

`view` selects the archival slice and defaults to `active`:

| `view` | Returns |
| --- | --- |
| `active` *(default)* | Shipments that are not archived |
| `archived` | Archived shipments only — with their history fully intact |
| `all` | Everything |

An unrecognised value falls back to `active` rather than erroring: silently
listing archived shipments would be the more surprising outcome.

## Meta and operations

### `GET /api/meta/locations`

The country/subdivision/city catalogue the address dropdowns are built from,
served from the same module the create validator checks against. Cached for a
day (~32 KB).

Each subdivision carries a `cities` array; countries without subdivisions carry
theirs at the country level. City lists are **curated suggestions, not a closed
set** — the backend accepts a city that is absent from them, and the resolved
location records `cityFromCatalogue` so a report can say how the value was
entered.

### `GET /api/meta/sensors`

What the temperature monitor is doing, and — stated plainly, because it changes
how the numbers should be read — whether its data is simulated.

The response includes `monitor.monitoredShipmentIds` (the shipments this process
currently holds a monitor for), `monitor.scheduledReadings` (when each one's next
observation is due) and `monitor.firstReadingDelayMs`. Between them they answer
the two questions worth asking of a background job: is this shipment being
sampled, and is it being sampled exactly once.

**The monitoring cadence.** A shipment is monitored from creation until it is
unloaded, and never while archived. Its first reading is taken
`SENSOR_FIRST_READING_DELAY_MS` after creation (one minute by default) and every
later one `SENSOR_INTERVAL_MS` after the reading before it (one hour). Both are
derived from the shipment's own event stream rather than stored anywhere, so a
restarted backend resumes the same schedule instead of starting a new one — and
a slot that already has a reading is never due again.


| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness, database and worker status |
| `GET /api/meta/event-catalog` | The event catalog, served from the same constants the reducer validates against |
| `GET /api/meta/worker` | Checkpoint, stats, dead letters and current projection lag |

---

## Errors

Every error uses the same envelope:

```json
{
  "error": { "code": "CONCURRENCY_CONFLICT", "message": "…", "details": { } },
  "correlationId": "…"
}
```

| Code | Status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Malformed command. `details.issues` lists every problem at once. |
| `MALFORMED_JSON` | 400 | Body is not valid JSON. |
| `AGGREGATE_NOT_FOUND` | 404 | No event stream for that id. |
| `ROUTE_NOT_FOUND` | 404 | No such route. |
| `CONCURRENCY_CONFLICT` | 409 | Stale `expectedVersion`. Nothing was written. |
| `DOMAIN_RULE_VIOLATION` | 409 | Structurally valid but illegal for the current state. |
| `IMMUTABILITY_VIOLATION` | 403 | An attempt to mutate the Event Store. |
| `RATE_LIMITED` | 429 | Command rate limit exceeded. |
| `INTERNAL_ERROR` | 500 | Unexpected defect. Logged in full server-side; the client gets no stack trace. |

### Concurrency conflict detail

```json
{
  "error": {
    "code": "CONCURRENCY_CONFLICT",
    "details": {
      "aggregateId": "SHP-1001",
      "expectedVersion": 5,
      "currentVersion": 6,
      "applied": false,
      "remediation": "Reload the shipment and resubmit the command against the current version."
    }
  }
}
```

`applied: false` is stated explicitly so a client never has to guess whether a
rejected command left a partial write. It did not.
