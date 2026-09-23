import { describe, expect, it } from "vitest";
import { toNumber } from "../src/amount.js";
import { ExprError, evaluateExpr, valueToAmount } from "../src/expr.js";

function amountValue(text: string) {
  const v = evaluateExpr(text);
  const amount = valueToAmount(v);
  return { commodity: amount.commodity, value: toNumber(amount.qty) };
}

function numberValue(text: string) {
  const v = evaluateExpr(text);
  if (v.kind !== "number") throw new Error("expected a bare number");
  return toNumber(v.qty);
}

describe("evaluateExpr — real journal expressions (§3.2 step 2 corpus)", () => {
  it.each([
    ["(₱8000 - ₱4230.92)", "₱", 3769.08],
    ["(56,214.6089 PHP + 46,448.9038 PHP)", "PHP", 102663.5127],
    ["(635,000 VND - 244000 VND)", "VND", 391000],
    ["(₱13744.20 + ₱2500 + ₱80)", "₱", 16324.2],
    ["(-₱3974.97)", "₱", -3974.97],
    ["(JPY 1450*1)", "JPY", 1450],
    ["(JPY 99*12)", "JPY", 1188],
    ["(AED103.00/2)", "AED", 51.5],
    ["(₱1200*2/4)", "₱", 600],
    ["(₱1899.00/5 + ₱1899.00/5)", "₱", 759.6],
    ["(KRW94,000.00 - KRW28,200)", "KRW", 65800],
    ["(PHP1050.05/3)", "PHP", 350.0166666667],
  ])("%s -> %s %f", (text, commodity, expected) => {
    const { commodity: c, value } = amountValue(text);
    expect(c).toBe(commodity);
    expect(value).toBeCloseTo(expected as number, 4);
  });

  it("evaluates a bare-number expression without a commodity", () => {
    expect(numberValue("(258,000/2)")).toBeCloseTo(129000);
  });

  it("parses without the enclosing parens too", () => {
    expect(amountValue("₱8000 - ₱4230.92").value).toBeCloseTo(3769.08);
  });
});

describe("evaluateExpr — error cases", () => {
  it("rejects mismatched commodities on add/subtract", () => {
    expect(() => evaluateExpr("(₱100 - $50)")).toThrow(ExprError);
  });

  it("rejects multiplying two amounts", () => {
    expect(() => evaluateExpr("(₱100 * $2)")).toThrow(ExprError);
  });

  it("rejects dividing a bare number by an amount", () => {
    expect(() => evaluateExpr("(2 / ₱100)")).toThrow(ExprError);
  });

  it("rejects mixing an amount and a bare number under +/-", () => {
    expect(() => evaluateExpr("(₱100 + 5)")).toThrow(ExprError);
  });

  it("rejects an unbalanced paren", () => {
    expect(() => evaluateExpr("(₱100 - ₱50")).toThrow(ExprError);
  });

  it("rejects trailing garbage after a complete expression", () => {
    expect(() => evaluateExpr("(₱100) (₱50)")).toThrow(ExprError);
  });
});
