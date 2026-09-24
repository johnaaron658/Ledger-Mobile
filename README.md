# Ledger Mobile

A standalone, offline mobile version of the Ledger Dashboard: a personal-finance
app built on a [ledger-cli](https://ledger-cli.org/) plain-text journal. You
import one `.ledger` file (transactions, budgets, commodity prices) and the app
runs entirely on-device — no server, no account, and no network permission.

The desktop dashboard shells out to the `ledger` binary behind a Python API.
A phone has no `ledger` binary, so this repo reimplements the parts of ledger
the dashboard uses in TypeScript and runs the existing React UI against that
engine inside a Capacitor shell.

## Features

Same six tabs as the desktop dashboard:

| Tab | What it does |
|---|---|
| **Transactions** | Searchable list; add, edit, delete, with fuzzy payee/account pickers. |
| **Budgets** | Per-account budgets, this-month spend, all-time envelopes, budget history. |
| **Accounts** | Account tree with rolled-up balances in the main commodity, plus a running-balance chart per account. |
| **Analysis** | Saved analyses that map payees/accounts to categories; pie + time-series charts, running totals, linear forecasts. |
| **Automations** | Recurring transaction templates with `$[variables]`, a pending-review queue, and groups. |
| **Commodities** | Price history per commodity; add price points. |

Mobile-specific additions:

- **Validated writes.** Each edit rewrites the journal atomically and is rolled
  back if the journal no longer balances. The last write can be undone.
- **Export, not sync.** A one-tap Export button builds a `.zip` backup (journal +
  config) and hands it to the share sheet. A nudge appears once enough edits or
  days have piled up since the last export. Export is the only backup.
- **Biometric lock** (optional), re-locking whenever the app is backgrounded.
- **Phone layout.** Bottom icon tab bar, floating quick-add button, bottom-sheet
  forms, tap-to-assign categories in Analysis.

## Repo layout

An npm workspace with four packages:

```
engine/    @ledger/engine — ledger parser + reports (register, balance, periodic/budget,
           price valuation). Pure TypeScript: no I/O, no DOM.
core/      @ledger/core — the service layer. Implements the same API the desktop
           backend exposes (transactions, budgets, analysis, automations, …) on top of
           the engine, plus storage adapters (IndexedDB, Capacitor Filesystem, Node fs),
           import/export, undo, and app state.
frontend/  React + Vite UI shared with the desktop dashboard. src/api.js selects the
           backend at build time (see below).
mobile/    Capacitor shell (Android + iOS) wrapping frontend/dist.
```

### One UI, two backends

`frontend/src/api.js` is the contract between the UI and its data. It chooses
an implementation at build time:

- **Default build:** `httpApi` talks to the desktop dashboard's Python backend
  over `/api/*`. The Vite dev server proxies that to `127.0.0.1:8756`.
- **`VITE_LOCAL_ENGINE=1`:** `createLocalApi()` from `@ledger/core` runs
  everything in-process. Storage is Capacitor Filesystem on a device and
  IndexedDB in a plain browser, so the offline app can also be tried at a desktop.

## Getting started

Requires Node 22+.

```bash
npm install          # installs every workspace
npm test             # engine + core test suites (vitest)
```

### Run the offline app in a browser

```bash
cd frontend
VITE_LOCAL_ENGINE=1 npm run dev
```

On first launch you'll see the import screen: choose a `.ledger` file, or start
a new journal. Data lives in the browser's IndexedDB.

### Run against the desktop backend

Start the dashboard backend on port 8756 (it lives in the separate dashboard
repo), then:

```bash
cd frontend
npm run dev
```

## Building the Android app

The Android toolchain (JDK 21, Android SDK platform 36 / build-tools 36.0.0) is
expected on `PATH`, with `ANDROID_HOME` set.

```bash
cd frontend && VITE_LOCAL_ENGINE=1 npm run build
cd ../mobile && npx cap sync android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android && ./gradlew assembleDebug
# -> mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run sync` in `mobile/` does the first two steps. To install, copy the APK
to the phone and allow "install unknown apps". The Android manifest
deliberately omits the `INTERNET` permission.

iOS: `mobile/ios` is scaffolded but needs a Mac with Xcode to build.

## Testing

- `engine/test` covers amounts, value expressions, parsing, validation, prices,
  and the register/balance/periodic reports.
- `core/test` covers storage, import/export, undo/app state, ledger formatting,
  and journal writes.
- **Oracle parity.** Some suites compare output byte-for-byte against golden
  fixtures captured from real `ledger` runs through the desktop backend. The
  fixtures contain real financial data, so they're gitignored
  (`engine/test/golden/`) and regenerated from the dashboard repo. Without them,
  those suites skip themselves rather than fail.

Lint the UI with `npm run lint` in `frontend/`.

## Design notes

`MOBILE_APP.md` (feasibility and design decisions) and
`MOBILE_APP_IMPLEMENTATION.md` (phase-by-phase build plan and status) hold the
detailed reasoning. Both are gitignored working notes, so they exist only in
local checkouts that have them.
