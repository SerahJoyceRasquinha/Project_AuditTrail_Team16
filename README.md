# Running in VS Code (Windows)

Every command here is PowerShell, which is what the VS Code terminal uses by
default on Windows.

## Before you start

Check Node is 20.11 or newer:

```powershell
node -v
```

Open the project: **File → Open Folder**, and select the `audit-trail` folder —
the one containing `backend`, `frontend` and `docs`. Opening `backend` alone will
make the relative paths below wrong.

Open the terminal with **Ctrl+`** (the backtick key, top-left under Esc).

---

## The three-terminal setup

Use the **split icon** (⧉) in the terminal panel's top-right rather than the `+`,
so all three sit side by side and you can watch the backend logs while the
frontend builds. Switch between them with the dropdown on the right of the panel.

### Terminal 1 — backend

```powershell
cd backend
npm install
$env:PERSISTENCE="memory"
npm run dev
```

Leave it running. You will see a warning that data is not durable — that is
correct and expected in memory mode.

### Terminal 2 — frontend

```powershell
cd frontend
npm install
npm run dev
```

Ctrl+click the `http://localhost:5173` link Vite prints and VS Code opens it.

### Terminal 3 — load the demonstration data

The ledger starts empty. With the backend running:

```powershell
cd backend
$env:PERSISTENCE="memory"
npm run seed:http
```

Refresh the browser and search for **SHP-1001** — the shipment with a temperature
excursion mid-voyage.

---

## Which seed script

| Script | Use when |
| --- | --- |
| `npm run seed:http` | **Almost always.** Sends real HTTP commands to the running server. Works in both persistence modes. |
| `npm run seed` | Only with `PERSISTENCE=mongo`. Writes directly, in its own process — which is why it cannot work in memory mode, where each process has its own private store. |

---

## Running with MongoDB instead

Memory mode resets on every restart. For persistence:

```powershell
winget install MongoDB.Server
Get-Service MongoDB          # should say Running
```

If it says `Stopped`, run `Start-Service MongoDB` from an **administrator**
PowerShell.

Then, in a terminal where you have *not* set `$env:PERSISTENCE`:

```powershell
cd backend
copy .env.example .env
npm run seed
npm run dev
```

---

## Tests

```powershell
cd backend
npm test          # 118 tests, no MongoDB needed

cd ..\frontend
npm test          # 34 tests
```

The Recharts width/height warning during frontend tests is expected — jsdom has
no layout engine, so the responsive container measures zero. Cosmetic only.

---

## One-click startup

Create `.vscode/tasks.json` in the project root (already included in this
project):

Press **Ctrl+Shift+P** → type `Tasks: Run Task` → choose **Start everything**.
Both processes launch in split terminals with `PERSISTENCE` already set.

To seed afterwards, run the task **Seed demo data**.

---

## PowerShell notes

**`&&` may not work.** In Windows PowerShell 5.1 (the default on Windows 10/11),
`cd backend && npm install` errors. Either run the two lines separately, or use
PowerShell 7+, where `&&` works fine.

**`$env:` persists for the session.** Once you set `$env:PERSISTENCE="memory"` in
a terminal, every later command in *that* terminal stays in memory mode. To
switch back, either open a fresh terminal or run:

```powershell
$env:PERSISTENCE="mongo"
```

**Scripts disabled error.** If `npm` fails with *"running scripts is disabled on
this system"*, run this once in an administrator PowerShell:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

---

## Common problems

**`ECONNREFUSED 127.0.0.1:27017`** — MongoDB is not running. Either start it, or
use `$env:PERSISTENCE="memory"` and skip it entirely.

**`EADDRINUSE`** — port 4000 is taken. Use `$env:PORT="4001"`, and update
`vite.config.js` so the proxy target matches.

**"The ledger is empty"** — run `npm run seed:http` in a third terminal while the
backend is running.

**Frontend says "Cannot reach the API"** — check the backend terminal is still
running, then `curl http://localhost:4000/health` (or open it in a browser).

**Stopping a process** — click into that terminal and press Ctrl+C.

More symptom-first fixes in [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

---

## What to do once it is running

[`DEMONSTRATION.md`](DEMONSTRATION.md) is a ten-minute walkthrough script: build
a history from commands, tamper with the database and watch the hash chain catch
it, scrub back in time, and trigger a concurrency conflict across two browser
tabs.
