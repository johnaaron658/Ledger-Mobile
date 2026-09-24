# CLAUDE.md

Offline mobile port of the Ledger Dashboard. See README.md for the overview.
`MOBILE_APP.md` (design decisions) and `MOBILE_APP_IMPLEMENTATION.md` (build
plan, phase status, open items) are gitignored local notes. Read them for
context when they exist. They record *why* things are the way they are.

## Commands

```bash
npm test                                          # all workspaces (vitest)
cd frontend && npm run lint                       # oxlint; pre-existing warnings exist
cd frontend && VITE_LOCAL_ENGINE=1 npm run build  # offline build (what the APK ships)
cd frontend && VITE_LOCAL_ENGINE=1 npm run dev    # offline app in a browser (IndexedDB)
```

APK (toolchain is user-space under `~/android-toolchain/`, env vars in `~/.bashrc`):

```bash
cd frontend && VITE_LOCAL_ENGINE=1 npm run build
cd ../mobile && npx cap sync android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android && ./gradlew assembleDebug   # -> app/build/outputs/apk/debug/app-debug.apk
```

## Architecture rules

- **`frontend/src/api.js` is the contract.** `httpApi` (desktop Python backend)
  and `createLocalApi()` (`@ledger/core`) must keep identical method names,
  arguments and return shapes. Components only ever call `api.*`.
- **The same frontend ships to desktop and mobile.** Gate mobile-only UI behind
  CSS (`@media (max-width: 640px)` for layout, `(pointer: coarse)` for touch
  behavior) or `isLocalEngine` / `isNativePlatform()`. Don't break the desktop
  layout.
- **Engine money is never a JS `number`.** Quantities are exact inside
  `engine/`; `number` only appears at the API-response boundary.
- **Engine output is pinned to real `ledger`.** Golden fixtures
  (`engine/test/golden/`, gitignored, contain real financial data) come from the
  desktop backend. Suites skip when they're absent. Don't change engine behavior
  to "look right" without checking what `ledger` actually does.
- **Don't re-export `core/src/nodeStorage.ts` from the core barrel.** It imports
  `node:fs` and crashes the browser build. The same goes for
  `capacitorStorage.ts`, which is imported by path.
- **Native bridge calls go through `frontend/src/capacitorAdapter.js`** (file
  picker, share, etc.), each with a browser fallback.
- **The Android app has no `INTERNET` permission, on purpose.** Don't add
  anything that needs the network.

## Gotchas

- The repo is on a WSL DrvFS mount (`/mnt/c/...`), which emits no inotify events.
  Vite is configured to poll. Other watchers may silently miss edits.
- Analysis/Accounts value everything in `main_commodity` (default `PHP`), and
  `default_currency` (default `₱`) is only the display/entry symbol. A test
  journal written in `₱` amounts shows empty analysis pools.
- Headless Chromium (Playwright) needs `libasound.so.2`, which isn't installed.
  Download it without root via `apt-get download libasound2t64 && dpkg -x`, then
  set `LD_LIBRARY_PATH`. Its emulated `pointer: coarse` drifts to fine
  mid-session, so touch-only CSS can't be reliably verified there.
- iOS (`mobile/ios`) cannot be built on this Linux machine.

## Conventions

- Plain JSX + one global stylesheet (`frontend/src/App.css`), with colors as CSS
  variables in `index.css`. Icons are inline SVGs in
  `frontend/src/components/Icons.jsx`. There are no UI or icon libraries.
- Comments explain *why*, often citing `MOBILE_APP*.md` sections. Match that
  density.
- Work happens on `master`. Commit messages have a short summary line, then a
  body explaining the reasoning.
