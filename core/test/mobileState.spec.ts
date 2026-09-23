// Phase 5 (§6 items 4-5): atomic-write-adjacent undo, the export-staleness
// nudge, and the retained-export ring — exercised against a plain in-memory
// Storage, same rationale as importExport.spec.ts (this is about the
// bookkeeping semantics, not a storage backend).

import { describe, expect, it } from "vitest";
import type { ConfigFile, Storage } from "../src/store.js";
import {
  TrackingStorage,
  getExportNudge,
  getRetainedExportBytes,
  getUndoState,
  getWriteStats,
  listRetainedExports,
  recordExport,
  undoLastWrite,
} from "../src/mobileState.js";

class MemoryStorage implements Storage {
  private journal: string | null = null;
  private config = new Map<ConfigFile, unknown>();
  private state = new Map<string, unknown>();

  async readJournal() {
    return this.journal;
  }
  async writeJournal(text: string) {
    this.journal = text;
  }
  async readConfig(name: ConfigFile) {
    return this.config.has(name) ? this.config.get(name)! : null;
  }
  async writeConfig(name: ConfigFile, value: unknown) {
    this.config.set(name, value);
  }
  async readState(key: string) {
    return this.state.has(key) ? this.state.get(key)! : null;
  }
  async writeState(key: string, value: unknown) {
    if (value === null) this.state.delete(key);
    else this.state.set(key, value);
  }
}

describe("TrackingStorage", () => {
  it("passes through a message-less write untouched (no undo, no stats bump)", async () => {
    const base = new MemoryStorage();
    const tracked = new TrackingStorage(base);
    await tracked.writeJournal("first import");
    expect(await tracked.readJournal()).toBe("first import");
    expect(await getUndoState(base)).toBeNull();
    expect((await getWriteStats(base)).writesSinceExport).toBe(0);
  });

  it("captures previous text + message on a tracked write, and bumps writesSinceExport", async () => {
    const base = new MemoryStorage();
    const tracked = new TrackingStorage(base);
    await tracked.writeJournal("v1"); // untracked seed
    await tracked.writeJournal("v2", "dashboard: add transaction 2025/03/04 Jollibee");

    const undo = await getUndoState(base);
    expect(undo).toEqual(
      expect.objectContaining({ previousText: "v1", message: "dashboard: add transaction 2025/03/04 Jollibee" }),
    );
    expect(typeof undo!.timestamp).toBe("string");
    expect((await getWriteStats(base)).writesSinceExport).toBe(1);
  });

  it("each tracked write overwrites the previous undo slot (single-level only)", async () => {
    const base = new MemoryStorage();
    const tracked = new TrackingStorage(base);
    await tracked.writeJournal("v1", "add A");
    await tracked.writeJournal("v2", "add B");
    const undo = await getUndoState(base);
    expect(undo?.previousText).toBe("v1");
    expect(undo?.message).toBe("add B");
  });

  it("bumps writesSinceExport once per tracked write, cumulatively", async () => {
    const base = new MemoryStorage();
    const tracked = new TrackingStorage(base);
    await tracked.writeJournal("v1", "add A");
    await tracked.writeJournal("v2", "add B");
    await tracked.writeJournal("v3", "add C");
    expect((await getWriteStats(base)).writesSinceExport).toBe(3);
  });
});

