# Fix log — merge damage and follow-ups

## The reported failure

```
[plugin:vite:react-babel]
.../frontend/src/pages/LoginPage.jsx: Unexpected token (90:2)
  93 |     <div className="auth-page">
```

The dev server would not start, so `http://localhost:5173` never rendered.

## Root cause

Merge commit `14fb9e9` ("Merge branch 'main' of …") was resolved by hand and the
resolution was wrong in three files. It joined two branches that had both
rewritten the same components:

- `e931139` — the authentication work (validated login, roles, `AuthContext`)
- `a565bd4` — the sign-in page restyle, theme toggle, audit-log search, and the
  copy-to-clipboard actions on the timeline

In each of the three files below the merge kept the **import lines from one
branch and the function body from the other**. Git recorded a clean merge, so
nothing warned until Vite tried to parse the result.

### 1. `frontend/src/pages/LoginPage.jsx` — the reported crash

| | |
| --- | --- |
| Both import lines dropped | The file used `useAuth`, `useNavigate`, `useLocation`, `Navigate` and `Link` with nothing importing them |
| Stray `};` after `applyDemoAccount` (line 50) | — |
| Stray `}` after the `try/finally` (line 89) | — |

The stray brace at line 50 closed `LoginPage()` early. By the time the parser
reached `<div className="auth-page">` it was at top level and no longer expecting
JSX — which is the `Unexpected token (90:2)` that was reported. **The error
pointed at line 90; the damage started at line 50.**

### 2. `frontend/src/layouts/AppLayout.jsx` — never reported

Vite stops at the first failing file, so this one was hidden behind the above.

- `const { user, logout } = useAuth();` duplicated at line 52, after line 42 had
  already destructured `user`, `isAuthenticated`, `isPending` and `logout`.
  A redeclaration error.
- Another stray `};`, after `signOut`.

### 3. `frontend/src/components/EventTimeline.jsx` — a runtime error, not a syntax one

The merge kept `import { memo } from 'react'` from one branch and the component
body from the other, which calls `useState` three times. This compiles fine and
fails when a shipment is opened. It was caught by the test suite
(`ReferenceError: useState is not defined`), not by the build.

**Fix:** restored the missing imports, removed the three stray braces, removed
the duplicated destructure. No behaviour was otherwise changed — both branches'
intended features are kept.

---

## Defects found while verifying

### Demo accounts referenced roles that do not exist

The merge brought in one-click demo buttons for **Operator, Auditor and Admin**.
`domain/auth/roles.js` defines exactly two roles, `operator` and `user`, and
documents the deliberate absence of an administrator. Registering with `auditor`
or `admin` is rejected with a 400, and no demo accounts were seeded at all — so
all three buttons filled in credentials that could not sign in.

**Fix:**

- `backend/src/application/services/demoAccounts.js` — two demo accounts,
  derived from `ROLES` so the same drift cannot recur silently:
  `operator` / `operator123` (Operator) and `viewer` / `viewer123` (User).
- Seeded at bootstrap only when `AUTH_SEED_DEMO_ACCOUNTS=true`. **Off by
  default** — the passwords are published, so a deployment must never acquire
  them by accident.
- Seeding goes through `AuthService.register`, so the accounts get the same
  scrypt hashing, validation and role checks as any other. Nothing writes to the
  users collection directly, and an existing account sharing a username is never
  overwritten.
- `tests/integration/demoAccounts.test.js` — 6 tests, including the assertion
  that every demo account names an assignable role. That is the test that would
  have caught the original mismatch.

### Port 4001 vs 4000

`backend/.env` used `PORT=4001` and `vite.config.js` proxied to `4001`, but
`backend/.env.example`, `frontend/.env.example` and every document said `4000`.
A fresh clone copying `.env.example` would have started the backend on a port the
dev proxy does not talk to. All aligned to **4001**.

### `docs/api/API.md` was stale

- `POST /api/shipment/create` still documented `origin` as a free-text string
  (`"Chennai, IN"`). The validator now expects a structured
  `{ countryCode, stateCode, city }` resolved against the shared catalogue.
  Corrected, with the legacy string form documented as the backfill path it now
  is. `estimatedDurationDays` documented as required, and container-code
  normalisation documented.
- The authentication endpoints were **not documented at all**. Added a section
  covering `register`, `login`, `me`, the two-role model, the 401/403 split, and
  the demo accounts.

---

## Verification

| Check | Result |
| --- | --- |
| Syntax check, all 103 source files | 0 errors |
| ESLint `no-undef` / `no-redeclare`, frontend + backend | clean (this is what catches missing imports) |
| Backend test suite | **254 / 254** (was 248; +6 demo-account tests) |
| Frontend test suite | **120 / 120** (was 114/120 — 6 failed on the `EventTimeline` defect) |
| `vite build` | passes, 858 modules |
| `vite dev` + `localhost:5173` | serves; every route module compiles; `/api` and `/health` proxy to the backend |

Live API testing against a running backend also confirmed:

- **Role enforcement** — all 9 command endpoints return 403 for a read-only
  account and 401 unauthenticated, while the same account is served every query.
  Enforced by middleware, not by hiding buttons.
- **Credentials** — wrong password and unknown username return an identical 401;
  login is case-insensitive on username; the password hash never appears in a
  response; a forged token is rejected.
- **OCC** — a stale `expectedVersion` is 409, a missing one is 400.
- **Aggregate rules** — double load, unload-before-arrival, no-op amendment and
  any command against an archived shipment are all refused with 409, while an
  archived shipment stays readable.
- **Event sourcing** — a 9-event stream verified `intact: true` on the hash
  chain, and the projection reconciled against replay with 0 discrepancies.
- **Scheduling** — out-of-order stages, dates outside the planning window, a
  second `plan`, and zero/fractional extensions are all refused.
- **Container-code normalisation** — `"  msku 784 5123 "` stored as
  `"MSKU7845123"`, on the backend, before the aggregate sees it.
- **Exports** — CSV and PDF both return (PDF verified by magic bytes). `format=json`
  correctly 400s; the UI only ever offers CSV and PDF, so this is not a defect.
- **Time scrubber, sensors, SSE stream** — all respond correctly, including the
  `BEFORE_FIRST_EVENT` boundary case.
