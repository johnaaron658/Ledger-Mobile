// Exercises browserStorage.ts's Storage contract against fake-indexeddb, the
// same interface nodeStorage.ts implements for Node — so the two are
// interchangeable from `core`'s point of view (§5.3).

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { BrowserStorage } from "../src/browserStorage.js";

function freshStorage(): BrowserStorage {
  // Each test gets its own DB name so fake-indexeddb's shared global
  // registry doesn't leak state across specs.
  return new BrowserStorage(`test-${Math.random().toString(36).slice(2)}`);
}

describe("BrowserStorage", () => {
  it("readJournal returns null before anything is written", async () => {
    const storage = freshStorage();
    expect(await storage.readJournal()).toBeNull();
  });

  it("round-trips a journal write", async () => {
    const storage = freshStorage();
    await storage.writeJournal("2024/01/01 Test\n  Assets:Cash  100 PHP\n  Expenses:Misc\n");
    expect(await storage.readJournal()).toBe("2024/01/01 Test\n  Assets:Cash  100 PHP\n  Expenses:Misc\n");
  });

  it("overwrites a previous journal write", async () => {
    const storage = freshStorage();
    await storage.writeJournal("first");
    await storage.writeJournal("second");
    expect(await storage.readJournal()).toBe("second");
  });

  it("readConfig returns null for a config file never written", async () => {
    const storage = freshStorage();
    expect(await storage.readConfig("app_settings")).toBeNull();
  });

  it("round-trips config values independently per file", async () => {
    const storage = freshStorage();
    await storage.writeConfig("app_settings", { default_currency: "₱", main_commodity: "PHP" });
    await storage.writeConfig("budget_settings", { excluded_accounts: ["Assets:Cash"] });
    expect(await storage.readConfig("app_settings")).toEqual({ default_currency: "₱", main_commodity: "PHP" });
    expect(await storage.readConfig("budget_settings")).toEqual({ excluded_accounts: ["Assets:Cash"] });
  });

  it("journal and config keys don't collide", async () => {
    const storage = freshStorage();
    await storage.writeJournal("journal text");
    await storage.writeConfig("app_settings", { default_currency: "$" });
    expect(await storage.readJournal()).toBe("journal text");
    expect(await storage.readConfig("app_settings")).toEqual({ default_currency: "$" });
  });

  it("a second instance pointed at the same db name sees prior writes", async () => {
    const dbName = `test-${Math.random().toString(36).slice(2)}`;
    await new BrowserStorage(dbName).writeJournal("persisted");
    expect(await new BrowserStorage(dbName).readJournal()).toBe("persisted");
  });
});
