// Pins the two confirmed, contradictory real exact-tie cases (2026-09-24
// follow-up pass) that motivate roundQuantityToPrecision's `wasConverted`
// parameter — see the function's own comment and MOBILE_APP_IMPLEMENTATION.md
// §5 item 2 for the full derivation. Neither case is reachable from the
// committed golden fixtures (those are gitignored/oracle-only), so this is
// the only place these two real transactions' behavior is pinned in CI.

import type { Amount } from "@ledger/engine";
import { describe, expect, it } from "vitest";
import { roundQuantityToPrecision, wasActuallyConverted } from "../src/ledgerFormat.js";

function amount(commodity: string, decimal: string): Amount {
  const negative = decimal.startsWith("-");
  const [intPart, fracPart = ""] = decimal.replace("-", "").split(".");
  const units = BigInt((intPart + fracPart) || "0") * (negative ? -1n : 1n);
  return { commodity, qty: { units, scale: fracPart.length } };
}

describe("roundQuantityToPrecision — wasConverted tie-breaking", () => {
  it("Banh Mi (2024/11/13, Assets:Checking:Recievables:Girlie): -50,000 VND @ 0.0023139409 PHP is an exact tie, rounds half-up when converted", () => {
    // -50000 * 0.0023139409 = -115.697045 exactly.
    const valued = amount("PHP", "-115.697045");
    expect(roundQuantityToPrecision(valued.qty, 5, true)).toEqual({ units: -11569705n, scale: 5 });
    // The default (unconverted) half-to-even would get this wrong (4 is
    // already even, so it wouldn't round up) — confirming the flag matters.
    expect(roundQuantityToPrecision(valued.qty, 5, false)).toEqual({ units: -11569704n, scale: 5 });
  });

  it("(₱5,655.38165/2) (2025/11/01, Assets:Checking:Recievables:Harriet): a same-currency expression tie rounds half-to-even, not half-up", () => {
    const valued = amount("PHP", "2827.690825");
    expect(roundQuantityToPrecision(valued.qty, 5, false)).toEqual({ units: 282769082n, scale: 5 });
    // Confirms this transaction would silently break if ever misclassified
    // as "converted" — exactly the regression wasActuallyConverted's
    // value-comparison (over a naive commodity-string check) prevents.
    expect(roundQuantityToPrecision(valued.qty, 5, true)).toEqual({ units: 282769083n, scale: 5 });
  });
});

describe("wasActuallyConverted", () => {
  it("is true for a real cross-commodity conversion (VND valued in PHP)", () => {
    const native = amount("VND", "-50000");
    const valued = amount("PHP", "-115.697045");
    expect(wasActuallyConverted(native, valued)).toBe(true);
  });

  it("is false for a same-currency identity-price passthrough, even though the commodity STRINGS differ", () => {
    // The real journal's identity price ("P ... ₱ 1 PHP") makes valueAt()
    // route "₱"-prefixed amounts through its actual multiplication branch
    // (×1) too, so `amount.commodity !== target` alone is true here even
    // though no real conversion happened — this is the exact bug a naive
    // string check had. Comparing values catches it.
    const native = amount("₱", "2827.690825");
    const valued = amount("PHP", "2827.690825"); // ×1 via the identity price
    expect(wasActuallyConverted(native, valued)).toBe(false);
  });

  it("is false when either side is null", () => {
    expect(wasActuallyConverted(null, amount("PHP", "1"))).toBe(false);
    expect(wasActuallyConverted(amount("PHP", "1"), null)).toBe(false);
  });

  it("is value-based, not scale-based — same value at different scales still compares equal", () => {
    const native: Amount = { commodity: "PHP", qty: { units: 100n, scale: 0 } }; // 100
    const valued: Amount = { commodity: "PHP", qty: { units: 100000n, scale: 3 } }; // 100.000
    expect(wasActuallyConverted(native, valued)).toBe(false);
  });
});
