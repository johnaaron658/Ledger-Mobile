// periodic.ts — §3.2 step 9, the highest-risk piece: `~ <period>` expansion
// and `--budget --invert` semantics.
//
// Nothing in budgets.py actually expands periods itself — `_period_range`/
// `_expand_date` only extract the "from"/"to"/"in" date *bounds* out of a
// period phrase (used solely for `_covers`, i.e. "is this history block
// currently active") and never look at the period *keyword* (Monthly, Every
// N months, ...) at all. All of ledger's `--budget` arithmetic — expanding a
// periodic across an interval and summing budgeted-vs-actual — happens
// inside the `ledger` CLI itself. This module is therefore the *only* place
// in the whole port that has to reproduce that expansion, and it was
// entirely reverse-engineered from the real `ledger` 3.3.2 binary via a
// synthetic probe journal (ground rule 3), the same methodology as prices.ts
// §3.3, then cross-checked against the real journal's own budget totals.
//
// Confirmed by probe (`ledger --budget --invert bal --flat --empty ...`):
//
// 1. **An open-ended block (no "to" date) expands through today**, inclusive
//    of the current, not-yet-finished month. Probe: "~ Monthly from
//    2024/11" with today=2026/09/23 gives exactly 23 budgeted months
//    (Nov 2024 .. Sep 2026 inclusive) — so, like `-X`'s report-end
//    valuation (prices.ts §3.3), an unbounded query's implicit right edge is
//    "now", supplied by the caller (`cutoff`), never read from the clock
//    here.
// 2. **"Monthly" is calendar-month aligned, not anchored to the block's own
//    start date.** Probe: "~ Monthly from 2024/11/16 to 2024/12/15" (a
//    30-day window straddling two calendar months) counts as *two* budgeted
//    months (Nov and Dec), not one — a period counts if its calendar month
//    *overlaps* the block's [start, end] window at all, however partially.
// 3. **"Every N months" is the same calendar-month alignment, just strided.**
//    Probe: "~ Every 1 months from 2024/11/16 to 2024/12/15" gives the
//    identical result to (2)'s "Monthly" — confirming N=1 is literally
//    Monthly, not a from-block-start anchor. The stride offset is
//    determined by the block start's *month* alone (day-of-month is
//    irrelevant, per the same probe): a calendar month counts iff
//    `(monthIndex - startMonthIndex) % N === 0`. Cross-checked against the
//    real journal: Expenses:Insurance:Sunlife's "~ Every 3 months from
//    2024/11" budgets to exactly 60,000 PHP (8 × 7,500) in the real
//    test/golden/06-budget-diffs-full.txt / 07-budget-spent-full.txt pair —
//    Nov'24, Feb/May/Aug/Nov'25, Feb/May/Aug'26 is exactly 8 quarters
//    through today, matching to the peso.
// 4. **`--invert` just negates the raw `--budget` value.** Probe: raw
//    `--budget` gives "₱-2220" where `--invert` gives "₱2220" for the same
//    query; budgeted(2300) − actual(80) = 2220 matches by hand. So this
//    module computes "budgeted − actual" directly — that already *is* the
//    inverted figure budgets.py calls `diffs`/`remaining`.
// 5. **"Yearly" is calendar-*year* aligned**, the same rule as (2)/(3) one
//    level up — probe: "~ Yearly from 2024/06/15 to 2025/03/15" (a window
//    spanning parts of two calendar years) counts as 2 budgeted years, not
//    1. Found only after the first full-journal crosscheck failed on a real
//    "~ Yearly from 2025/02 to 2026/01" block this plan's build-order line
//    didn't call out by name.
//
// NOT verified against real ledger (no real budget block uses these units):
// "Every N days/weeks". Implemented as a principled generalization —
// anchored to the block's own start date and stepped by N, there being no
// natural "calendar day" grouping the way months/years align to the 1st.
// Flagged here rather than silently assumed correct; revisit with a real
// probe if a budget ever uses one.
//
// KNOWN, EXTERNAL, NOT REPRODUCED: a genuine bug in the `ledger` CLI itself,
// found by full-journal crosscheck and confirmed independent of this engine
// with nothing but raw `ledger` invocations. `budgets._envelopes`'s real
// query shape — one `--budget --invert bal --flat --empty ^A$ ^B$ ...`
// covering *all* budgeted accounts at once — gives
// Expenses:Subscriptions:Youtube and Expenses:Subscriptions:HBO their
// *budgeted* totals (2,863.35 and 2,014.95) instead of budgeted−actual
// (bisected down to a single interfering pair,
// `^Expenses:Subscriptions:Youtube$ ^Expenses:Others:Wedding$`, still
// reproduces it: -0.85 becomes 2,863.35 the moment Wedding's own periodic
// — "~ Yearly from 2025", budgeted ₱0 — joins the query). Querying either
// account alone, or in most smaller combinations, gives the mathematically
// correct answer, which is exactly what budgetRemaining() computes here
// (verified: this module's Wedding-alone and Youtube-alone results match
// ledger's own isolated-query output to the centavo).
//
// This turned out not to be reachable through the desktop's real call path
// as of this writing — budgets.py's list_budgets() only ever batches
// *currently active* categories into one query, and Youtube's/HBO's own
// budget blocks have already lapsed, so they're excluded before the batch
// ever runs — but which accounts count as "active" shifts every time a
// budget period lapses or a new one starts, so the same interaction could
// resurface with a different combination at any time. Fixed on the Python
// side regardless (backend/app/budgets.py's `_ledger_totals`, `--budget`
// path now queries one account at a time) rather than left latent — not
// fixable from ledger's own side, and not something worth replicating here.

