import { describe, expect, it } from "vitest";
import { toNumber } from "../src/amount.js";
import { formatLedgerDate } from "../src/journal.js";
import { parseJournal } from "../src/parse.js";

describe("parseJournal — basic transactions", () => {
  const text = [
    "2024/10/22 Lazada",
    "    Expenses:Wants    ₱599.92    ; Dice Set",
    "    Liabilities:CreditCard:BPICC",
    "",
    "2024/10/21 Always in Bloom by Elyse",
    "    Expenses:Wants    ₱2500.00",
    "    Assets:Checking:Banking:GCash",
  ].join("\n");

  it("parses two transactions with correct dates/payees", () => {
    const j = parseJournal(text);
    expect(j.transactions).toHaveLength(2);
    expect(formatLedgerDate(j.transactions[0].date)).toBe("2024/10/22");
    expect(j.transactions[0].payee).toBe("Lazada");
    expect(formatLedgerDate(j.transactions[1].date)).toBe("2024/10/21");
  });

  it("tracks 1-indexed begLine/endLine matching ledger's convention", () => {
    const j = parseJournal(text);
    expect(j.transactions[0].begLine).toBe(1);
    expect(j.transactions[0].endLine).toBe(3);
    expect(j.transactions[1].begLine).toBe(5);
    expect(j.transactions[1].endLine).toBe(7);
  });

  it("strips an inline ';' comment from the amount field", () => {
    const j = parseJournal(text);
    const posting = j.transactions[0].postings[0];
    expect(posting.account).toBe("Expenses:Wants");
    expect(toNumber(posting.amount!.qty)).toBeCloseTo(599.92);
    expect(posting.amount!.commodity).toBe("₱");
  });

  it("leaves a fully-elided posting's amount null", () => {
    const j = parseJournal(text);
    const elided = j.transactions[0].postings[1];
    expect(elided.account).toBe("Liabilities:CreditCard:BPICC");
    expect(elided.amount).toBeNull();
  });

  it("keeps single spaces inside an account name (2+ spaces is the only separator)", () => {
    const j = parseJournal("2023/05/01 Starting Balance\n    Assets:Real Estate:Cansaga House    1 House\n    Equity:Starting Balance\n");
    expect(j.transactions[0].postings[0].account).toBe("Assets:Real Estate:Cansaga House");
  });
});

describe("parseJournal — expression and lot amounts", () => {
  it("evaluates a `( ... )` expression amount", () => {
    const j = parseJournal("2025/02/15 Travel Adjustment\n    Expenses:Uncategorized    (56,214.6089 PHP + 46,448.9038 PHP)\n    Expenses:Travel\n");
    const amount = j.transactions[0].postings[0].amount!;
    expect(amount.commodity).toBe("PHP");
    expect(toNumber(amount.qty)).toBeCloseTo(102663.5127);
  });

  it("parses a lot amount into qty + lotPrice, commodity = the lot item", () => {
    const j = parseJournal("2023/05/01 Starting Balance to House\n    Assets:Real Estate:Cansaga House    1 House @ 1800000 PHP\n    Equity:Starting Balance\n");
    const amount = j.transactions[0].postings[0].amount!;
    expect(amount.commodity).toBe("House");
    expect(toNumber(amount.qty)).toBe(1);
    expect(amount.lotPrice).toBeDefined();
    expect(amount.lotPrice!.commodity).toBe("PHP");
    expect(toNumber(amount.lotPrice!.qty)).toBe(1800000);
  });
});

