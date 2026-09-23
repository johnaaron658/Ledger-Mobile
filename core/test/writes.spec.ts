// Phase 2 write-path smoke test: the golden fixtures only cover read
// endpoints (they're captured from a running FastAPI GET/POST against a
// frozen snapshot — the desktop's own journal_edit.py mutations were never
// part of that capture). This exercises journalEdit.ts/budgets.ts's/
// commodities.ts's write functions end-to-end against a scratch copy of the
// real journal, self-skipping like oracle-parity.spec.ts when the oracle
// isn't present.

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalApi } from "../src/api.js";
import { NodeStorage } from "../src/nodeStorage.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const ORACLE_DIR = process.env.ORACLE_LEDGER_DIR ?? path.resolve(REPO_ROOT, "../../Finance-oracle");
const ORACLE_JOURNAL = path.join(ORACLE_DIR, "transactions.ledger");
const hasOracle = existsSync(ORACLE_JOURNAL);

describe.skipIf(!hasOracle)("write paths against a scratch copy of the real journal", () => {
  let journalPath: string;
  let api: ReturnType<typeof createLocalApi>;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ledger-core-write-test-"));
    journalPath = path.join(dir, "transactions.ledger");
    const { copyFileSync, mkdirSync, writeFileSync } = await import("node:fs");
    copyFileSync(ORACLE_JOURNAL, journalPath);
    const configDir = path.join(dir, "config");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, "app_settings.json"), JSON.stringify({ default_currency: "₱", main_commodity: "PHP" }));
    const storage = new NodeStorage(journalPath, configDir);
    api = createLocalApi(storage, journalPath);
  });

  it("adds a transaction and it round-trips through getTransactions", async () => {
    const before = (await api.getTransactions()) as any[];
    const result = await api.addTransaction({
      date: "2025/01/01",
      payee: "Write Path Smoke Test",
      postings: [
        { account: "Expenses:Daily", amount_raw: "₱123.45" },
        { account: "Assets:Checking:Banking:BDO:5609" },
      ],
    });
    expect(result.ok).toBe(true);
    const after = (await api.getTransactions()) as any[];
    expect(after.length).toBe(before.length + 1);
    const added = after.find((t) => t.payee === "Write Path Smoke Test");
    expect(added).toBeTruthy();
    expect(added.postings[0].amount_raw).toContain("123.45");
  });

  it("rejects an unbalanced transaction without writing it", async () => {
    const before = readFileSync(journalPath, "utf-8");
    await expect(
      api.addTransaction({
        date: "2025/01/01",
        payee: "Unbalanced",
        postings: [
          { account: "Expenses:Daily", amount_raw: "₱100.00" },
          { account: "Assets:Checking:Banking:BDO:5609", amount_raw: "-₱50.00" },
        ],
      }),
    ).rejects.toThrow();
    expect(readFileSync(journalPath, "utf-8")).toBe(before);
  });

  it("edits then deletes a transaction", async () => {
    const added = await api.addTransaction({
      date: "2025/01/02",
      payee: "Edit Me",
      postings: [{ account: "Expenses:Daily", amount_raw: "₱10.00" }, { account: "Assets:Checking:Banking:BDO:5609" }],
    });
    expect(added.ok).toBe(true);
    let txns = (await api.getTransactions()) as any[];
    let txn = txns.find((t) => t.payee === "Edit Me");
    expect(txn).toBeTruthy();

    const edited = await api.editTransaction({
      file: journalPath,
      beg_line: txn.beg_line,
      end_line: txn.end_line,
      date: "2025/01/02",
      payee: "Edited Payee",
      postings: [{ account: "Expenses:Daily", amount_raw: "₱20.00" }, { account: "Assets:Checking:Banking:BDO:5609" }],
    });
    expect(edited.ok).toBe(true);
    txns = (await api.getTransactions()) as any[];
    expect(txns.some((t) => t.payee === "Edited Payee")).toBe(true);
    expect(txns.some((t) => t.payee === "Edit Me")).toBe(false);

    txn = txns.find((t) => t.payee === "Edited Payee");
    const deleted = await api.deleteTransaction({ file: journalPath, beg_line: txn.beg_line, end_line: txn.end_line });
    expect(deleted.ok).toBe(true);
    txns = (await api.getTransactions()) as any[];
    expect(txns.some((t) => t.payee === "Edited Payee")).toBe(false);
  });

  it("adds a budget period for an existing category", async () => {
    const budgetsBefore = (await api.getBudgets()) as any[];
    const target = budgetsBefore.find((b) => b.editable);
    expect(target).toBeTruthy();
    const result = await api.addBudgetPeriod(target.account, "Monthly from 2026/09", "₱999.00");
    expect(result.ok).toBe(true);
    const budgetsAfter = (await api.getBudgets()) as any[];
    const updated = budgetsAfter.find((b) => b.account === target.account);
    expect(updated.active_period).toBe("Monthly from 2026/09");
    expect(updated.budgeted).toBe(999);
  });

  it("adds and deletes a commodity price point", async () => {
    const result = await api.addCommodityPrice({ commodity: "EUR", date: "2026/09/01", amount_raw: "65.00", price_commodity: "PHP" });
    expect(result.ok).toBe(true);
    let commodities = (await api.getCommodities()) as any[];
    expect(commodities.some((c) => c.commodity === "EUR")).toBe(true);

    const deleted = await api.deleteCommodity("EUR");
    expect(deleted.ok).toBe(true);
    commodities = (await api.getCommodities()) as any[];
    expect(commodities.some((c) => c.commodity === "EUR")).toBe(false);
  });

  it("creates an automation, catches up a pending occurrence, and approves it into the journal", async () => {
    const automation = await api.createAutomation({
      name: "Smoke Test Automation",
      period: "monthly",
      start_date: "2020/01/01",
      template: "$[date] Automation Smoke Test\n    Expenses:Daily    ₱$[amount]\n    Assets:Checking:Banking:BDO:5609\n",
      variable_defaults: { amount: "50.00" },
    });
    expect(automation.next_due).toBeTruthy();

    const pending = (await api.getPendingAutomations()) as any[];
    const occurrence = pending.find((p) => p.automation_id === automation.id);
    expect(occurrence).toBeTruthy();

    const preview = await api.previewPendingAutomation(occurrence.id);
    expect(preview.rendered).toContain("Automation Smoke Test");
    expect(preview.rendered).toContain("₱50.00");

    const before = (await api.getTransactions()) as any[];
    const approved = await api.approvePendingAutomation(occurrence.id);
    expect(approved.ok).toBe(true);
    const after = (await api.getTransactions()) as any[];
    expect(after.length).toBe(before.length + 1);
    expect(after.some((t) => t.payee === "Automation Smoke Test")).toBe(true);

    const pendingAfter = (await api.getPendingAutomations()) as any[];
    expect(pendingAfter.some((p) => p.id === occurrence.id)).toBe(false);
  });
});
