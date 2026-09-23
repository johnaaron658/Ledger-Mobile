// First-run import/export (§5.4) — the two service-layer methods that exist
// only on the local engine, because the desktop has no equivalent (config.py
// always points at a folder that already exists). Built and debugged here in
// the browser during Phase 4; Phase 5 only swaps the file picker.

import { type Journal, formatLedgerDate, parseAndValidate } from "@ledger/engine";
import { strToU8, strFromU8, unzipSync, zipSync } from "fflate";
import type { Automation, AutomationGroup, PendingOccurrence } from "./automations.js";
import type { AnalysisRecord } from "./analysisStore.js";
import type { ConfigFile, Storage } from "./store.js";

export interface ImportIssue {
  line?: number;
  text?: string;
  message: string;
}

export interface JournalImportResult {
  ok: boolean;
  counts?: {
    transactions: number;
    periodics: number;
    prices: number;
    dateRange: [string, string] | null;
  };
  errors?: ImportIssue[];
}

const INCLUDE_RE = /^\s*include\s+\S/i;

/** A picked file can't resolve sibling includes on mobile anyway (§5.4), so
 * the useful behaviour is a clear, named failure instead of silently
 * importing a journal that's missing most of its transactions. Three lines,
 * per the plan — checked before the file is even handed to the parser. */
function findIncludeDirective(text: string): ImportIssue | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (INCLUDE_RE.test(lines[i])) {
      return {
        line: i + 1,
        text: lines[i],
        message: "this file uses `include`; consolidate it into a single file first (see MOBILE_APP_IMPLEMENTATION.md §2.1)",
      };
    }
  }
  return null;
}

function countJournal(journal: Journal): JournalImportResult["counts"] {
  const dates = journal.transactions.map((t) => t.date);
  let dateRange: [string, string] | null = null;
  if (dates.length > 0) {
    const min = dates.reduce((a, b) => (a < b ? a : b));
    const max = dates.reduce((a, b) => (a > b ? a : b));
    dateRange = [formatLedgerDate(min), formatLedgerDate(max)];
  }
  return {
    transactions: journal.transactions.length,
    periodics: journal.periodics.length,
    prices: journal.prices.length,
    dateRange,
  };
}

/** Parses and validates in memory, never touching storage — the same check
 * journalEdit.ts's writeAndValidate runs on every edit, applied here at
 * import time instead (§5.4 step 3). Step 4's confirmation summary is built
 * from this result *before* anything is committed; `importJournal` below
 * re-runs it at commit time rather than trusting a possibly-stale preview. */
export function previewJournalImport(text: string): JournalImportResult {
  const include = findIncludeDirective(text);
  if (include) return { ok: false, errors: [include] };

  const { journal, result } = parseAndValidate(text);
  if (!journal || !result.ok) {
    const lines = text.split("\n");
    return {
      ok: false,
      errors: result.issues.map((issue) => ({
        line: issue.begLine,
        text: issue.begLine != null ? lines[issue.begLine - 1] : undefined,
        message: issue.message,
      })),
    };
  }

  return { ok: true, counts: countJournal(journal) };
}

/** Step 5: commits a journal already accepted by `previewJournalImport` (or
 * validates fresh, if called directly) — re-validates rather than trusting
 * the caller's earlier preview, so this alone is still safe to call. */
export async function importJournal(storage: Storage, text: string): Promise<JournalImportResult> {
  const preview = previewJournalImport(text);
  if (!preview.ok) return preview;
  await storage.writeJournal(text);
  return preview;
}

/** The "start a new journal" path (§5.4) — a valid empty Journal costs
 * almost nothing, and when default_currency and main_commodity differ it
 * seeds the same identity price the real journal carries at its own L5
 * (`P ... ₱ 1 PHP`), so a brand-new install agrees with real data about what
 * "no other prices yet" looks like. */
export function emptyJournalText(settings: { default_currency: string; main_commodity: string }): string {
  if (settings.default_currency === settings.main_commodity) return "";
  const today = formatLedgerDate(new Date());
  return `P ${today} 00:00:00 ${settings.default_currency} 1 ${settings.main_commodity}\n`;
}

// --- Config bundle (§3.2 of MOBILE_APP.md) ---------------------------------

const CONFIG_FILES: ConfigFile[] = ["app_settings", "budget_settings", "analyses", "automations"];
const MANIFEST_NAME = "manifest.json";
export const CONFIG_SCHEMA_VERSION = 1;

export interface ConfigImportResult {
  applied: ConfigFile[];
  skipped: { file: ConfigFile; reason: string }[];
}

/** Bundles the four config files verbatim into a zip, plus a schema_version
 * manifest kept alongside rather than inside them (so the four files stay
 * byte-identical to backend/data/*.json — restoring on desktop is just
 * "unzip into backend/data/", per MOBILE_APP.md §3.2). A file this install
 * has never written (still at its in-memory default) is simply omitted. */
export async function exportConfigBundle(storage: Storage): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_NAME]: strToU8(JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION }, null, 2)),
  };
  for (const file of CONFIG_FILES) {
    const value = await storage.readConfig(file);
    if (value !== null) entries[`${file}.json`] = strToU8(JSON.stringify(value, null, 2));
  }
  return zipSync(entries);
}

