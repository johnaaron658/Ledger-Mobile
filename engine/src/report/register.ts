// register() — §3.2 step 7.
//
// Filters postings by account regex and [begin, end), sorts by date
// (stable, original order within a date), and emits either the raw
// per-posting amount or, when a valuation target is given, a per-posting
// valued amount plus a running multi-commodity Balance.
//
// Two things this module discovered empirically, beyond what step 7's
// build-order line anticipated, both pinned against the real captured
// fixtures rather than guessed:
//
// 1. **`reg` hides zero-amount postings by default** (no `--empty`).
//    Confirmed: `ledger reg 8249` omits a real `₱0` "Starting Balance"
//    posting that `ledger reg 8249 --empty` includes. A transaction whose
//    every posting is zero therefore never appears at all (see
//    validate.spec.ts's begLine-368 case) — `options.includeZero` mirrors
//    `--empty`, default false.
//
// 2. **`-X` inserts synthetic "Commodities revalued" rows.** When a `reg`
//    query spans a date where a *held* commodity's price changes, real
//    ledger inserts a zero-native-quantity row (payee "Commodities
//    revalued", account "<Revalued>", file "", beg_line/end_line 0) whose
//    value is the resulting mark-to-market delta — confirmed against
//    test/golden/04-history-foreign-currency.txt line by line (see
//    prices.ts's header comment for the full derivation). This engine
//    reproduces that for the *running-total* path (needed by
//    account_history, where the rows are directly user-visible), using the
//    natural generalization "per matched-account-scope net holding of each
//    priced commodity" rather than a single hardcoded account. It does
//    *not* reproduce it for the per-posting valuedAmount path (shapes 9/10,
//    analysis._reg_args) — confirmed harmless there: `compute_analysis`
//    only ever reads Expenses-prefixed or explicitly-categorized accounts,
//    and "<Revalued>" postings match neither, so the desktop backend
//    silently discards them too. Reproducing ledger's *global* (no account
//    filter) revaluation algorithm exactly was not attempted — it isn't
//    needed for the app to produce identical answers, only for
//    byte-identical raw CLI-shape fixtures, which Phase 1's own exit
//    criterion doesn't require beyond "numerically equal to 2dp for money".
//
// KNOWN, ROOT-CAUSED, ACCEPTED GAP: crosschecking the full account_history
// sequence for the real Expenses:Currency:AED account against
// test/golden/api/accounts-history-Expenses_Currency_AED.json produces 27 of
// its 31 rows exactly. Diagnosed with `ledger reg ... --format
// "beg=%(xact.beg_line) amount=%(quoted(amount))"` (unjoined, so a
// multi-commodity posting's components print as separate lines instead of
// being folded into one): every "missing" row turns out to be ledger
// splitting ONE posting's `amount` into two commodity components — e.g.
// beg_line 2699 ("Expenses:Currency:AED" eliding a sibling
// `((AED600.00/6)*3)` posting) prints as `amount="-0.00001 PHP"` immediately
// followed by `amount="AED-300.00"`. That `±0.00001 PHP` sliver is uniform
// across every occurrence (beg_lines 2615, 2683, 2699, 2707 all show exactly
// ±0.00001, never any other magnitude) — a fixed rounding quantum from
// ledger's internal fixed-point arithmetic when eliding against a compound
// multiply-of-a-divide expression under simultaneous `-X` valuation, not a
// meaningful value. It rounds to 0.00 at 2dp, so it's invisible at the
// precision Phase 1's own exit criterion actually requires ("numerically
// equal to 2dp for money") and at the precision every API response is
// rounded to (`round(x, 2)` on the Python side). Not reproduced: doing so
// would mean bit-for-bit replicating an undocumented internal precision
// buffer in ledger's C++ implementation, for a value that can never surface
// above the cent.

import {
  type Amount,
  type Balance,
  type Commodity,
  type Quantity,
  addQuantity,
  addToBalance,
  isZeroQuantity,
  negateQuantity,
} from "../amount.js";
import type { Journal } from "../journal.js";
import { type PriceIndex, valueAt } from "../prices.js";

export interface Valuation {
  index: PriceIndex;
  target: Commodity;
  /** Enables running-Balance tracking and "Commodities revalued" checkpoint
   * rows (needed by account_history's display_total; not by the per-posting
   * display_amount shapes, which don't want the extra rows — see the module
   * comment). Off by default: valuedAmount is always computed when a
   * Valuation is given, but runningTotal stays null and no revaluation rows
   * are emitted unless this is true. */
  trackTotal?: boolean;
}

