// balance() — §3.2 step 8 (`bal --flat`, incl. `--empty` and `--period`).
//
// "--flat" does NOT mean "no tree rolling" (an earlier draft of this module
// assumed that and was wrong — see below). Every account's shown value is
// still the *full* rolled-up total of itself plus all descendants, exactly
// like plain hierarchical `bal`; the only thing `--flat` changes is which
// accounts get their own printed row: one per account that has at least one
// posting made *directly* to it, rather than one per leaf with indentation
// collapsing single-child chains. A pure organizational account that's never
// posted to directly (only ever through more specific children) gets no row
// of its own at all under either mode — its contribution is only visible
// through its children's own rows.
//
// Two-phase model, confirmed against the real journal: ledger first filters
// *postings* by the account pattern (only postings whose account passes it
// are considered at all), then rolls up hierarchically within that filtered
// set. So `bal --flat "Assets:Checking"` (substring, also matches every
// descendant) reports "Assets:Checking" as 1,529,393.33 PHP (its own 18
// postings *plus* every Banking:*/Recievables:* descendant), while
// `bal --flat "^Assets:Checking$"` (anchored, matches nothing else) reports
// -449,000.00 PHP (its own 18 postings only, descendants excluded from the
// filtered set entirely, not just from being separately printed).
//
// FOUND A REAL DESKTOP BUG while working this out (ground rule 2: record it,
// don't silently match it). backend/app/accounts.py's build_account_tree()
// assumes _leaf_balances()'s rows are each account's *own-only* sum, then
// calls propagate() to roll children up into parents on top of that. Since
// ledger's rows are already fully rolled up, any account that has *both* its
// own direct postings *and* child accounts gets double-counted — verified to
// the centavo against test/golden/api/accounts.json: Assets:Checking:Recievables
// shows balance_php=717,415.89 (its correct value, 359,054.36, plus its own
// children's total of 358,361.53 added a second time), and that inflated
// figure then flows into Assets:Checking's own total (3,866,148.18 instead
// of 1,529,393.33). Only two accounts in the current journal have both own
// postings and children (Assets:Checking and its child Recievables), so the
// blast radius today is narrow, but it's a real, currently-live bug in the
// Accounts tab. Not fixed here — this engine's balance() below does the
// correct single-rollup and was never going to inherit the bug, but
// accounts.py itself needs the same fix (skip propagate()'s add for a node
// that already has its own row from ledger, only sum children into a node
// that never got one).
//
// Valuation date: per prices.ts's §3.3 derivation, `bal -X` values the
// accumulated balance using the price in effect *at the report's end*. This
// module never reads the clock itself (packages/engine has no I/O) — an
// open-ended query (no `end`, e.g. accounts._leaf_balances's real call shape)
// still needs an explicit "as of" date for valuation, which is the caller's
// job to supply (Phase 2's accountsView.ts passes today's date). That's why
// `valuation.asOf` is required, not defaulted from `end`: defaulting it
// would silently pick up any future-dated price point instead of erroring
// when a caller forgets to decide what "now" means.

import { type Balance, type Commodity, addToBalance } from "../amount.js";
import type { Journal } from "../journal.js";
import type { PriceIndex } from "../prices.js";
import { valueBalance } from "./register.js";

export interface BalanceValuation {
  index: PriceIndex;
  target: Commodity;
  asOf: Date;
}

export interface BalanceOptions {
  /** Same substring/regex semantics as register.ts's accountPattern, and the
   * same two-phase role described above: only postings whose account
   * matches are considered at all. Omit to match every account (the real
   * shape 2/5 call shapes: no account filter). Multiple ledger positional
   * patterns (e.g. bal's `--empty ^A$ ^B$ ...`) are the caller's job to OR
   * together into one RegExp before calling. */
  accountPattern?: RegExp;
  begin?: Date; // inclusive
  end?: Date; // exclusive
  valuation?: BalanceValuation;
  /** Mirrors `--empty`: force a row (possibly zero) for each of these exact
   * account names, regardless of whether they have any posting anywhere in
   * the journal — not just within [begin, end). An explicit list, not a
   * boolean: real callers already have it on hand (it's the same list that
   * becomes the `^A$ ^B$ ...` accountPattern alternatives —
   * budgets._ledger_totals's real usage), and scanning the journal for
   * "does this account exist anywhere" isn't equivalent — confirmed against
   * the real journal, where a budget category can have zero real
   * transactions ever (Expenses:Insurance:BDOLife, Expenses:Subscriptions:
   * Youtube Premium Family: both exist only in `~` periodic blocks, never in
   * a transaction; see parse.spec.ts) and `--empty` still has to produce a
   * zero row for them. */
  includeEmpty?: string[];
}

export interface BalanceRow {
  account: string;
  balance: Balance;
}

function accountMatches(pattern: RegExp | undefined, account: string): boolean {
  return !pattern || pattern.test(account);
}

function isZeroBalance(balance: Balance): boolean {
  return [...balance.values()].every((q) => q.units === 0n);
}

export function balance(journal: Journal, options: BalanceOptions = {}): BalanceRow[] {
  // Phase 1: sum each account's own direct postings, restricted to
  // postings whose account passes accountPattern and whose date is in
  // [begin, end) — ledger's own filtering happens on postings, not on the
  // final per-account totals.
  const exactSums = new Map<string, Balance>();
  for (const txn of journal.transactions) {
    if (options.begin && txn.date.getTime() < options.begin.getTime()) continue;
    if (options.end && txn.date.getTime() >= options.end.getTime()) continue;
    for (const posting of txn.postings) {
      if (posting.amount === null) continue; // post-elision this shouldn't happen; guard anyway
      if (!accountMatches(options.accountPattern, posting.account)) continue;
      let acctBalance = exactSums.get(posting.account);
      if (!acctBalance) {
        acctBalance = new Map();
        exactSums.set(posting.account, acctBalance);
      }
      addToBalance(acctBalance, posting.amount);
    }
  }

  // Reportable accounts: one row per account with its own direct (filtered)
  // posting, plus every account named in includeEmpty, whether or not it
  // has ever had a posting.
  const reportable = new Set(exactSums.keys());
  for (const account of options.includeEmpty ?? []) {
    if (accountMatches(options.accountPattern, account)) reportable.add(account);
  }

  // Phase 2: each reportable account's value is the full rolled-up total of
  // itself plus every descendant present in the (already-filtered) exactSums
  // — not just its own row.
  function rolledUp(account: string): Balance {
    const result: Balance = new Map();
    const prefix = `${account}:`;
    for (const [candidate, native] of exactSums) {
      if (candidate === account || candidate.startsWith(prefix)) {
        for (const [commodity, qty] of native) addToBalance(result, { commodity, qty });
      }
    }
    return result;
  }

  const val = options.valuation;
  const rows: BalanceRow[] = [];
  for (const account of reportable) {
    const native = rolledUp(account);
    if (isZeroBalance(native) && !options.includeEmpty?.includes(account)) continue; // ledger hides a zero net by default
    rows.push({ account, balance: val ? valueBalance(val.index, native, val.target, val.asOf) : native });
  }
  rows.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  return rows;
}

/** `--period "this month"`'s date math — the only period phrase any real
 * call shape uses (budgets._this_month_actuals). `today` is caller-supplied
 * for the same reason `valuation.asOf` is: this module reads no clock. */
export function thisMonthRange(today: Date): { begin: Date; end: Date } {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  return { begin: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}
