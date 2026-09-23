import { describe, expect, it } from "vitest";
import { toNumber } from "../src/amount.js";
import { ledgerDate } from "../src/journal.js";
import { parseJournal } from "../src/parse.js";
import { buildPriceIndex, valueAt } from "../src/prices.js";

const PROBE_JOURNAL = [
  "P 2024/01/01 00:00:00 FOO 1 PHP",
  "P 2024/06/01 00:00:00 FOO 2 PHP",
  "P 2024/12/01 00:00:00 FOO 3 PHP",
  "",
  "2024/03/15 Buy Foo",
  "    Expenses:Test    10 FOO",
  "    Assets:Checking",
].join("\n");

describe("PriceIndex.priceAt — §3.3 probe (real ledger 3.3.2 behaviour)", () => {
  const journal = parseJournal(PROBE_JOURNAL);
  const index = buildPriceIndex(journal);

  it("returns null before any price exists", () => {
    expect(index.priceAt("FOO", ledgerDate(2023, 12, 31))).toBeNull();
  });

  it("returns the latest price at or before the query date", () => {
    expect(toNumber(index.priceAt("FOO", ledgerDate(2024, 4, 1))!.price.qty)).toBe(1);
    expect(toNumber(index.priceAt("FOO", ledgerDate(2024, 6, 1))!.price.qty)).toBe(2); // exact match is inclusive
    expect(toNumber(index.priceAt("FOO", ledgerDate(2024, 7, 1))!.price.qty)).toBe(2);
    expect(toNumber(index.priceAt("FOO", ledgerDate(2024, 12, 15))!.price.qty)).toBe(3);
  });
});

describe("valueAt — matches ledger's `bal -X` output for the probe journal exactly", () => {
  const journal = parseJournal(PROBE_JOURNAL);
  const index = buildPriceIndex(journal);
  const posting = { commodity: "FOO", qty: { units: 10n, scale: 0 } };

  it.each([
    [2024, 4, 1, 10], // `ledger bal -X PHP --end 2024/04/01` -> PHP10
    [2024, 7, 1, 20], // `ledger bal -X PHP --end 2024/07/01` -> PHP20
    [2024, 12, 15, 30], // `ledger bal -X PHP --end 2024/12/15` -> PHP30
  ])("valueAt(10 FOO, PHP, %i/%i/%i) = PHP%i", (y, m, d, expected) => {
    const value = valueAt(index, posting, "PHP", ledgerDate(y, m, d));
    expect(value?.commodity).toBe("PHP");
    expect(toNumber(value!.qty)).toBeCloseTo(expected);
  });

  it("returns the amount unchanged when already in the target commodity", () => {
    const phpAmount = { commodity: "PHP", qty: { units: 500n, scale: 0 } };
    expect(valueAt(index, phpAmount, "PHP", ledgerDate(2024, 1, 1))).toBe(phpAmount);
  });

  it("returns null when no price exists yet at that date", () => {
    expect(valueAt(index, posting, "PHP", ledgerDate(2023, 1, 1))).toBeNull();
  });
});

describe("valueAt — one-hop chaining", () => {
  it("chains A->B->C when no direct A->C price exists", () => {
    const journal = parseJournal(["P 2024/01/01 A 2 B", "P 2024/01/01 B 5 C"].join("\n"));
    const index = buildPriceIndex(journal);
    const amount = { commodity: "A", qty: { units: 3n, scale: 0 } };
    const value = valueAt(index, amount, "C", ledgerDate(2024, 6, 1));
    // 3 A * 2 B/A * 5 C/B = 30 C
    expect(value?.commodity).toBe("C");
    expect(toNumber(value!.qty)).toBeCloseTo(30);
  });

  it("does not walk more than one hop", () => {
    const journal = parseJournal(["P 2024/01/01 A 2 B", "P 2024/01/01 B 5 C", "P 2024/01/01 C 7 D"].join("\n"));
    const index = buildPriceIndex(journal);
    const amount = { commodity: "A", qty: { units: 1n, scale: 0 } };
    expect(valueAt(index, amount, "D", ledgerDate(2024, 6, 1))).toBeNull();
  });

  it("returns null when even one hop finds no path", () => {
    const journal = parseJournal("P 2024/01/01 A 2 B\n");
    const index = buildPriceIndex(journal);
    const amount = { commodity: "A", qty: { units: 1n, scale: 0 } };
    expect(valueAt(index, amount, "PHP", ledgerDate(2024, 6, 1))).toBeNull();
  });
});

describe("buildPriceIndex — lot prices as implicit price points (§3.2 step 5)", () => {
  it("makes a lot's price usable with no real P directive for that commodity at all", () => {
    const journal = parseJournal(
      ["2023/05/01 Starting Balance to House", "    Assets:Real Estate:Cansaga House    1 House @ 1800000 PHP", "    Equity:Starting Balance"].join("\n"),
    );
    const index = buildPriceIndex(journal);
    const amount = { commodity: "House", qty: { units: 1n, scale: 0 } };
    const value = valueAt(index, amount, "PHP", ledgerDate(2023, 5, 1));
    expect(value?.commodity).toBe("PHP");
    expect(toNumber(value!.qty)).toBeCloseTo(1800000);
  });

  it("does not make the lot price usable before the transaction's own date", () => {
    const journal = parseJournal(
      ["2023/05/01 Starting Balance to House", "    Assets:Real Estate:Cansaga House    1 House @ 1800000 PHP", "    Equity:Starting Balance"].join("\n"),
    );
    const index = buildPriceIndex(journal);
    const amount = { commodity: "House", qty: { units: 1n, scale: 0 } };
    expect(valueAt(index, amount, "PHP", ledgerDate(2023, 4, 30))).toBeNull();
  });

  it("lets a later real P directive supersede the lot price for later dates (real journal has both)", () => {
    const journal = parseJournal(
      [
        "P 2024/10/01 00:00:00 House 1,900,000 PHP",
        "",
        "2023/05/01 Starting Balance to House",
        "    Assets:Real Estate:Cansaga House    1 House @ 1800000 PHP",
        "    Equity:Starting Balance",
      ].join("\n"),
    );
    const index = buildPriceIndex(journal);
    const amount = { commodity: "House", qty: { units: 1n, scale: 0 } };
    expect(toNumber(valueAt(index, amount, "PHP", ledgerDate(2024, 1, 1))!.qty)).toBeCloseTo(1800000);
    expect(toNumber(valueAt(index, amount, "PHP", ledgerDate(2024, 10, 1))!.qty)).toBeCloseTo(1900000);
  });
});
