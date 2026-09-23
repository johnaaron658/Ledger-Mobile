import { describe, expect, it } from "vitest";
import { toNumber } from "../src/amount.js";
import { ledgerDate } from "../src/journal.js";
import { parseJournal } from "../src/parse.js";
import { buildPriceIndex } from "../src/prices.js";
import { budgetRemaining, budgetWindow, countPeriods, covers, parsePeriodSpec, periodRange } from "../src/report/periodic.js";
import { elideAndValidateJournal } from "../src/validate.js";

function setup(text: string) {
  const journal = parseJournal(text);
  elideAndValidateJournal(journal);
  return journal;
}

describe("periodRange — date-bound extraction (port of budgets._period_range)", () => {
  it("extracts 'from' as an open-ended start", () => {
    const w = periodRange("Monthly from 2024/11");
    expect(w.start.toISOString()).toBe(ledgerDate(2024, 11, 1).toISOString());
    expect(w.end).toBeNull();
  });

  it("extracts 'from ... to ...' as a closed window", () => {
    const w = periodRange("Monthly from 2024/10/01 to 2024/10/31");
    expect(w.start.toISOString()).toBe(ledgerDate(2024, 10, 1).toISOString());
    expect(w.end!.toISOString()).toBe(ledgerDate(2024, 10, 31).toISOString());
  });

  it("expands a year-only or year-month token to the full period", () => {
    expect(periodRange("Monthly from 2024").start.toISOString()).toBe(ledgerDate(2024, 1, 1).toISOString());
    expect(periodRange("Monthly to 2024").end!.toISOString()).toBe(ledgerDate(2024, 12, 31).toISOString());
    expect(periodRange("Monthly to 2024/02").end!.toISOString()).toBe(ledgerDate(2024, 2, 29).toISOString()); // leap year
  });

  it("treats 'in YYYY/MM' as that whole month", () => {
    const w = periodRange("Monthly in 2024/11");
    expect(w.start.toISOString()).toBe(ledgerDate(2024, 11, 1).toISOString());
    expect(w.end!.toISOString()).toBe(ledgerDate(2024, 11, 30).toISOString());
  });

  it("defaults start to the far past with no 'from'/'in'", () => {
    const w = periodRange("Monthly to 2024/10/31");
    expect(w.start.getTime()).toBeLessThan(ledgerDate(1, 1, 1).getTime());
  });
});

describe("covers", () => {
  it("is true only within [start, end]", () => {
    const w = periodRange("Monthly from 2024/10/01 to 2024/10/31");
    expect(covers(w, ledgerDate(2024, 9, 30))).toBe(false);
    expect(covers(w, ledgerDate(2024, 10, 1))).toBe(true);
    expect(covers(w, ledgerDate(2024, 10, 31))).toBe(true);
    expect(covers(w, ledgerDate(2024, 11, 1))).toBe(false);
  });

  it("is open-ended on the right with no 'to'", () => {
    const w = periodRange("Monthly from 2024/11");
    expect(covers(w, ledgerDate(2099, 1, 1))).toBe(true);
  });
});

describe("parsePeriodSpec", () => {
  it("parses 'Monthly' as { n: 1, unit: months }", () => {
    expect(parsePeriodSpec("Monthly from 2024/11")).toEqual({ n: 1, unit: "months" });
  });

  it("parses 'Every N <unit>' forms", () => {
    expect(parsePeriodSpec("Every 3 months from 2024/11")).toEqual({ n: 3, unit: "months" });
    expect(parsePeriodSpec("Every 2 weeks from 2024/11/01")).toEqual({ n: 2, unit: "weeks" });
    expect(parsePeriodSpec("Every 10 days from 2024/11/01")).toEqual({ n: 10, unit: "days" });
    expect(parsePeriodSpec("Every 1 years from 2024/11/01")).toEqual({ n: 1, unit: "years" });
  });

  it("parses 'Yearly' as { n: 1, unit: years } (real journal uses this keyword directly)", () => {
    expect(parsePeriodSpec("Yearly from 2025/02 to 2026/01")).toEqual({ n: 1, unit: "years" });
  });
});

