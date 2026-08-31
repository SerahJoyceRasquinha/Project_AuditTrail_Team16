# Setup

`node_modules` is **not** included in this archive. It was excluded deliberately:
the working copy contained Linux-compiled binaries (rollup, esbuild) that fail on
Windows with `Cannot find module @rollup/rollup-win32-x64-msvc`. The lockfiles
are included, so `npm install` restores exactly the same dependency tree for
your platform.

Requires Node.js 20.11 or later.

## Install (PowerShell / Command Prompt)

```powershell
cd audit-trail\backend
npm install

cd ..\frontend
npm install
```

## Run

The backend works with no database at all — useful for a first look:

```powershell
cd audit-trail\backend
$env:PERSISTENCE="memory"
npm start
```

For real persistence, set `PERSISTENCE=mongo` and `MONGODB_URI` in
`backend\.env`, then:

```powershell
cd audit-trail\backend
npm start
```

In a second terminal:

```powershell
cd audit-trail\frontend
npm run dev
```

The dashboard is at http://localhost:5173 and the API at http://localhost:4001.

## Tests

```powershell
cd audit-trail\backend
npm test                 # 223 tests, no MongoDB required

cd ..\frontend
npm test                 # 71 tests
```

## Seed demonstration data

```powershell
cd audit-trail\backend
npm run seed             # requires PERSISTENCE=mongo
node scripts\seed.js --dry-run   # verifies the script without a database
```

## Demonstrating the new features quickly

Hourly temperature monitoring is real time, so a demo would otherwise take
hours. Shorten the cadence:

```powershell
$env:SENSOR_INTERVAL_MS="60000"        # a "reading" every minute
$env:SENSOR_SWEEP_INTERVAL_MS="5000"   # look for due readings every 5s
$env:SENSOR_EXCURSION_CHANCE="0.3"     # more breaches, so alerts appear
npm start
```

To see optimistic concurrency reject a stale command, open the same shipment in
two browser tabs, confirm a stage in one, then confirm in the other.

To record nothing rather than simulate, set `SENSOR_SOURCE=none`.
