# Event Catalog

Served live at `GET /api/meta/event-catalog`, generated from the same constants
the reducer validates against — so this document cannot drift from the code the
way a hand-maintained catalog would.

**Aggregate:** `Shipment` · **Envelope schema version:** 1

## Event envelope

| Field | Source | Notes |
| --- | --- | --- |
| `aggregateId` | **required by source** | The shipment id |
| `eventType` | **required by source** | One of the types below |
| `payload` | **required by source** | Event-specific, documented per type |
| `timestamp` | **required by source** | ISO-8601 UTC, when the system recorded it |
| `version` | **required by source** | Per-aggregate sequence, starts at 1, gapless |
| `eventId` | recommended | UUID v4 |
| `aggregateType` | recommended | Always `Shipment` |
| `schemaVersion` | recommended | Enables upcasting on read instead of rewriting history |
| `correlationId` | recommended | Traces a browser action to a stored event |
| `causationId` | recommended | Which event/command caused this one |
| `actor` | design decision | Null until authentication exists |
| `previousHash` / `hash` | design decision | Tamper-evidence chain |
| `sequence` | design decision | Global monotonic counter; the worker's cursor |
| `recordedAt` | design decision | Wall-clock **write** time, set by the store. `timestamp` is when the event *occurred*; a command may set it via `occurredAt` when backfilling, and the two can always be compared. |

Version is the aggregate's event sequence:

```
CONTAINER_CREATED → v1
LOADED_ON_SHIP    → v2
TEMPERATURE_SPIKE → v3
ARRIVED_AT_PORT   → v4
```

## Event types

### `CONTAINER_CREATED` — *named by the source*

Always version 1. A stream can never contain a second one.

**Required:** `containerCode`, `origin`, `destination`
**Optional:** `cargoDescription`, `carrier`, `minTemperatureC`, `maxTemperatureC`

Reducer: state → `CREATED`, `currentLocation` = origin, temperature range stored.

### `LOADED_ON_SHIP` — *named by the source*

**Required:** `vesselName`, `location` · **Optional:** `voyageNumber`, `notes`

Reducer: state → `IN_TRANSIT`, location and vessel recorded.

### `TEMPERATURE_SPIKE` — *named by the source*

**Required:** `temperatureC`, `recordedAt` · **Optional:** `sensorId`, `thresholdC`, `direction`

Reducer: latest temperature updated, breach counter incremented, excursion flag
raised. **Lifecycle state deliberately unchanged** — see below.

### `ARRIVED_AT_PORT` — *named by the source*

**Required:** `portName`, `location` · **Optional:** `berth`, `notes`

Reducer: state → `AT_PORT`, arrival timestamp recorded.

### `TEMPERATURE_RECORDED` — *design decision*

An in-range reading. Added because the source requires visualising temperature
*fluctuations*, which is impossible if only breaches are stored.

**Required:** `temperatureC`, `recordedAt` · **Optional:** `sensorId`

### `UNLOADED_FROM_SHIP` — *design decision*

Completes the lifecycle. **Required:** `location` · **Optional:** `yardBlock`, `notes`

## Lifecycle

```
          CONTAINER_CREATED
                 ↓
             CREATED ──LOAD_ON_SHIP──► IN_TRANSIT
                                            │
                                     ARRIVE_AT_PORT
                                            ▼
                UNLOADED ◄─UNLOAD_FROM_SHIP─ AT_PORT
                    │                          │
                    └────LOAD_ON_SHIP──────────┘
```

Temperature events are legal in every state after creation and never change it.

Illegal transitions are rejected with `DOMAIN_RULE_VIOLATION`, so the recorded
history cannot describe a physically impossible journey — a container cannot
arrive at a port it was never shipped towards.

## Temperature policy

The source names `TEMPERATURE_SPIKE` but defines no threshold, no unit, no
duration and no business consequence. Rather than assume any of it:

| Question | Decision |
| --- | --- |
| Threshold source | `CONTAINER_CREATED.payload.minTemperatureC` / `maxTemperatureC`, per shipment |
| If unset | Every reading is `TEMPERATURE_RECORDED`. No breach is ever inferred. |
| Unit | Degrees Celsius |
| When classified | At write time, stored in the event |
| Lifecycle effect | **None.** The breach is recorded, not acted upon. |

The last row is the important one. Making a spike trigger a status change would
mean writing an unsourced business rule into an audit trail. The aggregate
records what happened and leaves interpretation to the logistics manager — which
is exactly the forensic posture the project argues for.

## Versioning strategy

Events are never rewritten. When a payload shape needs to change:

1. bump `EVENT_SCHEMA_VERSION`;
2. write new events at the new version;
3. upcast old ones **on read**, in the reducer.

A migration that rewrote stored events would be an immutability violation, and
the hash chain would detect it.

Corrections follow the same rule: you do not edit a wrong event, you append a
compensating one. That is a domain decision requiring its own event type, and
none is defined yet.
