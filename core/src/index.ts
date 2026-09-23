// Public surface of @ledger/core.
//
// nodeStorage.ts is DELIBERATELY not re-exported here: it imports
// `node:fs/promises`/`node:path`, and a bundler can't tree-shake a public
// barrel re-export — pulling it in crashes the browser build at runtime the
// moment the module evaluates (Vite's browser stub throws on property
// access, not just at call time), even though nothing browser-side ever
// constructs a NodeStorage. Node-only consumers (this package's own tests,
// tools/local-api-runner.mts) import it directly from its own path instead:
// `./nodeStorage.js` / `packages/core/src/nodeStorage.js`.

export * from "./store.js";
export * from "./browserStorage.js";
export * from "./importExport.js";
export * from "./settings.js";
export * from "./ledgerFormat.js";
export * from "./transactions.js";
export * from "./accountsView.js";
export * from "./commodities.js";
export * from "./budgets.js";
export * from "./analysis.js";
export * from "./analysisStore.js";
export * from "./automations.js";
export * from "./journalEdit.js";
export * from "./mobileState.js";
export * from "./api.js";
