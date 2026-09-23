// Capacitor `@capacitor/filesystem` Storage implementation (§5.3 of the
// implementation plan; §6 items 1 and 4 of Phase 5) — the mobile
// counterpart to nodeStorage.ts/browserStorage.ts. Journal, config, and
// device-local state each live as real files in `Directory.Data`
// (app-private storage: `Documents/`-equivalent on iOS, internal storage on
// Android — never user-visible, survives app restarts and OS updates, per
// MOBILE_APP.md §4.4), not IndexedDB: keeping the journal as an actual file
// is what makes the export flow (§6 item 3) a plain file-to-zip operation
// instead of first materializing one from a DB blob.
//
// NOT re-exported from index.ts's barrel, for the same reason nodeStorage.ts
// isn't (see index.ts's header comment): importing `@capacitor/filesystem`
// is harmless even outside a native shell (it ships a web fallback — see
// its own web.ts — so it doesn't crash a plain browser build), but the
// barrel's dependency surface should stay intentional rather than accidental.
// frontend/src/api.js imports this directly:
// `@ledger/core/src/capacitorStorage.js`, gated on `Capacitor.isNativePlatform()`.
//
// ⚠ UNVERIFIED ON DEVICE — see MOBILE_APP_IMPLEMENTATION.md's Phase 5
// writeup. This is written against @capacitor/filesystem's documented API
// (`node_modules/@capacitor/filesystem/dist/esm/definitions.d.ts`) and
// exercised only via manual code review; there is no Android/iOS device or
// emulator in this environment to actually run it. In particular: the
// specific error thrown for "file does not exist" (isNotFound below) is
// confirmed for the plugin's *web* fallback (throws `Error('File does not
// exist.')`, see web.js) but only inferred for native (its documented
// `PluginError.code` format is "OS-PLUG-FILE-XXXX"; matched here by message
// text instead of by code, since the exact per-platform code for
// "not found" isn't confirmable without running on a device).

import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { ConfigFile, Storage } from "./store.js";

const DIR = Directory.Data;
const JOURNAL_PATH = "journal.ledger";
const JOURNAL_TMP_PATH = "journal.ledger.tmp";
const CONFIG_DIR = "config";
const STATE_DIR = "state";

function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /does not exist|not found|enoent/i.test(msg);
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function ensureDirExists(path: string): Promise<void> {
  try {
    await Filesystem.mkdir({ path, directory: DIR, recursive: true });
  } catch (e) {
    // mkdir throws if the directory is already there — that's the expected
    // steady state after the first call, not a real failure.
    if (!/exist/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    const res = await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 });
    // Native always returns a string for UTF8-encoded reads; only the web
    // fallback can hand back a Blob (see ReadFileResult's own doc comment).
    return typeof res.data === "string" ? res.data : await (res.data as Blob).text();
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Write-to-temp-then-rename (MOBILE_APP.md §4.4: "written atomically (write
 * temp -> fsync -> rename) so a kill mid-write can't truncate it"):
 * Filesystem.rename is the platform's own move/replace, so a process killed
 * between the two calls leaves either the untouched previous file or a
 * complete temp file — never a half-written target. There's no direct fsync
 * call in @capacitor/filesystem's API; writeFile's own promise resolving is
 * taken as the durability boundary, same trust level the plugin gives any
 * other caller. */
async function writeTextAtomically(path: string, tmpPath: string, text: string): Promise<void> {
  await Filesystem.writeFile({ path: tmpPath, directory: DIR, data: text, encoding: Encoding.UTF8 });
  await Filesystem.rename({ from: tmpPath, to: path, directory: DIR, toDirectory: DIR });
}

async function deleteIfExists(path: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path, directory: DIR });
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

export class CapacitorStorage implements Storage {
  private ready: Promise<void> | null = null;

  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureDirExists(CONFIG_DIR);
        await ensureDirExists(STATE_DIR);
      })();
    }
    return this.ready;
  }

  async readJournal(): Promise<string | null> {
    await this.init();
    return readTextIfExists(JOURNAL_PATH);
  }

  // `message` (TrackingStorage's undo label, mobileState.ts) isn't used
  // here — the decorator captures the previous text via readJournal() and
  // the message itself before delegating, so this implementation only
  // needs to honor the atomic-write contract, same division of concerns as
  // nodeStorage.ts/browserStorage.ts.
  async writeJournal(text: string): Promise<void> {
    await this.init();
    await writeTextAtomically(JOURNAL_PATH, JOURNAL_TMP_PATH, text);
  }

  async readConfig(name: ConfigFile): Promise<unknown | null> {
    await this.init();
    const text = await readTextIfExists(`${CONFIG_DIR}/${name}.json`);
    return text == null ? null : JSON.parse(text);
  }

  async writeConfig(name: ConfigFile, value: unknown): Promise<void> {
    await this.init();
    const path = `${CONFIG_DIR}/${name}.json`;
    await writeTextAtomically(path, `${path}.tmp`, JSON.stringify(value, null, 2));
  }

  async readState(key: string): Promise<unknown | null> {
    await this.init();
    const text = await readTextIfExists(`${STATE_DIR}/${sanitizeKey(key)}.json`);
    return text == null ? null : JSON.parse(text);
  }

  async writeState(key: string, value: unknown | null): Promise<void> {
    await this.init();
    const path = `${STATE_DIR}/${sanitizeKey(key)}.json`;
    if (value === null) {
      await deleteIfExists(path);
      return;
    }
    await writeTextAtomically(path, `${path}.tmp`, JSON.stringify(value));
  }
}
