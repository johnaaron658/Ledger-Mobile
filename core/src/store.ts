// Storage port (§5.3) — the one thing that differs between Node (this
// phase's tests/harness), browser, and Capacitor. `core` takes this
// injected rather than reaching for fs/IndexedDB itself.

export type ConfigFile = "app_settings" | "budget_settings" | "analyses" | "automations";

export interface Storage {
  readJournal(): Promise<string | null>; // null = nothing imported yet (§5.4's empty state)
  /** Atomic: temp -> fsync -> rename, per implementation. `message` is the
   * journal_edit-style human-readable label for this write ("dashboard: add
   * transaction 2025/03/04 Jollibee") — present only for writes that
   * represent a real user edit, per journalEdit.ts's call sites. It's
   * optional and ignored by NodeStorage/BrowserStorage/CapacitorStorage
   * themselves; mobileState.ts's TrackingStorage decorator is what reads it
   * to drive single-level undo (§6 item 4 of the implementation plan). A
   * write with no message (first-run import, start-new-journal, undo itself)
   * is intentionally untracked. */
  writeJournal(text: string, message?: string): Promise<void>;
  readConfig(name: ConfigFile): Promise<unknown | null>;
  writeConfig(name: ConfigFile, value: unknown): Promise<void>;
  /** Device-local app state — undo slot, write/export counters, retained
   * export payloads (§6 items 4-5). Deliberately separate from ConfigFile:
   * these never participate in the config bundle import/export (§3.2 of
   * MOBILE_APP.md) — they're bookkeeping for this specific install, not
   * portable settings. Keys are free-form strings (unlike ConfigFile's fixed
   * union) since callers mint per-record keys (e.g. one per retained
   * export). `writeState(key, null)` deletes the key. */
  readState(key: string): Promise<unknown | null>;
  writeState(key: string, value: unknown | null): Promise<void>;
}
