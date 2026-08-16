# Demonstration Script

About ten minutes. Assumes `npm run seed` has run and both processes are up.

The narrative arc: *this is not CRUD → history is real → history is provably
intact → history can be replayed → the read model is derived → concurrency is
safe.*

---

## 1. The architecture (1 min)

Show the two routers side by side —
`interfaces/http/commandRoutes/` and `queryRoutes/` — then
`app/dependencies.js`, the single place the object graph is wired.

> "Commands and queries never share a handler. The command side cannot read the
> projection; the query side cannot append an event."

## 2. Build a history (2 min)

On the dashboard, open `SHP-1004` (created, no movements yet). Using the command
panel, walk the source document's exact sequence:

1. **Load on ship** → `LOADED_ON_SHIP`
2. **Record temperature** `4.5` → `TEMPERATURE_RECORDED`
3. **Record temperature** `13.0` → the form warns it is outside the agreed range;
   submit → `TEMPERATURE_SPIKE`
4. **Arrive at port** → `ARRIVED_AT_PORT`

Each command appends a new event. Point at the version counter incrementing and
at the timeline growing — nothing was updated in place.

## 3. The raw store (1 min)

```bash
mongosh audit_trail --eval 'db.shipment_events.find({aggregateId:"SHP-1004"}).sort({version:1}).pretty()'
```

Point out `aggregateId`, `eventType`, `payload`, `timestamp`, `version` — the
five fields the source requires — plus `previousHash`/`hash`.

## 4. Immutability (2 min) — the strongest moment

```bash
curl -s localhost:4000/api/shipment/SHP-1001/integrity | python3 -m json.tool
# intact: true
```

Now tamper, as a privileged insider would:

```bash
mongosh audit_trail --eval 'db.shipment_events.updateOne({aggregateId:"SHP-1001",version:5},{$set:{"payload.temperatureC":4.0}})'
curl -s localhost:4000/api/shipment/SHP-1001/integrity | python3 -m json.tool
# intact: false, CONTENT_TAMPERED
```

Refresh the dashboard — the Chain integrity panel is red.

> "Someone with direct database access changed a temperature reading to hide an
> excursion. The chain detected it. To be precise about the claim: this is
> tamper-evidence. A determined attacker with write access could recompute the
> whole chain — stopping that needs signing or external anchoring, and both are
> documented rather than claimed."

Then show the defence in depth: the repository has no update method
(`tests/database/immutability.test.js`), and the production role in
`docs/database/DATABASE.md` withholds `update` and `remove` entirely.

Restore before continuing:

```bash
mongosh audit_trail --eval 'db.shipment_events.updateOne({aggregateId:"SHP-1001",version:5},{$set:{"payload.temperatureC":11.8}})'
```

## 5. Replay and time travel (2 min)

Open `SHP-1001`. Drag the scrubber to just before the spike.

Everything shifts violet — summary, panels, banner — and the breach flag
disappears, later timeline events dim, the chart truncates.

> "This is not a filter over cached state. The backend selected every event at or
> before that instant, folded them through the same reducer the command side
> uses, and returned the result. The dashboard cannot confuse current with
> historical, because the whole workspace changes colour when you leave the
> present."

Drag past the spike — the breach appears. Then "Return to live".

## 6. CQRS and eventual consistency (1.5 min)

Point at the header badge: "Projection current".

Stop the worker (`WORKER_ENABLED=false`, restart) and issue a command. The
"Synchronising" banner appears.

> "The event is written; the projection has not caught up. The API does not
> pretend the command failed and does not serve stale data — it replays from the
> Event Store and tells the client that is what it did."

Restart the worker and watch it clear.

Then destroy the read model entirely:

```bash
mongosh audit_trail --eval 'db.shipment_read_model.deleteMany({})'
npm run rebuild:readmodel
```

> "The dashboard is fully restored. Nothing was lost, because the read model was
> never truth."

## 7. Optimistic concurrency (1.5 min)

Open the same shipment in two browser tabs. Submit a temperature reading in tab
A. Then submit one in tab B.

Tab B gets the conflict dialog: **you had v7, stored now v8, nothing was
written.**

> "Both tabs loaded version 7. The first won. The second was rejected rather than
> silently overwriting — and it is told exactly what to do about it."

Show the test that proves the harder case:

```bash
cd backend && npx node --test --test-reporter=spec tests/concurrency/*.test.js
```

> "Ten simultaneous commands at the same version: exactly one succeeds, nine get
> a conflict, and the stored version sequence is gapless with no duplicates. The
> unique index is what guarantees that, not the pre-check."

## 8. Close (30 s)

```bash
cd backend && npm test      # 115 passing
cd frontend && npm test     #  34 passing
```

> "The progression is: basic API skeleton → CQRS → Event Sourcing → immutable
> store → replay → projection → temporal reconstruction → concurrency safety →
> forensic visualisation. Not four weeks of unrelated features."

---

## Questions worth being ready for

**"Isn't replaying every event slow?"** Yes, which is why the read model exists.
Dashboard queries read the projection and never replay. Only the scrubber and the
integrity check replay, and both are explicit user actions. Past ~10,000 events
per stream the answer is snapshotting — documented, not implemented, because no
shipment here approaches it.

**"What if the projection has a bug?"** Delete it and rebuild. That is the whole
advantage: the derived data is disposable and the truth is not.

**"Why does a temperature spike not change the status?"** Because the source
document defines no consequence for it. Adding quarantine or rejection would put
an invented business rule into an audit trail. The system records the breach and
leaves interpretation to the operator.

**"Where does the threshold come from?"** Each shipment's `CONTAINER_CREATED`
payload. A shipment created without a range never has a breach inferred — no
threshold is ever assumed.