import { type Amount, type Balance, type Commodity, addToBalance, mulQuantity, negateQuantity } from "../amount.js";
import { ledgerDate } from "../journal.js";
import type { Journal } from "../journal.js";
import type { PriceIndex } from "../prices.js";
import { balance } from "./balance.js";
import { valueBalance } from "./register.js";

export interface PeriodWindow {
  start: Date;
  end: Date | null; // null = open-ended
}

const DATE_TOKEN = /\d{4}(?:\/\d{1,2}(?:\/\d{1,2})?)?/.source;

/** Exported for budgets.ts's add_budget_period port, which needs this same
 * "from"/"to" token expansion to compute where a superseded block's implicit
 * close date falls — not just to derive a PeriodWindow. */
export function expandDateToken(token: string, isEnd: boolean): Date {
  const parts = token.split("/").map(Number);
  if (parts.length === 1) {
    const [y] = parts;
    return isEnd ? ledgerDate(y, 12, 31) : ledgerDate(y, 1, 1);
  }
  if (parts.length === 2) {
    const [y, m] = parts;
    if (isEnd) {
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return ledgerDate(y, m, daysInMonth);
    }
    return ledgerDate(y, m, 1);
  }
  const [y, m, d] = parts;
  return ledgerDate(y, m, d);
}

/** Port of budgets._period_range: extracts the "from"/"to"/"in" date bounds
 * out of a period phrase — the period *keyword* itself (Monthly, Every N
 * months, ...) is irrelevant here, exactly as in the Python original. */
export function periodRange(periodText: string): PeriodWindow {
  const text = periodText.toLowerCase();
  const toMatch = text.match(new RegExp(`\\bto\\s+(${DATE_TOKEN})`));
  let end = toMatch ? expandDateToken(toMatch[1], true) : null;
  const inMatch = text.match(new RegExp(`\\bin\\s+(${DATE_TOKEN})`));
  if (inMatch) {
    const start = expandDateToken(inMatch[1], false);
    end = end ?? expandDateToken(inMatch[1], true);
    return { start, end };
  }
  const fromMatch = text.match(new RegExp(`\\bfrom\\s+(${DATE_TOKEN})`));
  const start = fromMatch ? expandDateToken(fromMatch[1], false) : new Date(-8640000000000000); // date.min equivalent
  return { start, end };
}

/** Port of budgets._covers: does this block's window cover `date`? */
export function covers(window: PeriodWindow, date: Date): boolean {
  if (date.getTime() < window.start.getTime()) return false;
  if (window.end && date.getTime() > window.end.getTime()) return false;
  return true;
}

function expandDay1(token: string): Date {
  const parts = token.split("/").map(Number);
  if (parts.length === 1) return ledgerDate(parts[0], 1, 1);
  if (parts.length === 2) return ledgerDate(parts[0], parts[1], 1);
  return ledgerDate(parts[0], parts[1], parts[2]);
}

const oneDayMs = 86_400_000;

