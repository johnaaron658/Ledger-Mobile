// §5.4's import/export logic, exercised against a plain in-memory Storage —
// deliberately not BrowserStorage/NodeStorage, since this file is about
// import/export semantics, not the storage backend (that's
// browserStorage.spec.ts's job).

import { describe, expect, it } from "vitest";
import type { ConfigFile, Storage } from "../src/store.js";
import {
  emptyJournalText,
  exportConfigBundle,
  importConfig,
  importJournal,
} from "../src/importExport.js";

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

const VALID_JOURNAL = [
  "P 2024/01/01 00:00:00 ₱ 1 PHP",
  "",
  "2024/01/05 Payee One",
  "  Assets:Cash  -100 PHP",
  "  Expenses:Misc  100 PHP",
  "",
  "2024/02/10 Payee Two",
  "  Assets:Cash  -50 PHP",
  "  Expenses:Misc  50 PHP",
  "",
].join("\n");

describe("importJournal", () => {
  it("accepts a valid journal and reports counts", async () => {
    const storage = new MemoryStorage();
    const result = await importJournal(storage, VALID_JOURNAL);
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({
      transactions: 2,
      periodics: 0,
      prices: 1,
      dateRange: ["2024/01/05", "2024/02/10"],
    });
    expect(await storage.readJournal()).toBe(VALID_JOURNAL);
  });

  it("does not persist a journal that doesn't balance", async () => {
    const storage = new MemoryStorage();
    const bad = "2024/01/05 Payee\n  Assets:Cash  -100 PHP\n  Expenses:Misc  99 PHP\n";
    const result = await importJournal(storage, bad);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].message).toMatch(/does not balance/);
    expect(await storage.readJournal()).toBeNull();
  });

  it("does not persist a journal with more than one elided posting in a block", async () => {
    const storage = new MemoryStorage();
    const bad = "2024/01/05 Payee\n  Assets:Cash\n  Expenses:Misc\n  Expenses:Other\n";
    const result = await importJournal(storage, bad);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].message).toMatch(/more than one amount-less posting/);
    expect(await storage.readJournal()).toBeNull();
  });

  it("rejects a journal using `include` with a clear, named error", async () => {
    const storage = new MemoryStorage();
    const text = "include transactions.ledger\n2024/01/05 Payee\n  Assets:Cash  -1 PHP\n  Expenses:Misc  1 PHP\n";
    const result = await importJournal(storage, text);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].message).toMatch(/include/);
    expect(result.errors?.[0].line).toBe(1);
    expect(await storage.readJournal()).toBeNull();
  });

  it("accepts an empty journal", async () => {
    const storage = new MemoryStorage();
    const result = await importJournal(storage, "");
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ transactions: 0, periodics: 0, prices: 0, dateRange: null });
  });
});

describe("emptyJournalText", () => {
  it("seeds an identity price when default_currency and main_commodity differ", () => {
    const text = emptyJournalText({ default_currency: "₱", main_commodity: "PHP" });
    expect(text).toMatch(/^P \d{4}\/\d{2}\/\d{2} 00:00:00 ₱ 1 PHP\n$/);
  });

  it("is empty when they're the same commodity", () => {
    expect(emptyJournalText({ default_currency: "USD", main_commodity: "USD" })).toBe("");
  });

  it("round-trips through importJournal as a valid, empty-of-transactions journal", async () => {
    const storage = new MemoryStorage();
    const text = emptyJournalText({ default_currency: "₱", main_commodity: "PHP" });
    const result = await importJournal(storage, text);
    expect(result.ok).toBe(true);
    expect(result.counts?.transactions).toBe(0);
  });
});

