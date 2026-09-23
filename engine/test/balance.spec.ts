import { describe, expect, it } from "vitest";
import { toNumber } from "../src/amount.js";
import { ledgerDate } from "../src/journal.js";
import { parseJournal } from "../src/parse.js";
import { buildPriceIndex } from "../src/prices.js";
import { balance, thisMonthRange } from "../src/report/balance.js";
import { elideAndValidateJournal } from "../src/validate.js";

function setup(text: string) {
  const journal = parseJournal(text);
  elideAndValidateJournal(journal);
  return journal;
}

describe("balance — --flat semantics (one row per account with its own posting, but each row is still the full rolled-up subtree total)", () => {
  const journal = setup(
    [
      "2024/10/01 A",
      "    Expenses:Wants    ₱100",
      "    Assets:Checking",
      "",
      "2024/10/02 B",
      "    Expenses:Wants:Games    ₱50",
      "    Assets:Checking",
    ].join("\n"),
  );

  it("rolls a child's amount into a parent that also has its own direct posting (real Assets:Checking/Recievables shape)", () => {
    const rows = balance(journal);
    const byAccount = Object.fromEntries(rows.map((r) => [r.account, toNumber(r.balance.get("₱")!)]));
    // Confirmed against the real journal: ledger's own anchored `^Assets:Checking$`
    // gives -449,000 (own postings only), but the unfiltered `bal --flat` row
    // for "Assets:Checking" gives 1,529,393.33 (own + every descendant) —
    // "--flat" only changes which accounts get their own row, not whether
    // the shown value is rolled up.
    expect(byAccount["Expenses:Wants"]).toBe(150); // 100 own + 50 from the child
    expect(byAccount["Expenses:Wants:Games"]).toBe(50);
  });

  it("gives a pure organizational account (no own posting) no row of its own", () => {
    const journal2 = setup(
      ["2024/10/01 A", "    Expenses:Wants:Games:Chess    ₱10", "    Assets:Checking", "", "2024/10/02 B", "    Expenses:Wants:Games:Cards    ₱20", "    Assets:Checking"].join("\n"),
    );
    const rows = balance(journal2);
    const names = rows.map((r) => r.account);
    expect(names).not.toContain("Expenses:Wants:Games"); // never posted to directly
    expect(names).not.toContain("Expenses:Wants");
    expect(names).toContain("Expenses:Wants:Games:Chess");
    expect(names).toContain("Expenses:Wants:Games:Cards");
  });

  it("sorts alphabetically by account name (matches ledger's own bal output order)", () => {
    const rows = balance(journal);
    const names = rows.map((r) => r.account);
    expect(names).toEqual([...names].sort());
  });
});

describe("balance — filtering by account pattern and [begin, end)", () => {
  const journal = setup(
    [
      "2024/10/01 A",
      "    Expenses:Wants    ₱100",
      "    Assets:Checking",
      "",
      "2024/11/01 B",
      "    Expenses:Wants    ₱200",
      "    Assets:Checking",
    ].join("\n"),
  );

  it("only sums postings within [begin, end)", () => {
    const rows = balance(journal, { accountPattern: /^Expenses:Wants$/, begin: ledgerDate(2024, 11, 1), end: ledgerDate(2024, 12, 1) });
    expect(rows).toHaveLength(1);
    expect(toNumber(rows[0].balance.get("₱")!)).toBe(200);
  });

  it("filters by account regex like ledger's own positional arg", () => {
    const rows = balance(journal, { accountPattern: /^Assets/ });
    expect(rows.map((r) => r.account)).toEqual(["Assets:Checking"]);
  });
});

