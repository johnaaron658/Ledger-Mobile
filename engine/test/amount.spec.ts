import { describe, expect, it } from "vitest";
import {
  addQuantity,
  compareQuantity,
  formatQuantity,
  isReportCurrency,
  negateQuantity,
  parseAmount,
  toNumber,
} from "../src/amount.js";

describe("parseAmount", () => {
  it("parses a prefixed currency symbol", () => {
    const { quantity, currency } = parseAmount("₱1,234.56");
    expect(currency).toBe("₱");
    expect(toNumber(quantity!)).toBeCloseTo(1234.56);
  });

  it("parses a suffixed currency code", () => {
    const { quantity, currency } = parseAmount("-500.00 AED");
    expect(currency).toBe("AED");
    expect(toNumber(quantity!)).toBeCloseTo(-500);
  });

  it("parses a bare number with no commodity", () => {
    const { quantity, currency } = parseAmount("42");
    expect(currency).toBeNull();
    expect(toNumber(quantity!)).toBe(42);
  });

  it("parses a lot quantity like '1 House'", () => {
    const { quantity, currency } = parseAmount("1 House");
    expect(currency).toBe("House");
    expect(toNumber(quantity!)).toBe(1);
  });

  it("returns nulls on no match", () => {
    const { quantity, currency } = parseAmount("(₱8000 - ₱4230.92)");
    expect(quantity).toBeNull();
    expect(currency).toBeNull();
  });

  it("keeps trailing-zero scale distinct from Python float equality", () => {
    // "5327.5" must not silently become scale 2 with a phantom trailing digit.
    const { quantity } = parseAmount("₱5327.5");
    expect(quantity).toEqual({ units: 53275n, scale: 1 });
  });
});

describe("isReportCurrency", () => {
  const aliases = new Set(["PHP", "₱"]);

  it("is true for the report currency by symbol or code", () => {
    expect(isReportCurrency("₱", aliases)).toBe(true);
    expect(isReportCurrency("PHP", aliases)).toBe(true);
    expect(isReportCurrency("php", aliases)).toBe(true); // case-insensitive
  });

  it("is true for a null (bare formula) currency", () => {
    expect(isReportCurrency(null, aliases)).toBe(true);
  });

  it("is false for a foreign currency", () => {
    expect(isReportCurrency("AED", aliases)).toBe(false);
  });
});

describe("Quantity arithmetic", () => {
  it("adds across differing scales exactly", () => {
    const a = { units: 100n, scale: 0 }; // 100
    const b = { units: 5n, scale: 1 }; // 0.5
    expect(addQuantity(a, b)).toEqual({ units: 1005n, scale: 1 });
  });

  it("negates", () => {
    expect(negateQuantity({ units: 123n, scale: 2 })).toEqual({ units: -123n, scale: 2 });
  });

  it("compares across differing scales", () => {
    expect(compareQuantity({ units: 1n, scale: 0 }, { units: 99n, scale: 2 })).toBe(1);
    expect(compareQuantity({ units: 1n, scale: 2 }, { units: 1n, scale: 0 })).toBe(-1);
    expect(compareQuantity({ units: 10n, scale: 1 }, { units: 1n, scale: 0 })).toBe(0);
  });

  it("does not lose precision the way IEEE floats would", () => {
    // 0.1 + 0.2 !== 0.3 in float64; must be exact here.
    const a = { units: 1n, scale: 1 };
    const b = { units: 2n, scale: 1 };
    expect(addQuantity(a, b)).toEqual({ units: 3n, scale: 1 });
  });
});

describe("formatQuantity", () => {
  it("round-trips positive and negative amounts", () => {
    expect(formatQuantity({ units: 123456n, scale: 2 })).toBe("1234.56");
    expect(formatQuantity({ units: -423092n, scale: 2 })).toBe("-4230.92");
    expect(formatQuantity({ units: 5n, scale: 0 })).toBe("5");
  });

  it("pads fractional zeros for small units", () => {
    expect(formatQuantity({ units: 5n, scale: 2 })).toBe("0.05");
  });
});
