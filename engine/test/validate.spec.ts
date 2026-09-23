import { describe, expect, it } from "vitest";
import { toNumber } from "../src/amount.js";
import { parseJournal } from "../src/parse.js";
import { elideAndValidateJournal, parseAndValidate } from "../src/validate.js";

function txn(text: string) {
  const j = parseJournal(text);
  const result = elideAndValidateJournal(j);
  return { j, result };
}

describe("elision", () => {
  it("fills a single elided posting with the negated sum", () => {
    const { j, result } = txn("2024/10/22 Lazada\n    Expenses:Wants    ₱599.92\n    Liabilities:CreditCard:BPICC\n");
    expect(result.ok).toBe(true);
    const elided = j.transactions[0].postings[1];
    expect(elided.amount!.commodity).toBe("₱");
    expect(toNumber(elided.amount!.qty)).toBeCloseTo(-599.92);
  });

  it("sums more than two postings before filling the elided one", () => {
    const { j, result } = txn("2024/10/22 Split\n    Expenses:A    ₱100\n    Expenses:B    ₱50\n    Assets:Checking\n");
    expect(result.ok).toBe(true);
    expect(toNumber(j.transactions[0].postings[2].amount!.qty)).toBeCloseTo(-150);
  });

  it("balances a lot posting against its cost, not its own commodity (real House-purchase shape)", () => {
    const { j, result } = txn("2023/05/01 Starting Balance to House\n    Assets:Real Estate:Cansaga House    1 House @ 1800000 PHP\n    Equity:Starting Balance\n");
    expect(result.ok).toBe(true);
    const elided = j.transactions[0].postings[1];
    expect(elided.amount!.commodity).toBe("PHP");
    expect(toNumber(elided.amount!.qty)).toBeCloseTo(-1800000);
  });

  it("leaves an already-fully-specified transaction's postings untouched when it balances", () => {
    const { result } = txn("2024/10/22 Both specified\n    Expenses:A    ₱100\n    Assets:Checking    -₱100\n");
    expect(result.ok).toBe(true);
  });

  it("assigns the first posting's commodity at zero when nothing needs cancelling", () => {
    const { j, result } = txn("2024/10/22 Nothing to do\n    Expenses:A    ₱0\n    Assets:Checking\n");
    expect(result.ok).toBe(true);
    expect(j.transactions[0].postings[1].amount!.commodity).toBe("₱");
    expect(toNumber(j.transactions[0].postings[1].amount!.qty)).toBe(0);
  });

  it("elides a periodic block's posting the same way", () => {
    const j = parseJournal("~ Monthly from 2024/11\n    Expenses:Daily    ₱5327.5\n    Assets:Checking\n");
    const result = elideAndValidateJournal(j);
    expect(result.ok).toBe(true);
    expect(toNumber(j.periodics[0].postings[1].amount!.qty)).toBeCloseTo(-5327.5);
  });
});

describe("validation failures", () => {
  it("rejects more than one amount-less posting", () => {
    const { result } = txn("2024/10/22 Ambiguous\n    Expenses:A\n    Expenses:B\n    Assets:Checking    ₱100\n");
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toMatch(/more than one amount-less posting/);
    expect(result.issues[0].begLine).toBe(1);
  });

  it("rejects a transaction that doesn't balance with zero elided postings", () => {
    const { result } = txn("2024/10/22 Broken\n    Expenses:A    ₱100\n    Assets:Checking    -₱90\n");
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toMatch(/does not balance/);
  });

  it("rejects a non-cancelling remainder across two commodities with one elided posting", () => {
    // ₱100 and $5 both need to be absorbed by a single elided posting, which
    // can only cancel one commodity — the other is a genuine parse/balance
    // error, same as real ledger would refuse.
    const { result } = txn("2024/10/22 Mixed\n    Expenses:A    ₱100\n    Expenses:B    $5\n    Assets:Checking\n");
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toMatch(/non-cancelling remainder/);
  });

  it("reports multiple bad transactions, not just the first", () => {
    const { result } = txn(
      ["2024/10/22 Bad one", "    Expenses:A    ₱100", "    Assets:Checking    -₱90", "", "2024/10/23 Bad two", "    Expenses:A", "    Expenses:B", "    Assets:Checking    ₱1"].join("\n"),
    );
    expect(result.issues).toHaveLength(2);
  });
});

describe("parseAndValidate", () => {
  it("succeeds on a valid journal", () => {
    const { journal, result } = parseAndValidate("2024/10/22 Lazada\n    Expenses:Wants    ₱599.92\n    Liabilities:CreditCard:BPICC\n");
    expect(result.ok).toBe(true);
    expect(journal!.transactions).toHaveLength(1);
  });

  it("surfaces a parse error as a validation issue, same shape as a balance failure", () => {
    const { journal, result } = parseAndValidate("2024/10/22 Bad amount\n    Expenses:A    (₱100 - $5)\n    Assets:Checking\n");
    expect(journal).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.issues[0].begLine).toBeDefined();
  });
});
