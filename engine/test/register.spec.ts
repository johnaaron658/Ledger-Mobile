import { describe, expect, it } from "vitest";
import { toNumber } from "../src/amount.js";
import { ledgerDate } from "../src/journal.js";
import { parseJournal } from "../src/parse.js";
import { buildPriceIndex } from "../src/prices.js";
import { register } from "../src/report/register.js";
import { elideAndValidateJournal } from "../src/validate.js";

function setup(text: string) {
  const journal = parseJournal(text);
  elideAndValidateJournal(journal);
  return journal;
}

describe("register — filtering, sorting, zero-hiding (shape 1 style, no valuation)", () => {
  const journal = setup(
    [
      "2024/10/22 Lazada",
      "    Expenses:Wants    ₱599.92",
      "    Liabilities:CreditCard:BPICC",
      "",
      "2024/10/20 Marugame Udon",
      "    Expenses:Deeto    ₱989.00",
      "    Liabilities:CreditCard:BPICC",
      "",
      "2024/10/25 Zero txn",
      "    Assets:Checking    ₱0",
      "    Equity:Starting Balance",
    ].join("\n"),
  );

  it("sorts by date, not document order", () => {
    const rows = register(journal);
    const dates = [...new Set(rows.map((r) => r.date.getTime()))];
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    expect(rows[0].payee).toBe("Marugame Udon"); // 10/20, before Lazada's 10/22
  });

  it("hides a zero-amount posting by default (real ledger `reg` behavior)", () => {
    const rows = register(journal);
    expect(rows.some((r) => r.payee === "Zero txn")).toBe(false);
  });

  it("includes it with includeZero: true (mirrors --empty)", () => {
    const rows = register(journal, { includeZero: true });
    expect(rows.filter((r) => r.payee === "Zero txn")).toHaveLength(2);
  });

  it("filters by account pattern, substring/regex like ledger's own arg", () => {
    const rows = register(journal, { accountPattern: /Expenses/i });
    expect(rows.every((r) => r.account.startsWith("Expenses"))).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("filters by [begin, end) with end exclusive", () => {
    const rows = register(journal, { begin: ledgerDate(2024, 10, 22), end: ledgerDate(2024, 10, 25) });
    expect(rows.map((r) => r.payee)).toEqual(["Lazada", "Lazada"]);
  });

  it("leaves amount native/unvalued and runningTotal/valuedAmount null with no valuation option", () => {
    const rows = register(journal);
    expect(rows[0].valuedAmount).toBeNull();
    expect(rows[0].runningTotal).toBeNull();
    expect(rows[0].amount!.commodity).toBe("₱");
  });
});

describe("register — sort: 'none' (analysis._reg_args style, no --sort)", () => {
  // Real journal confirms ledger's default (no --sort) order is genuine
  // FILE order, not a global date sort that merely looks sorted — a
  // projections section merged early in the file (low beg_line, future
  // date) prints before a real, earlier-dated transaction parsed later.
  // Mirrored here with an out-of-order journal.
  const journal = setup(
    [
      "2026/06/05 Later date, earlier in file",
      "    Expenses:Wedding    ₱20000",
      "    Assets:Checking",
      "",
      "2026/03/22 Earlier date, later in file",
      "    Expenses:Wedding    ₱20000",
      "    Assets:Checking",
    ].join("\n"),
  );

  it("sort: 'date' (default) sorts chronologically regardless of file order", () => {
    const rows = register(journal, { accountPattern: /Expenses/, sort: "date" });
    expect(rows.map((r) => r.payee)).toEqual(["Earlier date, later in file", "Later date, earlier in file"]);
  });

  it("sort: 'none' preserves file/parse order instead", () => {
    const rows = register(journal, { accountPattern: /Expenses/, sort: "none" });
    expect(rows.map((r) => r.payee)).toEqual(["Later date, earlier in file", "Earlier date, later in file"]);
  });

  it("sort: 'none' still processes revaluation checkpoints chronologically, placing them after every real row", () => {
    const revalJournal = setup(
      [
        "P 2024/01/01 00:00:00 AED 15.00 PHP",
        "P 2024/06/01 00:00:00 AED 16.00 PHP",
        "",
        "2024/12/01 Later in file, still within range",
        "    Expenses:Currency:AED    AED10.00",
        "    Assets:Checking",
        "",
        "2024/02/01 Earlier date",
        "    Expenses:Currency:AED    AED10.00",
        "    Assets:Checking",
      ].join("\n"),
    );
    const index = buildPriceIndex(revalJournal);
    const rows = register(revalJournal, { accountPattern: /AED/, sort: "none", valuation: { index, target: "PHP", trackTotal: true } });
    // Real rows keep file order; the revaluation checkpoint (needs the AED
    // balance built up chronologically first) lands after both.
    expect(rows.map((r) => r.payee)).toEqual(["Later in file, still within range", "Earlier date", "Commodities revalued"]);
  });
});

describe("register — per-posting valuation (shapes 9/10 style, display_amount)", () => {
  it("values each posting at its own date, no running total needed", () => {
    const journal = setup(
      [
        "P 2024/01/01 FOO 1 PHP",
        "P 2024/06/01 FOO 2 PHP",
        "",
        "2024/02/01 Buy",
        "    Expenses:Test    10 FOO",
        "    Assets:Checking",
        "",
        "2024/07/01 Buy again",
        "    Expenses:Test    10 FOO",
        "    Assets:Checking",
      ].join("\n"),
    );
    const index = buildPriceIndex(journal);
    const rows = register(journal, { accountPattern: /Expenses/, valuation: { index, target: "PHP" } });
    expect(rows).toHaveLength(2);
    expect(toNumber(rows[0].valuedAmount!.qty)).toBeCloseTo(10); // 10 FOO @ 1 PHP
    expect(toNumber(rows[1].valuedAmount!.qty)).toBeCloseTo(20); // 10 FOO @ 2 PHP
  });
});

describe("register — running total + revaluation rows (shape 4 style, display_total)", () => {
  it("reproduces the real AED-account revaluation sequence from the golden fixture", () => {
    // Mirrors test/golden/04-history-foreign-currency.txt's opening rows for
    // Expenses:Currency:AED: three 2025/02/20 postings net to 0 AED (no
    // revaluation on the 02/21 price change since nothing is held), then a
    // 02/21 Withdrawal brings the balance to 300 AED, after which the
    // 02/22 and 02/23 price changes each produce a real "Commodities
    // revalued" row.
    const journal = setup(
      [
        "P 2025/02/18 00:00:00 AED 15.85 PHP",
        "P 2025/02/21 00:00:00 AED 15.7797333333 PHP",
        "P 2025/02/22 00:00:00 AED 15.7649565217 PHP",
        "P 2025/02/23 00:00:00 AED 15.76495454545455 PHP",
        "",
        "2025/02/20 Forex AED",
        "    Expenses:Currency:AED    AED1000.00",
        "    Assets:Checking",
        "",
        "2025/02/20 Tamani Deposit",
        "    Expenses:Currency:AED    AED-500.00",
        "    Assets:Checking",
        "",
        "2025/02/20 Deposit for Bookings",
        "    Expenses:Currency:AED    AED-500.00",
        "    Assets:Checking",
        "",
        "2025/02/21 Withdrawal",
        "    Expenses:Currency:AED    AED300.00",
        "    Assets:Checking",
        "",
        "2025/02/24 Settlement",
        "    Expenses:Currency:AED    AED-300.00",
        "    Assets:Checking",
      ].join("\n"),
    );
    const index = buildPriceIndex(journal);
    const rows = register(journal, { accountPattern: /^Expenses:Currency:AED$/, valuation: { index, target: "PHP", trackTotal: true } });

    const summary = rows.map((r) => ({
      date: `${r.date.getUTCFullYear()}/${r.date.getUTCMonth() + 1}/${r.date.getUTCDate()}`,
      payee: r.payee,
      total: r.runningTotal ? toNumber(r.runningTotal.get("PHP") ?? { units: 0n, scale: 0 }) : null,
    }));

    expect(summary).toEqual([
      { date: "2025/2/20", payee: "Forex AED", total: 15850 },
      { date: "2025/2/20", payee: "Tamani Deposit", total: 7925 },
      { date: "2025/2/20", payee: "Deposit for Bookings", total: 0 },
      // no revaluation row for the 02/21 price change: balance was 0 going in
      { date: "2025/2/21", payee: "Withdrawal", total: expect.closeTo(4733.92, 1) },
      { date: "2025/2/22", payee: "Commodities revalued", total: expect.closeTo(4729.487, 2) },
      { date: "2025/2/23", payee: "Commodities revalued", total: expect.closeTo(4729.486, 2) },
      { date: "2025/2/24", payee: "Settlement", total: 0 },
    ]);
    expect(rows.filter((r) => r.isRevaluation)).toHaveLength(2);
    expect(rows.find((r) => r.isRevaluation)!.account).toBe("<Revalued>");
    expect(rows.find((r) => r.isRevaluation)!.file).toBeNull();
    expect(rows.find((r) => r.isRevaluation)!.begLine).toBe(0);
  });

  it("does not double-fire, or fire at all, when a price update leaves the value unchanged", () => {
    // Two distinct duplicate-value events: 02/18 repeats the exact same P
    // line twice (real journal has this — same timestamp, collapses to one
    // candidate checkpoint by construction) and 02/20 restates the same
    // price at a *different* timestamp (must be recognized as a zero-delta
    // no-op, not just deduplicated by timestamp).
    const journal = setup(
      [
        "P 2025/02/15 00:00:00 AED 15.00 PHP",
        "P 2025/02/18 00:00:00 AED 15.85 PHP",
        "P 2025/02/18 00:00:00 AED 15.85 PHP", // real journal has this exact duplicate
        "P 2025/02/20 00:00:00 AED 15.85 PHP", // same value again, different date
        "",
        "2025/02/16 Forex AED",
        "    Expenses:Currency:AED    AED100.00",
        "    Assets:Checking",
        "",
        "2025/02/22 Withdrawal",
        "    Expenses:Currency:AED    AED-50.00",
        "    Assets:Checking",
      ].join("\n"),
    );
    const index = buildPriceIndex(journal);
    const rows = register(journal, { accountPattern: /AED/, valuation: { index, target: "PHP", trackTotal: true } });
    const revaluations = rows.filter((r) => r.isRevaluation);
    expect(revaluations).toHaveLength(1); // only the real 15.00 -> 15.85 change on 02/18
    expect(revaluations[0].date.getUTCDate()).toBe(18);
  });

  it("leaves an unconvertible commodity as its own Balance entry instead of dropping it", () => {
    const journal = setup(["2024/01/01 Mystery", "    Expenses:Test    5 XYZ", "    Assets:Checking"].join("\n"));
    const index = buildPriceIndex(journal); // no price for XYZ at all
    const rows = register(journal, { accountPattern: /Expenses/, valuation: { index, target: "PHP", trackTotal: true } });
    expect(rows[0].valuedAmount).toBeNull();
    expect(rows[0].runningTotal?.get("XYZ")).toBeDefined();
    expect(toNumber(rows[0].runningTotal!.get("XYZ")!)).toBe(5);
    expect(rows[0].runningTotal?.has("PHP")).toBe(false);
  });
});
