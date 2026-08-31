# Troubleshooting

Organised by symptom.

## The backend will not start

**`Could not connect to MongoDB after 5 attempts`**

The connection is retried with backoff before giving up, so this means MongoDB
was unreachable for several seconds.

```bash
mongosh --eval 'db.runCommand({ping:1})'   # is it running at all?
```

Check in order: the `mongod` process, `MONGODB_URI` in `.env`, credentials,
network/firewall, and whether the user has rights on `audit_trail`. The error
message deliberately never includes the URI, because it may contain a password —
so read the URI from your `.env`, not from the log.

To get moving without solving it: `PERSISTENCE=memory npm start`.

**`Missing required environment variable`** — copy `.env.example` to `.env`.

**`EADDRINUSE`** — something is already on port 4000. `PORT=4001 npm start`.

## A command fails

**409 `CONCURRENCY_CONFLICT`** — working as designed. Someone else appended an
event since you loaded the shipment. The response names both versions; reload and
resubmit against `currentVersion`. Nothing was written.

**409 `DOMAIN_RULE_VIOLATION`** — the command is well-formed but illegal for the
current state, e.g. arriving at a port without having been loaded. Check
`details.currentState` against the lifecycle in the event catalog.

**400 `VALIDATION_ERROR`** — `details.issues` lists every problem at once. The
common ones: missing `expectedVersion`, `expectedVersion` sent as a string
(rejected rather than coerced, deliberately), a one-sided temperature range.

**404 `AGGREGATE_NOT_FOUND`** — no event stream for that id. Create the shipment
first, or check for a typo.

## The dashboard shows "Synchronising" and it never clears

The projection worker is not consuming events.

```bash
curl localhost:4001/api/meta/worker
```

Read `worker.running`, `lag.behindBy` and `deadLetters`.

- `running: false` and `WORKER_IN_PROCESS=false` → start it: `npm run start:worker`
- `deadLetters > 0` → events failed projection repeatedly. Inspect the
  `projection_dead_letters` collection: it holds the event id, version and error.
  Fix the cause, then `npm run rebuild:readmodel`.
- `behindBy` large and falling → it is catching up. Wait.

Note the data on screen is still correct throughout — it is being replayed from
the Event Store, which is authoritative.

## The read model disagrees with the events

The Event Store wins, always.

```bash
npm run rebuild:readmodel -- --check   # report drift, change nothing
npm run rebuild:readmodel              # destroy and rebuild from history
```

This is always safe. Nothing in the read model is a source of truth.

## Integrity check reports a broken chain

Someone modified `shipment_events` outside the application — the check is
working. `issues` tells you which events and how:

| Issue | Meaning |
| --- | --- |
| `CONTENT_TAMPERED` | A field was edited after the event was written |
| `BROKEN_LINK` | `previousHash` no longer matches its predecessor |
| `VERSION_GAP` | An event was removed from the middle of the stream |

There is no repair path, and that is the point. Restore the collection from
backup. Then apply the least-privilege role in
[`DATABASE.md`](database/DATABASE.md) so the application account cannot update or
remove events at all.

## Replay produces the wrong state

Check in this order: event ordering (must be ascending by version — `replay()`
throws rather than guess), the reducer's case for the event type, the payload
fields the reducer reads, and the initial state.

An `unknown event type` error is intentional: roadmap 10.5 requires unexpected
events to fail loudly rather than be skipped, because silently skipping is how a
projection drifts without anyone noticing.

## The frontend cannot reach the API

"Cannot reach the API" means the request never got a response.

1. Is the backend up? `curl localhost:4001/health`
2. In development, vite proxies `/api` — restart `npm run dev` after changing
   `vite.config.js`.
3. If serving the frontend from another origin, set `CORS_ORIGIN` on the backend
   **and** `VITE_API_BASE_URL` on the frontend.
4. Check the browser network panel for the status code, and match the
   `x-correlation-id` against the backend logs.

## The chart and the timeline seem misaligned

They should not be able to be: both derive from the same events and plot the same
`epoch` value, and each chart point carries the `eventId` it came from. If they
disagree, check that the sensor request carried the same `at` bound as the state
request — a live series beside a historical state is the one way this can look
wrong.

## Tests

**A test hangs** — usually an unclosed HTTP server. Each API test registers
`t.after` cleanup; make sure any new one does too.

**Recharts logs a width/height warning under vitest** — expected. jsdom has no
layout engine, so the responsive container measures zero. Cosmetic only.

**`npm test` cannot find MongoDB** — it should not need it. Tests force
`PERSISTENCE=memory` in `tests/helpers/testSystem.js`.
