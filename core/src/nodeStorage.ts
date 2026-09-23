// Node `fs` Storage implementation (§5.3) — used by this phase's own
// golden/parity tests (run in Node, no mobile toolchain) and, later,
// tools/compare-api.py's Phase 4 harness. Not atomic (plain writeFile);
// atomic temp->fsync->rename is a Phase 5 Capacitor-storage concern.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigFile, Storage } from "./store.js";

export class NodeStorage implements Storage {
  constructor(
    private journalPath: string,
    private configDir: string,
  ) {}

  async readJournal(): Promise<string | null> {
    try {
      return await readFile(this.journalPath, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async writeJournal(text: string): Promise<void> {
    await mkdir(dirname(this.journalPath), { recursive: true });
    await writeFile(this.journalPath, text, "utf-8");
  }

  private configPath(name: ConfigFile): string {
    return join(this.configDir, `${name}.json`);
  }

  async readConfig(name: ConfigFile): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(this.configPath(name), "utf-8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async writeConfig(name: ConfigFile, value: unknown): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    await writeFile(this.configPath(name), JSON.stringify(value, null, 2), "utf-8");
  }
}