describe("countPeriods — real-ledger-verified calendar-alignment rules (§3.2 step 9 probe)", () => {
  it("an open-ended block expands through the cutoff month inclusive (probe: 23 months, Nov'24..Sep'26)", () => {
    const window = budgetWindow("Monthly from 2024/11");
    const spec = parsePeriodSpec("Monthly from 2024/11");
    expect(countPeriods(spec, window, ledgerDate(2026, 9, 23))).toBe(23);
  });

  it("Monthly counts a calendar month that only *partially* overlaps the block (probe: 2 months for a Nov16-Dec15 window)", () => {
    const window = budgetWindow("Monthly from 2024/11/16 to 2024/12/15");
    const spec = parsePeriodSpec("Monthly from 2024/11/16 to 2024/12/15");
    expect(countPeriods(spec, window, ledgerDate(2026, 9, 23))).toBe(2);
  });

  it("'Every 1 months' matches 'Monthly' exactly on the same partial-overlap window (probe-confirmed identical result)", () => {
    const window = budgetWindow("Every 1 months from 2024/11/16 to 2024/12/15");
    const spec = parsePeriodSpec("Every 1 months from 2024/11/16 to 2024/12/15");
    expect(countPeriods(spec, window, ledgerDate(2026, 9, 23))).toBe(2);
  });

  it("a fully-contained one-month block counts as exactly 1", () => {
    const window = budgetWindow("Monthly from 2024/10/01 to 2024/10/31");
    const spec = parsePeriodSpec("Monthly from 2024/10/01 to 2024/10/31");
    expect(countPeriods(spec, window, ledgerDate(2026, 9, 23))).toBe(1);
  });

  it("'Every N months' strides by calendar month from the start month, not the exact day (real Sunlife shape: 8 quarters)", () => {
    const window = budgetWindow("Every 3 months from 2024/11");
    const spec = parsePeriodSpec("Every 3 months from 2024/11");
    // Nov'24, Feb/May/Aug/Nov'25, Feb/May/Aug'26 = 8, matching the real
    // journal's Expenses:Insurance:Sunlife budgeted total (60,000 = 8×7,500).
    expect(countPeriods(spec, window, ledgerDate(2026, 9, 22))).toBe(8);
  });

  it("caps at the block's own 'to' date when that's earlier than the cutoff", () => {
    const window = budgetWindow("Monthly from 2024/11 to 2025/01/31");
    const spec = parsePeriodSpec("Monthly from 2024/11 to 2025/01/31");
    expect(countPeriods(spec, window, ledgerDate(2026, 9, 23))).toBe(3); // Nov, Dec, Jan only
  });

  it("Yearly is calendar-year aligned, same rule as Monthly one level up (probe: 2 years for a mid-2024-to-mid-2025 window)", () => {
    const window = budgetWindow("Yearly from 2024/06/15 to 2025/03/15");
    const spec = parsePeriodSpec("Yearly from 2024/06/15 to 2025/03/15");
    expect(countPeriods(spec, window, ledgerDate(2026, 9, 23))).toBe(2);
  });

  it("returns 0 when the block hasn't started yet as of the cutoff", () => {
    const window = budgetWindow("Monthly from 2027/01");
    const spec = parsePeriodSpec("Monthly from 2027/01");
    expect(countPeriods(spec, window, ledgerDate(2026, 9, 23))).toBe(0);
  });

  it("budgetWindow treats a bare 'to YYYY/MM' as day 1, not end-of-month — diverges from periodRange (real BDOLife shape)", () => {
    // The critical, surprising finding: ledger's own budget-expansion parser
    // and budgets.py's _expand_date disagree on a bare month/year token used
    // as a "to" bound. periodRange() (Python-matching) expands "to 2026/01"
    // to Jan 31; budgetWindow() (ledger-matching) expands it to Jan 1 — and
    // that one-day difference changes whether the window is judged to
    // straddle a second calendar year.
    const pythonStyle = periodRange("Yearly from 2025/02 to 2026/01");
    const ledgerStyle = budgetWindow("Yearly from 2025/02 to 2026/01");
    expect(pythonStyle.end!.toISOString()).toBe(ledgerDate(2026, 1, 31).toISOString());
    expect(ledgerStyle.end!.toISOString()).toBe(ledgerDate(2025, 12, 31).toISOString()); // exclusive of Jan 2026 entirely

    const spec = parsePeriodSpec("Yearly from 2025/02 to 2026/01");
    // Real Expenses:Insurance:BDOLife budgets to exactly 29,215.72 (1×), not
    // 2× — confirming ledgerStyle (via budgetWindow) is the one --budget
    // actually needs, even though periodRange is correct for covers()/UI.
    expect(countPeriods(spec, ledgerStyle, ledgerDate(2026, 9, 23))).toBe(1);
    expect(countPeriods(spec, pythonStyle, ledgerDate(2026, 9, 23))).toBe(2); // what you'd get by (wrongly) reusing periodRange here

    // Making the "to" token explicit-day instead — even naming the exact
    // same calendar date periodRange's expansion already produces — flips
    // ledger's own count back up to 2. It's the token's bareness that
    // matters, not which date it resolves to or which side it's on (the
    // "from" side's bareness never affects the result, probed separately).
    const explicitDay = budgetWindow("Yearly from 2025/02 to 2026/01/31");
    expect(countPeriods(spec, explicitDay, ledgerDate(2026, 9, 23))).toBe(2);
  });

  it("the cleanest form of the same finding: 'Monthly ... to 2024/03' excludes March entirely (probe: 200, not 300)", () => {
    const window = budgetWindow("Monthly from 2024/01 to 2024/03");
    const spec = parsePeriodSpec("Monthly from 2024/01 to 2024/03");
    expect(window.end!.toISOString()).toBe(ledgerDate(2024, 2, 29).toISOString()); // Feb 29 2024 (leap year) — one day before Mar 1
    expect(countPeriods(spec, window, ledgerDate(2026, 9, 23))).toBe(2); // Jan, Feb only
  });
});