const JOURNAL_ENTRY_NAME = "journal.ledger";

/** Full backup bundle (§6 item 3 of the implementation plan): the journal
 * plus the same four config files exportConfigBundle produces, all in one
 * zip, for the mobile app's one-tap "Export" action (MOBILE_APP.md §9.2).
 * Kept as a distinct function rather than a mode flag on
 * exportConfigBundle: the config-only bundle (§3.2) is also independently
 * useful (e.g. restoring settings without touching the journal), and their
 * callers differ — the desktop-facing "config backup" flow in ImportScreen
 * vs. this one, mobile-only, always-both flow. */
export async function exportFullBundle(storage: Storage): Promise<Uint8Array> {
  const journalText = (await storage.readJournal()) ?? "";
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_NAME]: strToU8(JSON.stringify({ schema_version: CONFIG_SCHEMA_VERSION }, null, 2)),
    [JOURNAL_ENTRY_NAME]: strToU8(journalText),
  };
  for (const file of CONFIG_FILES) {
    const value = await storage.readConfig(file);
    if (value !== null) entries[`${file}.json`] = strToU8(JSON.stringify(value, null, 2));
  }
  return zipSync(entries);
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

async function applyConfigFile(storage: Storage, file: ConfigFile, incoming: unknown, mode: "replace" | "merge"): Promise<void> {
  if (file === "app_settings" || file === "budget_settings") {
    // Not id-keyed lists — §3.2 only offers merge-vs-replace for
    // analyses.json/automations.json. These two are always a verbatim
    // replace, same as restoring the file directly.
    await storage.writeConfig(file, incoming);
    return;
  }

  if (file === "analyses") {
    const data = incoming as { analyses?: AnalysisRecord[] };
    if (!Array.isArray(data.analyses)) throw new Error("missing `analyses` array");
    if (mode === "replace") {
      await storage.writeConfig(file, data);
      return;
    }
    const current = (await storage.readConfig(file)) as { analyses?: AnalysisRecord[] } | null;
    await storage.writeConfig(file, { analyses: mergeById(current?.analyses ?? [], data.analyses) });
    return;
  }

  // automations
  const data = incoming as { automations?: Automation[]; pending?: PendingOccurrence[]; groups?: AutomationGroup[] };
  if (!Array.isArray(data.automations) || !Array.isArray(data.pending) || !Array.isArray(data.groups)) {
    throw new Error("missing automations/pending/groups arrays");
  }
  if (mode === "replace") {
    await storage.writeConfig(file, data);
    return;
  }
  const current = (await storage.readConfig(file)) as
    | { automations?: Automation[]; pending?: PendingOccurrence[]; groups?: AutomationGroup[] }
    | null;
  await storage.writeConfig(file, {
    automations: mergeById(current?.automations ?? [], data.automations),
    groups: mergeById(current?.groups ?? [], data.groups),
    // The pending queue never merges, even under mode:"merge" — unioning it
    // with a stale bundle's entries risks resurrecting an occurrence already
    // approved and removed elsewhere, which would then double-post
    // (MOBILE_APP.md §3.2). It's always taken from the bundle wholesale.
    pending: data.pending,
  });
}

/** Unzips a config bundle (§3.2) and applies each of the four files it
 * contains all-or-nothing per file: a file that's missing from the bundle is
 * left untouched, and a file that fails to parse or validate is skipped
 * without affecting the others. `mode` only affects analyses.json/
 * automations.json (see applyConfigFile); the other two always replace. */
export async function importConfig(storage: Storage, bundle: Uint8Array, mode: "replace" | "merge"): Promise<ConfigImportResult> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bundle);
  } catch (e) {
    return { applied: [], skipped: CONFIG_FILES.map((file) => ({ file, reason: `not a valid zip: ${(e as Error).message}` })) };
  }

  const manifestRaw = files[MANIFEST_NAME];
  if (manifestRaw) {
    try {
      const manifest = JSON.parse(strFromU8(manifestRaw)) as { schema_version?: number };
      if (typeof manifest.schema_version === "number" && manifest.schema_version > CONFIG_SCHEMA_VERSION) {
        const reason = `bundle schema_version ${manifest.schema_version} is newer than this app supports (${CONFIG_SCHEMA_VERSION})`;
        return { applied: [], skipped: CONFIG_FILES.map((file) => ({ file, reason })) };
      }
    } catch {
      // Malformed manifest doesn't block per-file import — schema_version is
      // informational; the per-file try/catch below is what actually
      // protects each config file from a bad bundle.
    }
  }

  const applied: ConfigFile[] = [];
  const skipped: { file: ConfigFile; reason: string }[] = [];

  for (const file of CONFIG_FILES) {
    const raw = files[`${file}.json`];
    if (!raw) continue; // absent from the bundle -> current config untouched

    let incoming: unknown;
    try {
      incoming = JSON.parse(strFromU8(raw));
    } catch (e) {
      skipped.push({ file, reason: `invalid JSON: ${(e as Error).message}` });
      continue;
    }

    try {
      await applyConfigFile(storage, file, incoming, mode);
      applied.push(file);
    } catch (e) {
      skipped.push({ file, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { applied, skipped };
}