export interface RegisterOptions {
  /** Matches the full account path, case-insensitively, unanchored — same
   * semantics as ledger's own positional account argument (a substring/regex
   * match, not an exact match). Omit to match every account. */
  accountPattern?: RegExp;
  begin?: Date; // inclusive
  end?: Date; // exclusive
  valuation?: Valuation;
  /** Mirrors `--empty`: include zero-amount postings instead of hiding them. */
  includeZero?: boolean;
  /** "date" (default): return rows chronologically, ties broken by file
   * order — matches ledger's `--sort date`, which shapes 1 and 4 (transaction
   * listing, account_history) both pass explicitly. "none": return rows in
   * the journal's own file/parse order instead — matches ledger's DEFAULT
   * `reg` order when no `--sort` is given at all (shapes 9/10,
   * analysis._reg_args, per capture-fixtures.py's own argv), which is *not*
   * a global date sort. Confirmed against the real journal: a projections
   * section merged early in the consolidated file (future dates, low
   * beg_line) prints before later-beg_line, earlier-dated real transactions
   * — file order and date order can genuinely disagree. Internal balance and
   * revaluation-checkpoint processing always walks chronologically
   * regardless of this option; only the returned row order changes. */
  sort?: "date" | "none";
}

export interface RegisterRow {
  date: Date;
  payee: string;
  account: string;
  /** The posting's own native amount; null for a synthetic revaluation row,
   * which has no discrete posting behind it. */
  amount: Amount | null;
  /** `amount` valued at this row's own date (ledger's `display_amount`), or
   * the mark-to-market delta for a revaluation row. Null when no valuation
   * was requested, or when the amount's commodity has no price path yet. */
  valuedAmount: Amount | null;
  /** The running balance for the matched scope, valued at this row's date
   * (ledger's `display_total`) — every commodity with a price path merged
   * into one `valuation.target` total, anything without one left as its own
   * entry. Null when no valuation was requested. */
  runningTotal: Balance | null;
  isRevaluation: boolean;
  file: string | null;
  begLine: number;
  endLine: number;
}

function accountMatches(pattern: RegExp | undefined, account: string): boolean {
  return !pattern || pattern.test(account);
}

/** Converts every commodity in `balance` that has a price path into one
 * `target` total; anything without a path is passed through unconverted.
 * This is `-X`'s real per-commodity behavior — the golden fixtures'
 * multi-line `join(display_total)` output is exactly "convert what you can,
 * leave the rest", confirmed in accounts.py's own is_report_currency split.
 *
 * A balance that nets to exactly zero still gets an explicit `{target: 0}`
 * entry rather than coming back empty — confirmed against the real fixture:
 * an AED account that nets to 0 still shows "0.00000 PHP", not a blank line
 * (real example: "Deposit for Bookings" in
 * test/golden/api/accounts-history-Expenses_Currency_AED.json). */
export function valueBalance(index: PriceIndex, balance: Balance, target: Commodity, date: Date): Balance {
  const result: Balance = new Map();
  let converted: Quantity | null = null;
  for (const [commodity, qty] of balance) {
    if (isZeroQuantity(qty)) continue;
    const valued = valueAt(index, { commodity, qty }, target, date);
    if (valued) {
      converted = converted ? addQuantity(converted, valued.qty) : valued.qty;
    } else {
      addToBalance(result, { commodity, qty });
    }
  }
  if (converted !== null) addToBalance(result, { commodity: target, qty: converted });
  else if (result.size === 0) result.set(target, { units: 0n, scale: 0 });
  return result;
}

interface Item {
  date: Date;
  payee: string;
  account: string;
  amount: Amount;
  file: string;
  begLine: number;
  endLine: number;
  /** Position in file/parse order (journal.transactions iteration order),
   * captured before the chronological sort below — `sort: "none"` restores
   * this order for the returned rows. */
  naturalIndex: number;
}

