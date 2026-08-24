# API Reference

Base URL: `http://localhost:4000/api`

Commands and queries are served by **separate Express routers**, mounted under
the same `/api` prefix. That matches the source document literally: "Create
separate routers for Commands (e.g., `POST /shipment/move`) and Queries (e.g.,
`GET /shipment/:id`)". The separation lives in the routers, not the URLs.

Every response carries `x-correlation-id`; command responses also carry
`x-cqrs-side: command`, queries `x-cqrs-side: query`.

---

## Commands (write side)

### `POST /api/shipment/create`

Creates a shipment stream. Emits `CONTAINER_CREATED` at version 1.

```json
{
  "shipmentId": "SHP-1001",
  "containerCode": "MSKU7845123",
  "origin": "Chennai, IN",
  "destination": "Rotterdam, NL",
  "cargoDescription": "Pharmaceutical cold chain",
  "carrier": "Maersk Line",
  "minTemperatureC": 2,
  "maxTemperatureC": 8
}
```

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

### `GET /api/shipment/:id/integrity`

Hash-chain verification. `intact: true/false` plus any `issues`
(`CONTENT_TAMPERED`, `BROKEN_LINK`, `VERSION_GAP`).

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
