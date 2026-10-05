import { describe, expect, it } from "vitest";
import { createLocalApi } from "../src/api.js";
import type { ConfigFile, Storage } from "../src/store.js";

class MemoryStorage implements Storage {
  journal: string | null = null;
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

const JOURNAL = `2026/01/05 Grocer
    Expenses:Food    100 PHP
    Assets:Cash
`;

function setup() {
  const storage = new MemoryStorage();
  storage.journal = JOURNAL;
  return { storage, api: createLocalApi(storage) };
}

const planned = {
  payee: "Laptop",
  postings: [{ account: "Expenses:Gadgets", amount_raw: "5,000 PHP" }, { account: "Assets:Cash" }],
};

describe("virtual transactions", () => {
  it("are listed with the elided amount filled in, and never touch the journal", async () => {
    const { storage, api } = setup();
    await api.addVirtualTransaction(planned);
    expect(storage.journal).toBe(JOURNAL);
    const [v] = await api.getVirtualTransactions();
    expect(v.payee).toBe("Laptop");
    expect(v.postings.map((p) => p.amount_raw)).toEqual(["5,000 PHP", "-5,000 PHP"]);
    expect((await api.getTransactions()).map((t) => t.payee)).toEqual(["Grocer"]);
  });

  it("rejects one that doesn't balance", async () => {
    const { api } = setup();
    await expect(
      api.addVirtualTransaction({
        payee: "Bad",
        postings: [{ account: "Expenses:A", amount_raw: "1 PHP" }, { account: "Assets:Cash", amount_raw: "2 PHP" }],
      }),
    ).rejects.toThrow(/does not balance/);
    expect(await api.getVirtualTransactions()).toEqual([]);
  });

  it("round-trips a journal transaction through virtual and back", async () => {
    const { storage, api } = setup();
    const [t] = await api.getTransactions();
    const v = await api.makeTransactionVirtual({ file: t.file, beg_line: t.beg_line, end_line: t.end_line, payee: t.payee, postings: t.postings });
    expect(await api.getTransactions()).toEqual([]);
    expect((await api.getVirtualTransactions()).map((x) => x.id)).toEqual([v.id]);

    await api.postVirtualTransaction({ id: v.id, date: "2026/02/01", payee: v.payee, postings: v.postings });
    expect(await api.getVirtualTransactions()).toEqual([]);
    const [posted] = await api.getTransactions();
    expect(posted.date).toBe("2026/02/01");
    expect(storage.journal).toContain("Grocer");
  });

  it("count in analysis by payee regardless of the date range", async () => {
    const { api } = setup();
    await api.addVirtualTransaction(planned);
    const result = await api.computeAnalysis({
      start_date: "2026/01/01",
      end_date: "2026/01/31",
      categories: [{ name: "Big", payees: ["Laptop"] }],
    });
    expect(result.categories[0].total).toBe(5000);
    expect(result.payees.find((p) => p.name === "Laptop")).toEqual({ name: "Laptop", total: 5000, virtual: true });
    expect(result.payees.find((p) => p.name === "Grocer")).toEqual({ name: "Grocer", total: 100 });
  });
});
