# Deployment

The roadmap marks deployment optional and names no target platform, so this is
containerised rather than written for one vendor: anything that runs OCI images
can run it, and nothing here assumes a particular cloud.

```bash
cd audit-trail
echo "AUTH_TOKEN_SECRET=$(openssl rand -hex 32)" > .env
docker compose up --build
```

Then open **http://localhost:8080**.

| | |
|---|---|
| Dashboard | http://localhost:8080 |
| API | http://localhost:4001 |
| Health | http://localhost:4001/health |

## What comes up

Four services, and the shape of the split is the interesting part.

| Service | Image | Role |
|---|---|---|
| `mongo` | `mongo:7` | The Event Store and the read model |
| `api` | `./backend` | Command and query HTTP surface, plus the temperature monitor |
| `worker` | `./backend` | The projection worker, on its own |
| `dashboard` | `./frontend` | Static bundle behind nginx |

`api` and `worker` are **the same image started with a different command**. The
architecture has always claimed the projection worker is independently
deployable; this is that claim compiled. You can stop the worker and watch the
API keep accepting commands while `GET /api/meta/worker` reports the read model
falling behind — which is the eventual-consistency window made visible rather
than described.

`WORKER_IN_PROCESS` is `false` on the API for a reason that matters: two workers
sharing one checkpoint is a race, not redundancy. Scaling the worker to two
replicas would need the checkpoint to move somewhere that supports leasing, and
is not supported as configured.

The temperature monitor stays on the API and is switched **off** on the worker.
It issues commands rather than writing events, so it belongs with the command
surface, and two monitors sampling one shipment is precisely what the in-flight
guard exists to prevent — there is no reason to make it prove that in production.

## Configuration

Everything is read once, in `backend/src/config/env.js`. The compose file sets
what a deployment must set; `backend/.env.example` documents the rest.

| Variable | Compose value | Why |
|---|---|---|
| `PERSISTENCE` | `mongo` | `memory` is for demos and is not durable |
| `MONGODB_URI` | `mongodb://mongo:27017` | Service name on the compose network |
| `AUTH_TOKEN_SECRET` | **you must set it** | Unset, a random secret is generated per boot and every session ends when the container restarts |
| `AUTH_SEED_DEMO_ACCOUNTS` | `false` | The demo passwords are published in the repo. Never enable this on a networked host |
| `CORS_ORIGIN` | `http://localhost:8080` | Only a fallback — nginx proxies the API same-origin |
| `WORKER_IN_PROCESS` | `false` on `api` | The worker is its own service |

Compose deliberately fails to start if `AUTH_TOKEN_SECRET` is missing rather than
booting with a per-boot random one. A deployment where every restart silently
signs everybody out is a deployment where nobody can tell a restart from a
security incident.

## Why nginx proxies the API

The frontend image builds with `VITE_API_BASE_URL` empty and nginx forwards
`/api` and `/health` to the API container. The browser therefore only ever makes
same-origin requests — the same arrangement the Vite dev proxy provides in
development. Keeping both environments same-origin means CORS behaves identically
in each and cannot become a production-only surprise.

Three lines in `frontend/nginx.conf` exist solely for server-sent events:
`proxy_set_header Connection ''`, `proxy_buffering off` and a long
`proxy_read_timeout`. Without them nginx buffers the stream, no notification ever
reaches the browser, and the dashboard quietly falls back to polling — working,
but not doing the thing it was built to do.

## Database permissions

`docs/database/DATABASE.md` specifies a least-privilege application account:
**insert and find** on the events collection, deliberately not update or remove.
The compose file runs MongoDB without authentication because it is a local
demonstration on a private network. Any deployment reachable from a network
should create that account and point `MONGODB_URI` at it — the append-only
guarantee is worth having enforced by the database as well as by the code.

## Production readiness already in the build

Independent of containers: graceful shutdown that drains in-flight requests and
lets the worker finish its batch, database connection retry with backoff,
`/health` reporting the database, worker and monitor rather than merely
answering, structured logs with credential redaction, and a bounded command rate
limiter.

The rate limiter is in-process, so its budget is per-instance. Running more than
one API replica means the effective limit multiplies by the replica count;
`docs/architecture/ENHANCEMENTS.md` logs moving the counter to Redis as the fix.

## Not covered here

TLS termination, a domain, log shipping and backups are all site-specific.
MongoDB's data lives in the `mongo-data` volume — back that up, and note that the
Event Store is the only thing in the system that cannot be rebuilt: the read
model is derived and `npm run rebuild:readmodel` regenerates it from the log.