describe("budgetRemaining — end-to-end, matching budgets._envelopes's shape", () => {
  it("computes budgeted - actual = remaining, matching the real §3.3-style probe (2300 - 80 = 2220)", () => {
    const journal = setup(
      [
        "~ Monthly from 2024/11",
        "    Expenses:Test    ₱100",
        "    Assets:Checking",
        "",
        "2024/11/15 Buy1",
        "    Expenses:Test    ₱50",
        "    Assets:Checking",
        "",
        "2025/03/10 Buy2",
        "    Expenses:Test    ₱30",
        "    Assets:Checking",
      ].join("\n"),
    );
    const rows = budgetRemaining(journal, { accountPattern: /^Expenses:Test$/, cutoff: ledgerDate(2026, 9, 23), includeEmpty: ["Expenses:Test"] });
    expect(rows).toHaveLength(1);
    expect(toNumber(rows[0].budgeted.get("₱")!)).toBeCloseTo(2300);
    expect(toNumber(rows[0].actual.get("₱")!)).toBeCloseTo(80);
    expect(toNumber(rows[0].remaining.get("₱")!)).toBeCloseTo(2220);
  });

  it("sums two successive budget blocks for the same account (real Expenses:Daily shape)", () => {
    const journal = setup(
      [
        "~ Monthly from 2024/10/01 to 2024/10/31",
        "    Expenses:Test    ₱11",
        "    Assets:Checking",
        "",
        "~ Monthly from 2024/11",
        "    Expenses:Test    ₱100",
        "    Assets:Checking",
        "",
        "2024/10/15 Buy0",
        "    Expenses:Test    ₱5",
        "    Assets:Checking",
        "",
        "2024/11/15 Buy1",
        "    Expenses:Test    ₱50",
        "    Assets:Checking",
      ].join("\n"),
    );
    const rows = budgetRemaining(journal, { accountPattern: /^Expenses:Test$/, cutoff: ledgerDate(2026, 9, 23), includeEmpty: ["Expenses:Test"] });
    // block1 = 1mo*11=11, block2 = 23mo*100=2300, total budgeted=2311, spent=55
    expect(toNumber(rows[0].budgeted.get("₱")!)).toBeCloseTo(2311);
    expect(toNumber(rows[0].remaining.get("₱")!)).toBeCloseTo(2256);
  });

  it("gives a zero-budget, zero-actual row for an includeEmpty account with no periodic and no postings", () => {
    const journal = setup(["2024/11/15 Buy1", "    Expenses:Other    ₱5", "    Assets:Checking"].join("\n"));
    const rows = budgetRemaining(journal, { accountPattern: /^Expenses:Never$/, cutoff: ledgerDate(2026, 9, 23), includeEmpty: ["Expenses:Never"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].budgeted.size).toBe(0);
    expect(rows[0].actual.size).toBe(0);
  });

  it("values both sides through the same price index and cutoff when a valuation is given", () => {
    const journal = setup(
      [
        "P 2024/01/01 FOO 1 PHP",
        "P 2024/06/01 FOO 2 PHP",
        "",
        "~ Monthly from 2024/01",
        "    Expenses:Test    10 FOO",
        "    Assets:Checking",
        "",
        "2024/07/01 Buy",
        "    Expenses:Test    5 FOO",
        "    Assets:Checking",
      ].join("\n"),
    );
    const index = buildPriceIndex(journal);
    const rows = budgetRemaining(journal, {
      accountPattern: /^Expenses:Test$/,
      cutoff: ledgerDate(2024, 7, 15),
      valuation: { index, target: "PHP" },
      includeEmpty: ["Expenses:Test"],
    });
    // 7 months (Jan..Jul) * 10 FOO = 70 FOO, valued at the Jul price (2 PHP) = 140 PHP
    expect(toNumber(rows[0].budgeted.get("PHP")!)).toBeCloseTo(140);
    // actual: 5 FOO valued at its own posting date (Jul, price 2) = 10 PHP
    expect(toNumber(rows[0].actual.get("PHP")!)).toBeCloseTo(10);
    expect(toNumber(rows[0].remaining.get("PHP")!)).toBeCloseTo(130);
  });
});
