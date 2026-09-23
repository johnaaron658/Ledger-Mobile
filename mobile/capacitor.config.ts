import type { CapacitorConfig } from "@capacitor/cli";

// Phase 5 shell (MOBILE_APP_IMPLEMENTATION.md §6 item 1): wraps the existing
// frontend/'s Vite build, built with VITE_LOCAL_ENGINE=1 so it runs fully
// client-side against @ledger/core (no backend, no network — MOBILE_APP.md
// §9.2's offline-first constraint). webDir points OUT of this directory at
// frontend/dist rather than mobile/ owning its own copy of the web app,
// mirroring how frontend/ already builds standalone in this workspace.
const config: CapacitorConfig = {
  appId: "org.ledgerdashboard.mobile",
  appName: "Ledger Dashboard",
  webDir: "../frontend/dist",
  // No server.url / server.cleartext — the app is packaged assets only, no
  // live-reload dev server pointed at by default, keeping "no network
  // permission at all" (§9.2) achievable for release builds. See
  // android/app/src/main/AndroidManifest.xml's own comment on the
  // INTERNET permission Capacitor's Android template adds by default.
  android: {
    allowMixedContent: false,
  },
  ios: {
    contentInset: "automatic",
  },
};

export default config;
