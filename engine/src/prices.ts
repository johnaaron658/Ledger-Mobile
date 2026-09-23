// Price graph + valuation lookup (`-X`) — §3.2 step 6.
//
// Valuation-date semantics (§3.3), resolved empirically rather than guessed:
// a probe journal (one commodity, three P directives at 2024/01/01,
// 2024/06/01, 2024/12/01; one posting dated 2024/03/15) run through the real
// `ledger` 3.3.2 CLI shows:
//
//   `bal -X PHP --end 2024/04/01` -> values at the 2024/01/01 price
//   `bal -X PHP --end 2024/07/01` -> values at the 2024/06/01 price
//   `bal -X PHP --end 2024/12/15` -> values at the 2024/12/01 price
//
// i.e. `bal` values the final accumulated balance using the price in effect
// **at the report's end date**, not the posting date. `reg -X` (used by
// account_history) instead re-values the *running* native balance at **each
// row's own date** — confirmed against the real captured golden fixture
// (test/golden/04-history-foreign-currency.txt): the same AED holding is
// shown as 15,850 PHP on 2025/02/20 (AED price then: 15.85) and jumps to
// 4,733.92 PHP by 2025/02/21 purely from the price update, with ledger even
// inserting synthetic zero-quantity "Commodities revalued" rows at every
// P-directive date where the held quantity is non-zero. That row-insertion
// behaviour belongs to register.ts (step 7); this module only answers "what
// is X worth on date D", using "the latest price at or before D" either way
// — report.ts/balance.ts decide *which* D to ask for.

import { type Amount, type Commodity, type Quantity, formatQuantity, mulQuantity } from "./amount.js";
import type { Journal, PricePoint } from "./journal.js";

export class PriceIndex {
  private byCommodity = new Map<Commodity, PricePoint[]>();

  constructor(points: PricePoint[]) {
    for (const p of points) {
      const list = this.byCommodity.get(p.commodity);
      if (list) list.push(p);
      else this.byCommodity.set(p.commodity, [p]);
    }
    for (const list of this.byCommodity.values()) {
      list.sort((a, b) => a.date.getTime() - b.date.getTime());
    }
  }

  /** The latest price point for `commodity` at or before `date`, or null if
   * none exists yet at that point in time. Binary search over the
   * ascending-sorted list built in the constructor. */
  priceAt(commodity: Commodity, date: Date): PricePoint | null {
    const list = this.byCommodity.get(commodity);
    if (!list || list.length === 0) return null;
    const t = date.getTime();
    let lo = 0;
    let hi = list.length - 1;
    let result: PricePoint | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].date.getTime() <= t) {
        result = list[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  /** Every price point recorded for `commodity`, ascending by date —
   * register.ts (step 7) uses this to find revaluation checkpoints within a
   * reported date range. */
  pricesFor(commodity: Commodity): readonly PricePoint[] {
    return this.byCommodity.get(commodity) ?? [];
  }

  commodities(): Commodity[] {
    return [...this.byCommodity.keys()];
  }
}

/** Builds the index from both real `P` directives and every lot price found
 * in the journal's postings — "1 House @ 1800000 PHP" contributes an
 * implicit PHP price for House dated at its transaction, exactly as
 * MOBILE_APP_IMPLEMENTATION.md §3.2 step 5 specifies. This blends multiple
 * differently-priced lots of the same commodity into one timeline (later lot
 * price wins for later queries) rather than tracking per-lot cost basis
 * separately; the real journal only has a single House lot, so this
 * approximation isn't exercised beyond that, but it's the documented
 * simplification if a future journal ever has more than one. */
export function buildPriceIndex(journal: Journal): PriceIndex {
  const points: PricePoint[] = [...journal.prices];
  for (const txn of journal.transactions) {
    for (const posting of txn.postings) {
      if (posting.amount?.lotPrice) {
        points.push({
          date: txn.date,
          commodity: posting.amount.commodity,
          price: posting.amount.lotPrice,
          line: txn.begLine,
          amountRaw: formatQuantity(posting.amount.lotPrice.qty),
        });
      }
    }
  }
  return new PriceIndex(points);
}

/** Values `amount` in `target` commodity as of `date`: same commodity is a
 * no-op, otherwise a direct price lookup, otherwise one hop through
 * whatever intermediate commodity `amount`'s direct price lands on (per
 * §3.2 step 6 — "direct, then one hop", not a full graph search). Returns
 * null if no path exists at that date; callers treat that the same way the
 * desktop's `is_report_currency` does — bucket the amount separately rather
 * than drop it. */
export function valueAt(index: PriceIndex, amount: Amount, target: Commodity, date: Date): Amount | null {
  if (amount.commodity === target) return amount;

  const direct = index.priceAt(amount.commodity, date);
  if (!direct) return null;
  if (direct.price.commodity === target) {
    return { commodity: target, qty: mulQuantity(amount.qty, direct.price.qty) };
  }

  const hop = index.priceAt(direct.price.commodity, date);
  if (hop && hop.price.commodity === target) {
    const combinedRate: Quantity = mulQuantity(direct.price.qty, hop.price.qty);
    return { commodity: target, qty: mulQuantity(amount.qty, combinedRate) };
  }

  return null;
}
