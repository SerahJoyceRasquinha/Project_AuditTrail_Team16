# Documented Enhancements

Deliberately **not** implemented. Each is listed with what it would buy and what
it would cost, so the omissions are choices rather than gaps.

## Cryptographic strengthening

The hash chain gives tamper *evidence* against edits and deletions. It does not
defend against an attacker with write access recomputing the whole chain.

- **Event signing.** Sign each event's hash with a private key the database
  server does not hold. Rewriting history would then require the key, not just
  database access. Cost: key management, rotation, and a signing service.
- **External anchoring.** Periodically publish the head hash somewhere outside
  the database — a second system, a notary, a public ledger. Cheap and effective:
  it bounds how far back an attacker can rewrite. This is the highest
  value-per-effort item on this list.

Until one of these exists, the code and docs say "tamper-evident", never
"tamper-proof".

## Snapshotting

Store a state snapshot every N events; replay only from the last one. Turns
replay from O(events) into O(events since snapshot). Not implemented because no
shipment in this domain plausibly reaches the ~10,000 events where it starts to
matter, and snapshots add a cache-invalidation problem that is easy to get
subtly wrong.

## Change streams

Replace worker polling with MongoDB change streams for lower projection latency.
Requires a replica set, which would stop the project running against a standalone
`mongod`. Only `#fetchBatch` would change.

## Authentication and authorisation

Out of scope per roadmap 26. The groundwork is present: every event carries a
null `actor` field. Adding auth means populating it at the API boundary. Any
authorisation layer must not acquire the ability to modify the Event Store.

## Distributed rate limiting

The current limiter is in-process, so limits are per-instance. A multi-instance
deployment would move the counter to Redis.

## Compensating events

The correct way to fix a wrong event is to append a correcting one, never to edit
it. Doing this properly needs domain decisions the source does not make — what a
correction means, who may issue one, how the timeline renders a corrected event —
so no correction event type is defined.

## Frontend scale

Event lists render in full. Past a few thousand events per shipment, the timeline
would want virtualisation and the events endpoint would want cursor pagination.
Both are straightforward; neither is justified at current data volumes.