describe("balance — --empty", () => {
  const journal = setup(["2024/10/01 A", "    Expenses:Wants    ₱100", "    Assets:Checking", "", "2024/12/01 B", "    Expenses:Rare    ₱1", "    Assets:Checking"].join("\n"));

  it("omits an account with no postings in range by default", () => {
    const rows = balance(journal, { accountPattern: /^Expenses:Rare$/, begin: ledgerDate(2024, 10, 1), end: ledgerDate(2024, 11, 1) });
    expect(rows).toHaveLength(0);
  });

  it("includes it at zero when named in includeEmpty, even with no postings in range", () => {
    const rows = balance(journal, {
      accountPattern: /^Expenses:Rare$/,
      begin: ledgerDate(2024, 10, 1),
      end: ledgerDate(2024, 11, 1),
      includeEmpty: ["Expenses:Rare"],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].balance.size).toBe(0); // no valuation requested -> genuinely empty native balance
  });

  it("forces a row for a name that has never been posted to anywhere in the journal (real budget-only-category shape)", () => {
    // Confirmed against the real journal: Expenses:Insurance:BDOLife exists
    // only in a `~` periodic budget block, never in an actual transaction —
    // ledger's `--empty` still gives it a zero row when explicitly named,
    // which is exactly what budgets._ledger_totals relies on.
    const rows = balance(journal, { accountPattern: /^Expenses:NeverExisted$/, includeEmpty: ["Expenses:NeverExisted"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].balance.size).toBe(0);
  });

  it("does not force a row for an unrelated account just because includeEmpty is non-empty", () => {
    const rows = balance(journal, { accountPattern: /^Expenses:Rare$/, includeEmpty: ["Expenses:SomeOtherCategory"] });
    expect(rows.map((r) => r.account)).not.toContain("Expenses:SomeOtherCategory");
  });
});

describe("balance — valuation at an explicit asOf date", () => {
  it("values using the price in effect at asOf, matching the §3.3 bal-values-at-report-end finding", () => {
    const journal = setup(
      ["P 2024/01/01 FOO 1 PHP", "P 2024/06/01 FOO 2 PHP", "", "2024/03/15 Buy", "    Expenses:Test    10 FOO", "    Assets:Checking"].join("\n"),
    );
    const index = buildPriceIndex(journal);
    const beforeChange = balance(journal, { accountPattern: /^Expenses:Test$/, valuation: { index, target: "PHP", asOf: ledgerDate(2024, 4, 1) } });
    const afterChange = balance(journal, { accountPattern: /^Expenses:Test$/, valuation: { index, target: "PHP", asOf: ledgerDate(2024, 7, 1) } });
    expect(toNumber(beforeChange[0].balance.get("PHP")!)).toBeCloseTo(10);
    expect(toNumber(afterChange[0].balance.get("PHP")!)).toBeCloseTo(20);
  });

  it("leaves an unconvertible commodity as its own entry, same as register's valueBalance", () => {
    const journal = setup(["2024/01/01 Mystery", "    Expenses:Test    5 XYZ", "    Assets:Checking"].join("\n"));
    const index = buildPriceIndex(journal);
    const rows = balance(journal, { accountPattern: /^Expenses:Test$/, valuation: { index, target: "PHP", asOf: ledgerDate(2024, 6, 1) } });
    expect(rows[0].balance.has("PHP")).toBe(false);
    expect(toNumber(rows[0].balance.get("XYZ")!)).toBe(5);
  });
});

describe("thisMonthRange", () => {
  it("computes [monthStart, nextMonthStart)", () => {
    const { begin, end } = thisMonthRange(ledgerDate(2024, 2, 15));
    expect(begin.toISOString()).toBe(ledgerDate(2024, 2, 1).toISOString());
    expect(end.toISOString()).toBe(ledgerDate(2024, 3, 1).toISOString());
  });

  it("rolls over the year at December", () => {
    const { begin, end } = thisMonthRange(ledgerDate(2024, 12, 25));
    expect(begin.toISOString()).toBe(ledgerDate(2024, 12, 1).toISOString());
    expect(end.toISOString()).toBe(ledgerDate(2025, 1, 1).toISOString());
  });
});