describe("parseJournal — real-data quirks found via the golden-fixture crosscheck", () => {
  it("parses a sign-before-prefix negative amount ('-₱1661024.59', real line 350)", () => {
    // amount.ts's AMOUNT_RE (a verbatim port of ledger's *output* format)
    // expects "₱-1,661,024.59"; raw source text sometimes writes the sign
    // first instead. See the comment on parsePlainAmount's fallback.
    const j = parseJournal("2024/08/10 Starting Balance to 367003895917\n    Liabilities:PAGIBIG:HL367003895917    -₱1661024.59\n    Equity:Starting Balance\n");
    const amount = j.transactions[0].postings[0].amount!;
    expect(amount.commodity).toBe("₱");
    expect(toNumber(amount.qty)).toBeCloseTo(-1661024.59);
  });

  it("strips a trailing '; note' from a transaction header, not just from postings (real line 907)", () => {
    const j = parseJournal("2024/11/14 Cong Caphe    ; Phin Filter\n    Expenses:Daily    ₱100\n    Assets:Checking\n");
    expect(j.transactions[0].payee).toBe("Cong Caphe");
  });

  it("does not end a block on a whitespace-only line, only a truly empty one (real journal has 3 tab-only lines)", () => {
    // Confirmed against ledger's own beg_line/end_line: a lone "\t" line
    // between transactions is still counted as part of the preceding
    // transaction's extent, not treated as the blank separator.
    const text = ["2024/10/22  Starting Balance to  Abby", "    Assets:Checking:Recievables:Abby    ₱20411.11", "    Equity:Starting Balance", "\t", "2024/10/22  Starting Balance to  Mama", "    Assets:Checking:Recievables:Mama    ₱1", "    Equity:Starting Balance"].join(
      "\n",
    );
    const j = parseJournal(text);
    expect(j.transactions).toHaveLength(2);
    expect(j.transactions[0].begLine).toBe(1);
    expect(j.transactions[0].endLine).toBe(4); // includes the trailing tab-only line
    expect(j.transactions[1].begLine).toBe(5);
  });

  it("matches the same posting to the correct one of several same-account postings by value, not just presence (real begLine 6001)", () => {
    const j = parseJournal(
      ["2025/10/20 Donki", "    Assets:Checking:Recievables:Harriet    (JPY 99*12)", "    Assets:Checking:Recievables:Harriet    (JPY 99*1)", "    Expenses:Daily    ₱1"].join("\n"),
    );
    const amounts = j.transactions[0].postings.filter((p) => p.account === "Assets:Checking:Recievables:Harriet").map((p) => toNumber(p.amount!.qty));
    expect(amounts.sort((a, b) => a - b)).toEqual([99, 1188]);
  });
});

describe("parseJournal — periodics and prices", () => {
  it("parses a `~` periodic block, stripping the leading `~`", () => {
    const j = parseJournal("~ Monthly from 2024/11\n    Expenses:Daily    ₱5327.5\n    Assets:Checking\n");
    expect(j.periodics).toHaveLength(1);
    expect(j.periodics[0].periodText).toBe("Monthly from 2024/11");
    expect(j.periodics[0].postings[0].account).toBe("Expenses:Daily");
  });

  it("parses a P directive with an explicit time", () => {
    const j = parseJournal("P 2024/11/18 00:00:00 VND 0.0023131733333333 PHP\n");
    expect(j.prices).toHaveLength(1);
    const p = j.prices[0];
    expect(p.time).toBe("00:00:00");
    expect(p.commodity).toBe("VND");
    expect(p.price.commodity).toBe("PHP");
    expect(toNumber(p.price.qty)).toBeCloseTo(0.0023131733333333, 10);
  });

  it("parses a P directive with no time (identity price)", () => {
    const j = parseJournal("P 2024/01/08 ₱ 1 PHP\n");
    expect(j.prices[0].time).toBeUndefined();
    expect(j.prices[0].commodity).toBe("₱");
    expect(toNumber(j.prices[0].price.qty)).toBe(1);
  });

  it("does not dedupe a repeated P line (real data has one)", () => {
    const j = parseJournal("P 2025/02/18 00:00:00 AED 15.85 PHP\nP 2025/02/18 00:00:00 AED 15.85 PHP\n");
    expect(j.prices).toHaveLength(2);
  });
});

describe("parseJournal — comments and blank-line termination", () => {
  it("ignores a full-line ';' comment and a '//' comment", () => {
    const j = parseJournal("; a note\n// another note\n2024/10/22 Lazada\n    Expenses:Wants    ₱1\n    Assets:Checking\n");
    expect(j.transactions).toHaveLength(1);
  });

  it("ignores an entirely commented-out transaction (header itself starts with ';')", () => {
    const j = parseJournal(
      [
        "; 2025/02/20 Dubai Metro Card",
        ";     Assets:Checking:Recievables:Harriet    AED20.00",
        ";     Assets:Checking:Recievables:Denz",
        "",
        "2024/10/22 Lazada",
        "    Expenses:Wants    ₱1",
        "    Assets:Checking",
      ].join("\n"),
    );
    expect(j.transactions).toHaveLength(1);
    expect(j.transactions[0].payee).toBe("Lazada");
  });

  it("terminates a block at a blank line, not at EOF only", () => {
    const j = parseJournal(
      ["2024/10/22 A", "    Expenses:Wants    ₱1", "    Assets:Checking", "", "2024/10/23 B", "    Expenses:Wants    ₱2", "    Assets:Checking"].join(
        "\n",
      ),
    );
    expect(j.transactions).toHaveLength(2);
    expect(j.transactions[0].postings).toHaveLength(2);
    expect(j.transactions[1].postings).toHaveLength(2);
  });
});