/** ledger's *own* internal parsing of a periodic block's "to" bound for
 * `--budget` expansion — confirmed BY PROBE to differ from periodRange()
 * above (which faithfully ports budgets.py's own `_expand_date`, needed
 * verbatim for the separate is-currently-active/`covers()` UI concern). A
 * bare "YYYY/MM" or "YYYY" "to" token is *exclusive*: it ends at the close
 * of the unit immediately before the one named, not at (or through) the
 * named unit itself. An explicit day ("YYYY/MM/DD") is the literal date,
 * inclusive, same as periodRange.
 *
 * Probe, cleanest form: "~ Monthly from 2024/01 to 2024/03" budgets to
 * exactly 200 (Jan+Feb, ₱100 each) — not 300 — so "to 2024/03" excludes
 * March entirely, ending at Feb's last day. Confirmed at the real-data
 * scale too: "~ Yearly from 2025/02 to 2026/01" (real
 * Expenses:Insurance:BDOLife) budgets to exactly 29,215.72 (1 year), not
 * 58,431.44 — "to 2026/01" excludes January 2026, so the window never
 * leaves calendar year 2025. Making the same "to" token explicit-day
 * instead ("to 2026/01/31") flips the result to 2 years, confirming it's
 * the token's bareness — not which date it names or which side it's on
 * ("from" was probed too and never matters: budgets.py's own is_end=false
 * already agrees with ledger there, day 1 either way). */
function expandBudgetToEnd(token: string): Date {
  if (token.split("/").length === 3) return expandDay1(token); // explicit day: literal, inclusive
  return new Date(expandDay1(token).getTime() - oneDayMs); // bare: exclusive, ends the day before
}

export function budgetWindow(periodText: string): PeriodWindow {
  const text = periodText.toLowerCase();
  const toMatch = text.match(new RegExp(`\\bto\\s+(${DATE_TOKEN})`));
  let end = toMatch ? expandBudgetToEnd(toMatch[1]) : null;
  const inMatch = text.match(new RegExp(`\\bin\\s+(${DATE_TOKEN})`));
  if (inMatch) {
    // "in" pins both ends to the *same* unit, so there's no preceding-unit
    // exclusion to apply — reuse periodRange's inclusive end-of-unit
    // expansion, not separately probed but unambiguous for every real "in"
    // block (all pair the same granularity on both sides, e.g. "Monthly in
    // 2024/11", where end-of-month vs start-of-month touches the same
    // calendar months either way).
    const start = expandDay1(inMatch[1]);
    end = end ?? expandDateToken(inMatch[1], true);
    return { start, end };
  }
  const fromMatch = text.match(new RegExp(`\\bfrom\\s+(${DATE_TOKEN})`));
  const start = fromMatch ? expandDay1(fromMatch[1]) : new Date(-8640000000000000);
  return { start, end };
}

export type PeriodUnit = "days" | "weeks" | "months" | "years";
export interface PeriodSpec {
  n: number;
  unit: PeriodUnit;
}

const EVERY_RE = /^every\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\b/;

/** Parses the period *keyword* (as opposed to periodRange's date bounds) —
 * "Monthly" or "Every N <unit>", the only two forms real budget data uses. */
export function parsePeriodSpec(periodText: string): PeriodSpec {
  const text = periodText.trim().toLowerCase();
  if (text.startsWith("monthly")) return { n: 1, unit: "months" };
  if (text.startsWith("yearly")) return { n: 1, unit: "years" }; // calendar-year aligned, confirmed by probe just like Monthly
  const m = EVERY_RE.exec(text);
  if (m) {
    const word = m[2];
    const unit: PeriodUnit = word.startsWith("day") ? "days" : word.startsWith("week") ? "weeks" : word.startsWith("month") ? "months" : "years";
    return { n: Number(m[1]), unit };
  }
  throw new Error(`unrecognized periodic unit: ${JSON.stringify(periodText)}`);
}