describe("config bundle export/import", () => {
  it("round-trips all four files through a zip", async () => {
    const source = new MemoryStorage();
    await source.writeConfig("app_settings", { default_currency: "₱", main_commodity: "PHP" });
    await source.writeConfig("budget_settings", { excluded_accounts: ["Assets:Cash"] });
    await source.writeConfig("analyses", { analyses: [{ id: "a1", name: "Wedding" }] });
    await source.writeConfig("automations", { automations: [{ id: "au1", name: "Rent" }], pending: [], groups: [] });

    const bundle = await exportConfigBundle(source);
    const dest = new MemoryStorage();
    const result = await importConfig(dest, bundle, "replace");

    expect(result.applied.sort()).toEqual(["analyses", "app_settings", "automations", "budget_settings"]);
    expect(result.skipped).toEqual([]);
    expect(await dest.readConfig("app_settings")).toEqual({ default_currency: "₱", main_commodity: "PHP" });
    expect(await dest.readConfig("budget_settings")).toEqual({ excluded_accounts: ["Assets:Cash"] });
    expect(await dest.readConfig("analyses")).toEqual({ analyses: [{ id: "a1", name: "Wedding" }] });
  });

  it("omits a file from the bundle when this install never wrote it", async () => {
    const source = new MemoryStorage();
    await source.writeConfig("app_settings", { default_currency: "$", main_commodity: "USD" });
    const bundle = await exportConfigBundle(source);

    const dest = new MemoryStorage();
    await dest.writeConfig("budget_settings", { excluded_accounts: ["untouched"] });
    const result = await importConfig(dest, bundle, "replace");

    expect(result.applied).toEqual(["app_settings"]);
    expect(await dest.readConfig("budget_settings")).toEqual({ excluded_accounts: ["untouched"] });
  });

  it("merges analyses by id, incoming wins on conflict", async () => {
    const dest = new MemoryStorage();
    await dest.writeConfig("analyses", {
      analyses: [
        { id: "a1", name: "Old Wedding" },
        { id: "a2", name: "Groceries" },
      ],
    });

    const source = new MemoryStorage();
    await source.writeConfig("analyses", {
      analyses: [
        { id: "a1", name: "New Wedding" },
        { id: "a3", name: "Travel" },
      ],
    });
    const bundle = await exportConfigBundle(source);

    const result = await importConfig(dest, bundle, "merge");
    expect(result.applied).toEqual(["analyses"]);
    const merged = (await dest.readConfig("analyses")) as { analyses: { id: string; name: string }[] };
    expect(merged.analyses.map((a) => [a.id, a.name]).sort()).toEqual([
      ["a1", "New Wedding"],
      ["a2", "Groceries"],
      ["a3", "Travel"],
    ]);
  });

  it("merges automations/groups by id but always replaces the pending queue wholesale", async () => {
    const dest = new MemoryStorage();
    await dest.writeConfig("automations", {
      automations: [{ id: "au1", name: "Rent (old)" }],
      pending: [{ id: "p1", automation_id: "au1" }],
      groups: [{ id: "g1", name: "Fixed" }],
    });

    const source = new MemoryStorage();
    await source.writeConfig("automations", {
      automations: [
        { id: "au1", name: "Rent" },
        { id: "au2", name: "Internet" },
      ],
      pending: [{ id: "p2", automation_id: "au2" }],
      groups: [{ id: "g2", name: "Subscriptions" }],
    });
    const bundle = await exportConfigBundle(source);

    const result = await importConfig(dest, bundle, "merge");
    expect(result.applied).toEqual(["automations"]);
    const merged = (await dest.readConfig("automations")) as {
      automations: { id: string; name: string }[];
      pending: { id: string }[];
      groups: { id: string; name: string }[];
    };
    expect(merged.automations.map((a) => a.id).sort()).toEqual(["au1", "au2"]);
    expect(merged.automations.find((a) => a.id === "au1")?.name).toBe("Rent");
    expect(merged.groups.map((g) => g.id).sort()).toEqual(["g1", "g2"]);
    // Not [p1, p2] — pending is replaced wholesale with the bundle's own list.
    expect(merged.pending.map((p) => p.id)).toEqual(["p2"]);
  });

  it("skips a file with invalid JSON without touching the others", async () => {
    const dest = new MemoryStorage();
    await dest.writeConfig("app_settings", { default_currency: "untouched", main_commodity: "X" });

    const source = new MemoryStorage();
    await source.writeConfig("app_settings", { default_currency: "₱", main_commodity: "PHP" });
    const goodBundle = await exportConfigBundle(source);

    // Corrupt the analyses.json entry inside the zip by re-zipping with bad bytes.
    const { unzipSync, zipSync, strToU8 } = await import("fflate");
    const files = unzipSync(goodBundle);
    files["analyses.json"] = strToU8("{not json");
    const badBundle = zipSync(files);

    const result = await importConfig(dest, badBundle, "replace");
    expect(result.applied).toEqual(["app_settings"]);
    expect(result.skipped).toEqual([{ file: "analyses", reason: expect.stringContaining("invalid JSON") }]);
    expect(await dest.readConfig("app_settings")).toEqual({ default_currency: "₱", main_commodity: "PHP" });
  });

  it("skips everything when the bundle isn't a valid zip", async () => {
    const dest = new MemoryStorage();
    const result = await importConfig(dest, new Uint8Array([1, 2, 3, 4]), "replace");
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(4);
  });

  it("skips everything when the bundle's schema_version is newer than supported", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const bundle = zipSync({
      "manifest.json": strToU8(JSON.stringify({ schema_version: 999 })),
      "app_settings.json": strToU8(JSON.stringify({ default_currency: "$", main_commodity: "USD" })),
    });
    const dest = new MemoryStorage();
    const result = await importConfig(dest, bundle, "replace");
    expect(result.applied).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/schema_version/);
    expect(await dest.readConfig("app_settings")).toBeNull();
  });
});