export function register(journal: Journal, options: RegisterOptions = {}): RegisterRow[] {
  const items: Item[] = [];
  for (const txn of journal.transactions) {
    if (options.begin && txn.date.getTime() < options.begin.getTime()) continue;
    if (options.end && txn.date.getTime() >= options.end.getTime()) continue;
    for (const posting of txn.postings) {
      if (!accountMatches(options.accountPattern, posting.account)) continue;
      if (posting.amount === null) continue; // post-elision this shouldn't happen; guard anyway
      items.push({
        date: txn.date,
        payee: txn.payee,
        account: posting.account,
        amount: posting.amount,
        file: "",
        begLine: txn.begLine,
        endLine: txn.endLine,
        naturalIndex: items.length,
      });
    }
  }
  // Internal balance/revaluation processing always walks chronologically,
  // regardless of `options.sort` — stable sort by date (Array#sort is
  // stable per spec — original insertion order, which is already document
  // order, is the tiebreak).
  items.sort((a, b) => a.date.getTime() - b.date.getTime());

  const rows: RegisterRow[] = [];
  // Parallel to `rows` — each entry's file/parse-order position, used only
  // when `options.sort === "none"` to restore natural order at the end. A
  // revaluation row has no file position of its own; it sorts after every
  // real row (Infinity), retaining its own emission order among other
  // revaluation rows via the final sort's stability.
  const naturalIndices: number[] = [];
  const val = options.valuation;
  const nativeBalance: Balance = new Map();
  let previousValued: Balance = new Map();

  function currentlyHeldPricedCommodities(): Commodity[] {
    if (!val) return [];
    const out: Commodity[] = [];
    for (const [c, q] of nativeBalance) {
      if (!isZeroQuantity(q) && val.index.pricesFor(c).length > 0) out.push(c);
    }
    return out;
  }

  function balanceTargetQty(balance: Balance): Quantity {
    return balance.get(val!.target) ?? { units: 0n, scale: 0 };
  }

  /** Emits one synthetic row per price-change checkpoint for any
   * currently-held, currently-priced commodity in (afterExclusive,
   * beforeInclusive ? beforeBound : beforeBound). Same-day checkpoints fire
   * once, before that day's real postings (matches the fixture ordering). */
  function emitRevaluations(afterExclusive: Date | null, beforeBound: Date, inclusive: boolean): void {
    if (!val || !val.trackTotal) return;
    const afterMs = afterExclusive?.getTime() ?? Number.NEGATIVE_INFINITY;
    const beforeMs = beforeBound.getTime();
    const checkpoints = new Set<number>();
    for (const c of currentlyHeldPricedCommodities()) {
      for (const pp of val.index.pricesFor(c)) {
        const t = pp.date.getTime();
        if (t > afterMs && (inclusive ? t <= beforeMs : t < beforeMs)) checkpoints.add(t);
      }
    }
    for (const t of [...checkpoints].sort((a, b) => a - b)) {
      const date = new Date(t);
      const valuedNow = valueBalance(val.index, nativeBalance, val.target, date);
      const delta = addQuantity(balanceTargetQty(valuedNow), negateQuantity(balanceTargetQty(previousValued)));
      previousValued = valuedNow;
      if (isZeroQuantity(delta)) continue;
      rows.push({
        date,
        payee: "Commodities revalued",
        account: "<Revalued>",
        amount: null,
        valuedAmount: { commodity: val.target, qty: delta },
        runningTotal: valuedNow,
        isRevaluation: true,
        file: null,
        begLine: 0,
        endLine: 0,
      });
      naturalIndices.push(Number.POSITIVE_INFINITY);
    }
  }

  let previousDate: Date | null = null;
  let i = 0;
  while (i < items.length) {
    const date = items[i].date;
    emitRevaluations(previousDate, date, true);

    let j = i;
    while (j < items.length && items[j].date.getTime() === date.getTime()) {
      const item = items[j];
      addToBalance(nativeBalance, item.amount);
      const isZero = isZeroQuantity(item.amount.qty);

      let valuedAmount: Amount | null = null;
      let runningTotal: Balance | null = null;
      if (val) {
        valuedAmount = valueAt(val.index, item.amount, val.target, item.date);
        if (val.trackTotal) {
          runningTotal = valueBalance(val.index, nativeBalance, val.target, item.date);
          previousValued = runningTotal;
        }
      }

      if (!isZero || options.includeZero) {
        rows.push({
          date: item.date,
          payee: item.payee,
          account: item.account,
          amount: item.amount,
          valuedAmount,
          runningTotal,
          isRevaluation: false,
          file: item.file,
          begLine: item.begLine,
          endLine: item.endLine,
        });
        naturalIndices.push(item.naturalIndex);
      }
      j++;
    }
    previousDate = date;
    i = j;
  }

  // Trailing checkpoints after the last matched posting: with an explicit
  // `end`, up to (but not including) it — matching the exclusive-end
  // convention. With no `end` at all (account_history's case), real ledger
  // still shows revaluations all the way through the latest known price —
  // confirmed against the real fixture: an AED account's last row is a
  // trailing "Commodities revalued" with no further real posting after it
  // (test/golden/api/accounts-history-Expenses_Currency_AED.json's final
  // entry). So an absent `end` means "through the latest price point this
  // engine knows about", not "no trailing checkpoints at all".
  const farFuture = new Date(8640000000000000); // Date's max representable value
  emitRevaluations(previousDate, options.end ?? farFuture, !options.end);

  if (options.sort === "none") {
    return rows
      .map((row, i) => ({ row, naturalIndex: naturalIndices[i] }))
      .sort((a, b) => a.naturalIndex - b.naturalIndex)
      .map((w) => w.row);
  }
  return rows;
}