function monthIndex(d: Date): number {
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** How many period instances (per `spec`) overlap `window`, capped at
 * `cutoff` for an open-ended window or one whose own "to" date is still in
 * the future. See the module header for the calendar-alignment rules this
 * implements. */
export function countPeriods(spec: PeriodSpec, window: PeriodWindow, cutoff: Date): number {
  const effectiveEnd = window.end && window.end.getTime() < cutoff.getTime() ? window.end : cutoff;
  if (effectiveEnd.getTime() < window.start.getTime()) return 0;

  if (spec.unit === "months") {
    const startIdx = monthIndex(window.start);
    const endIdx = monthIndex(effectiveEnd);
    let count = 0;
    // Consecutive calendar months from startIdx..endIdx tile [window.start,
    // effectiveEnd] with no gaps, so every idx in range overlaps the window
    // by construction — the stride is the only real filter needed.
    for (let idx = startIdx; idx <= endIdx; idx++) {
      if ((idx - startIdx) % spec.n === 0) count++;
    }
    return count;
  }

  if (spec.unit === "years") {
    // Calendar-*year* boundaries (Jan 1), not "months stepped by 12" from
    // the block's own start month — those differ whenever the block starts
    // mid-year (probe: "Yearly from 2024/06/15 to 2025/03/15" is 2 budgeted
    // years, 2024 and 2025, not 1 twelve-month period from June).
    const startYear = window.start.getUTCFullYear();
    const endYear = effectiveEnd.getUTCFullYear();
    let count = 0;
    for (let y = startYear; y <= endYear; y++) {
      if ((y - startYear) % spec.n === 0) count++;
    }
    return count;
  }

  // days/weeks: anchored to the block's own start (unverified — see header).
  const stepMs = (spec.unit === "days" ? spec.n : spec.n * 7) * 86_400_000;
  const span = effectiveEnd.getTime() - window.start.getTime();
  return Math.floor(span / stepMs) + 1;
}

export interface BudgetValuation {
  index: PriceIndex;
  target: Commodity;
}

export interface BudgetOptions {
  /** Same OR'd-anchored-list convention as balance.ts's accountPattern —
   * budgets._envelopes builds one pattern per requested account. */
  accountPattern?: RegExp;
  /** Both the periodic-expansion cutoff ("today") and the valuation date for
   * both sides of the comparison — matching how `bal -X` and `--budget`
   * both resolve an unbounded query against the same implicit report end. */
  cutoff: Date;
  valuation?: BudgetValuation;
  /** Same as balance.ts's includeEmpty: force a row for each of these exact
   * account names even with zero budgeted and zero actual. */
  includeEmpty?: string[];
}

export interface BudgetRow {
  account: string;
  budgeted: Balance;
  actual: Balance;
  /** budgeted − actual, i.e. already `--invert`ed — positive means under
   * budget, negative means over. */
  remaining: Balance;
}

/** The native (unvalued) budgeted total for one account: sum, over every
 * periodic whose *first* posting names that account (the one budgets.py's
 * own parse_budgets_file() treats as "the" budget posting — any further
 * postings in the block are just the balancing/offset account), of
 * (instance count × per-instance amount). */
function nativeBudgetedTotal(journal: Journal, account: string, cutoff: Date): Balance {
  const result: Balance = new Map();
  for (const periodic of journal.periodics) {
    const first = periodic.postings[0];
    if (!first || first.account !== account || first.amount === null) continue;
    const spec = parsePeriodSpec(periodic.periodText);
    const window = budgetWindow(periodic.periodText);
    const count = countPeriods(spec, window, cutoff);
    if (count === 0) continue;
    const scaled: Amount = { commodity: first.amount.commodity, qty: mulQuantity(first.amount.qty, { units: BigInt(count), scale: 0 }) };
    addToBalance(result, scaled);
  }
  return result;
}

function subtractBalance(a: Balance, b: Balance): Balance {
  const result: Balance = new Map(a);
  for (const [commodity, qty] of b) addToBalance(result, { commodity, qty: negateQuantity(qty) });
  return result;
}

/** `--budget --invert bal --flat --empty <accounts>` — budgets._envelopes's
 * real call shape. Reuses balance() for the "actual" side (all-time, same
 * accountPattern/valuation/includeEmpty) so both sides agree on --flat's
 * rolled-up-subtree semantics and default zero-hiding for free. */
export function budgetRemaining(journal: Journal, options: BudgetOptions): BudgetRow[] {
  const actualRows = balance(journal, {
    accountPattern: options.accountPattern,
    valuation: options.valuation ? { ...options.valuation, asOf: options.cutoff } : undefined,
    includeEmpty: options.includeEmpty,
  });

  return actualRows.map(({ account, balance: actual }) => {
    const native = nativeBudgetedTotal(journal, account, options.cutoff);
    const budgeted = options.valuation ? valueBalance(options.valuation.index, native, options.valuation.target, options.cutoff) : native;
    return { account, budgeted, actual, remaining: subtractBalance(budgeted, actual) };
  });
}
