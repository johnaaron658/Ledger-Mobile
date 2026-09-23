// Phase 5 (§6 items 4-5 of the implementation plan / §9.2 of MOBILE_APP.md):
// atomic-write-adjacent undo, the export-staleness nudge, and the retained-
// export ring — all pure logic over the Storage port, so it's testable in
// Node without any Capacitor/device involvement (see mobileState.spec.ts).
// The atomic part of "atomic write" itself is each Storage implementation's
// own job (temp -> fsync/rename, see nodeStorage.ts/capacitorStorage.ts);
// this module is the bookkeeping layered on top.

import type { Storage } from "./store.js";

export interface UndoState {
  previousText: string;
  message: string;
  timestamp: string; // ISO 8601
}

export interface WriteStats {
  writesSinceExport: number;
  lastExportAt: string | null; // ISO 8601, null = never exported
}

export interface ExportRecord {
  id: string;
  timestamp: string; // ISO 8601
  label: string;
  sizeBytes: number;
}

const UNDO_KEY = "undo";
const STATS_KEY = "write_stats";
const EXPORT_INDEX_KEY = "export_history";
const MAX_RETAINED_EXPORTS = 5;

function exportPayloadKey(id: string): string {
  return `export_payload:${id}`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readStats(storage: Storage): Promise<WriteStats> {
  const stored = (await storage.readState(STATS_KEY)) as WriteStats | null;
  return stored ?? { writesSinceExport: 0, lastExportAt: null };
}

/** Decorator (§4.4 of MOBILE_APP.md, §6 item 4 of the plan): wraps a base
 * Storage and, on every message-carrying journal write, captures
 * single-level undo (previous text + message) and bumps
 * `writesSinceExport` for the staleness nudge (item 5). A write with no
 * message (first-run import, start-a-new-journal, config restore, or
 * undoLastWrite's own restoring write) passes straight through — those
 * aren't user edits to offer "undo" on, and importJournal/startNewJournal
 * already have their own confirmation flow (§5.4).
 *
 * Composes with any base Storage: `new TrackingStorage(new
 * CapacitorStorage())` on mobile, `new TrackingStorage(new
 * BrowserStorage())` for the web build — see frontend/src/api.js. */
export class TrackingStorage implements Storage {
  constructor(private inner: Storage) {}

  readJournal(): Promise<string | null> {
    return this.inner.readJournal();
  }

  async writeJournal(text: string, message?: string): Promise<void> {
    if (!message) {
      await this.inner.writeJournal(text);
      return;
    }
    const previousText = (await this.inner.readJournal()) ?? "";
    await this.inner.writeJournal(text, message);
    const undo: UndoState = { previousText, message, timestamp: new Date().toISOString() };
    await this.inner.writeState(UNDO_KEY, undo);
    const stats = await readStats(this.inner);
    await this.inner.writeState(STATS_KEY, { ...stats, writesSinceExport: stats.writesSinceExport + 1 });
  }

  readConfig(name: Parameters<Storage["readConfig"]>[0]): Promise<unknown | null> {
    return this.inner.readConfig(name);
  }
  writeConfig(name: Parameters<Storage["writeConfig"]>[0], value: unknown): Promise<void> {
    return this.inner.writeConfig(name, value);
  }
  readState(key: string): Promise<unknown | null> {
    return this.inner.readState(key);
  }
  writeState(key: string, value: unknown | null): Promise<void> {
    return this.inner.writeState(key, value);
  }
}

export async function getUndoState(storage: Storage): Promise<UndoState | null> {
  return (await storage.readState(UNDO_KEY)) as UndoState | null;
}

/** Single-level undo (§4.4/§6 item 4): restores the journal to the text
 * before the last tracked write, then clears the slot. There is no redo and
 * no stacking — undoing twice in a row is a no-op the second time, matching
 * "single-level" in the plan. Deliberately does NOT decrement
 * writesSinceExport: an undone edit still happened and the journal on disk
 * changed twice, so the staleness nudge should still reflect that activity
 * rather than pretend the edit-then-undo never occurred. */
export async function undoLastWrite(storage: Storage): Promise<{ ok: boolean; message?: string }> {
  const undo = await getUndoState(storage);
  if (!undo) return { ok: false };
  await storage.writeJournal(undo.previousText); // no message: this restoring write isn't itself undoable
  await storage.writeState(UNDO_KEY, null);
  return { ok: true, message: undo.message };
}

export async function getWriteStats(storage: Storage): Promise<WriteStats> {
  return readStats(storage);
}

export interface ExportNudge {
  writesSinceExport: number;
  daysSinceExport: number | null; // null = never exported
}

/** §9.2/item 5: "N writes / D days since your last export" nudge input —
 * pure data, no threshold/formatting decision here (that's a UI concern). */
export async function getExportNudge(storage: Storage, now: Date = new Date()): Promise<ExportNudge> {
  const stats = await readStats(storage);
  const daysSinceExport =
    stats.lastExportAt == null ? null : Math.floor((now.getTime() - new Date(stats.lastExportAt).getTime()) / 86_400_000);
  return { writesSinceExport: stats.writesSinceExport, daysSinceExport };
}

/** Records a completed export (§6 item 4, §9.2's "keep the last N exports in
 * app storage too" mitigation): retains the exported bytes (typically the
 * whole journal+config zip from exportBundle in api.ts) up to
 * MAX_RETAINED_EXPORTS, evicting the oldest, and resets the staleness
 * nudge. Called once the export artifact is built and handed to the share
 * sheet/picker, regardless of whether the user actually completes that flow
 * — MOBILE_APP.md §9.2 frames the risk as export friction, not confirmation,
 * so "the app produced an export" is the right signal to reset on. */
export async function recordExport(storage: Storage, bytes: Uint8Array, label: string): Promise<ExportRecord> {
  const record: ExportRecord = { id: newId(), timestamp: new Date().toISOString(), label, sizeBytes: bytes.byteLength };
  const index = ((await storage.readState(EXPORT_INDEX_KEY)) as ExportRecord[] | null) ?? [];
  const combined = [record, ...index];
  const kept = combined.slice(0, MAX_RETAINED_EXPORTS);
  const evicted = combined.slice(MAX_RETAINED_EXPORTS);

  await storage.writeState(exportPayloadKey(record.id), bytesToBase64(bytes));
  await storage.writeState(EXPORT_INDEX_KEY, kept);
  for (const old of evicted) await storage.writeState(exportPayloadKey(old.id), null);
  await storage.writeState(STATS_KEY, { writesSinceExport: 0, lastExportAt: record.timestamp });

  return record;
}

export async function listRetainedExports(storage: Storage): Promise<ExportRecord[]> {
  return ((await storage.readState(EXPORT_INDEX_KEY)) as ExportRecord[] | null) ?? [];
}

export async function getRetainedExportBytes(storage: Storage, id: string): Promise<Uint8Array | null> {
  const b64 = (await storage.readState(exportPayloadKey(id))) as string | null;
  return b64 == null ? null : base64ToBytes(b64);
}

// --- base64 helpers ---------------------------------------------------
// Hand-rolled rather than btoa/Buffer: btoa/atob operate on JS "binary
// strings" (one UTF-16 code unit per byte) which is fiddly to get right from
// a Uint8Array without an intermediate string allocation, and Buffer isn't
// available in the browser bundle this module ships in (it's re-exported
// from core's barrel, unlike nodeStorage.ts/capacitorStorage.ts). A direct
// byte-array codec avoids both.

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : B64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : B64_CHARS[b2 & 0x3f];
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const val = B64_CHARS.indexOf(ch);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
