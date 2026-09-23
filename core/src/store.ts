// Storage port (§5.3) — the one thing that differs between Node (this
// phase's tests/harness), browser, and Capacitor. `core` takes this
// injected rather than reaching for fs/IndexedDB itself.

export type ConfigFile = "app_settings" | "budget_settings" | "analyses" | "automations";

export interface Storage {
  readJournal(): Promise<string | null>; // null = nothing imported yet (§5.4's empty state)
  writeJournal(text: string): Promise<void>; // atomic: temp -> fsync -> rename, per implementation
  readConfig(name: ConfigFile): Promise<unknown | null>;
  writeConfig(name: ConfigFile, value: unknown): Promise<void>;
}