describe("undoLastWrite", () => {
  it("returns ok:false with no prior tracked write", async () => {
    const storage = new MemoryStorage();
    expect(await undoLastWrite(storage)).toEqual({ ok: false });
  });

  it("restores the journal to the pre-write text and returns the write's message", async () => {
    const base = new MemoryStorage();
    const tracked = new TrackingStorage(base);
    await tracked.writeJournal("v1", "add A");
    await tracked.writeJournal("v2", "add B");

    const result = await undoLastWrite(base);
    expect(result).toEqual({ ok: true, message: "add B" });
    expect(await base.readJournal()).toBe("v1");
  });

  it("clears the undo slot after use — a second undo is a no-op", async () => {
    const base = new MemoryStorage();
    const tracked = new TrackingStorage(base);
    await tracked.writeJournal("v1", "add A");
    await tracked.writeJournal("v2", "add B");

    await undoLastWrite(base);
    expect(await undoLastWrite(base)).toEqual({ ok: false });
    expect(await base.readJournal()).toBe("v1"); // unchanged by the no-op
  });

  it("restoring write is itself untracked, so undoing an undo is not possible", async () => {
    const base = new MemoryStorage();
    const tracked = new TrackingStorage(base);
    await tracked.writeJournal("v1", "add A");
    await tracked.writeJournal("v2", "add B");
    await undoLastWrite(base);
    expect(await getUndoState(base)).toBeNull();
  });

  it("does not reset writesSinceExport — the edit-then-undo still counts as activity", async () => {
    const base = new MemoryStorage();
    const tracked = new TrackingStorage(base);
    await tracked.writeJournal("v1", "add A");
    await undoLastWrite(base);
    expect((await getWriteStats(base)).writesSinceExport).toBe(1);
  });
});

describe("getExportNudge", () => {
  it("reports null daysSinceExport and zero writes for a fresh install", async () => {
    const storage = new MemoryStorage();
    expect(await getExportNudge(storage)).toEqual({ writesSinceExport: 0, daysSinceExport: null });
  });

  it("counts days elapsed since the last export", async () => {
    const storage = new MemoryStorage();
    await storage.writeState("write_stats", { writesSinceExport: 4, lastExportAt: "2026-09-10T00:00:00.000Z" });
    const nudge = await getExportNudge(storage, new Date("2026-09-24T12:00:00.000Z"));
    expect(nudge).toEqual({ writesSinceExport: 4, daysSinceExport: 14 });
  });
});

describe("recordExport / listRetainedExports / getRetainedExportBytes", () => {
  it("retains the exported bytes and resets the staleness nudge", async () => {
    const base = new MemoryStorage();
    const tracked = new TrackingStorage(base);
    await tracked.writeJournal("v1", "add A");
    await tracked.writeJournal("v2", "add B");
    expect((await getWriteStats(base)).writesSinceExport).toBe(2);

    const bytes = new TextEncoder().encode("fake zip bytes");
    const record = await recordExport(base, bytes, "manual export");

    expect((await getWriteStats(base)).writesSinceExport).toBe(0);
    const nudge = await getExportNudge(base);
    expect(nudge.daysSinceExport).toBe(0);

    const listed = await listRetainedExports(base);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(record);

    const roundTripped = await getRetainedExportBytes(base, record.id);
    expect(roundTripped).toEqual(bytes);
  });

  it("round-trips bytes that aren't a multiple of 3 in length (base64 padding)", async () => {
    const storage = new MemoryStorage();
    for (const text of ["", "a", "ab", "abc", "abcd", "☃ snowman"]) {
      const bytes = new TextEncoder().encode(text);
      const record = await recordExport(storage, bytes, text);
      const roundTripped = await getRetainedExportBytes(storage, record.id);
      expect(roundTripped).toEqual(bytes);
    }
  });

  it("keeps only the last N exports, evicting the oldest payload", async () => {
    const storage = new MemoryStorage();
    const records = [];
    for (let i = 0; i < 7; i++) {
      records.push(await recordExport(storage, new TextEncoder().encode(`export ${i}`), `export ${i}`));
    }
    const listed = await listRetainedExports(storage);
    expect(listed).toHaveLength(5);
    // newest first
    expect(listed.map((r) => r.label)).toEqual(["export 6", "export 5", "export 4", "export 3", "export 2"]);

    // evicted payloads are gone
    expect(await getRetainedExportBytes(storage, records[0].id)).toBeNull();
    expect(await getRetainedExportBytes(storage, records[1].id)).toBeNull();
    // retained payloads are still readable
    expect(await getRetainedExportBytes(storage, records[6].id)).toEqual(new TextEncoder().encode("export 6"));
  });

  it("getRetainedExportBytes returns null for an unknown id", async () => {
    const storage = new MemoryStorage();
    expect(await getRetainedExportBytes(storage, "nope")).toBeNull();
  });
});
