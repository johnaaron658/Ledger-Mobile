// Port of backend/app/analysis.py.
//
// Shapes 9-10 (MOBILE_APP_IMPLEMENTATION.md §2.2) use `display_amount`
// (per-posting), not `display_total` — engine's register() already carries
// both, so this is a thinner port than accounts.py/budgets.ts: no
// is_report_currency string-matching needed, since engine's valueAt() only
// ever returns an Amount in exactly `target`'s own commodity when a price
// path exists, and `null` otherwise — checking `row.valuedAmount === null`
// is the direct equivalent of Python's `not is_report_currency(currency)`
// skip.
//
// Every per-posting valuedAmount is rounded to the target commodity's own
// display precision (ledgerFormat.ts's roundToDisplayPrecision) *before*
// being folded into a running total, not just once at the end — Python sums
// values it already got from ledger's own precision-truncated CSV text, so
// summing this engine's exact, untruncated numbers first and rounding only
// the final total can drift by a centavo over many postings (confirmed
// against the real fixtures: a ~2,600-posting analysis differed by exactly
// one centavo without this).
//
// KNOWN, ACCEPTED GAP: register()'s own synthetic "Commodities revalued"
// rows are trackTotal-only (a running-total concept; see register.ts's own
// module header), so they never surface on this per-posting path at all,
// while real ledger's `reg Expenses ... -X` DOES emit them here too. This
// was investigated in depth (not just assumed): for a single-commodity,
// single-checkpoint case it looked tractable as a per-real-account
// generalization of register.ts's own emitRevaluations, but a wider probe
// against the real journal showed it isn't that simple — a broad scope like
// "Expenses" produces dozens of revaluation rows per query (67, for the real
// "Wedding" analysis's date range), including duplicate entries for the same
// date with different values and rows mixing multiple currencies' lot cost
// annotations into one multi-line `display_amount`
// ("-18,301.95846 PHP\n-121.7 SGD\n-636,200 VND\n1,700,000 VND {...} [...]\n..."
// all in a single row). That's evidence of ledger re-deriving this from
// substantially more internal state (per-lot cost bases, xact clearing,
// possibly re-running the valuation pass per matched posting rather than
// once per checkpoint) than a principled generalization can capture without
// reimplementing a meaningful slice of ledger's own valuation engine.
// Left unfixed rather than shipping a partial, unverified approximation — a
// saved analysis spanning one of these events under/overcounts by the
// revaluation delta (confirmed materially: ~₱7,816 on the real "Wedding"
// analysis). Tracked in MOBILE_APP_IMPLEMENTATION.md's risk register as a
// genuine follow-up, not silently masked.

import { type Journal, type PriceIndex, formatLedgerDate, parseLedgerDate, register } from "@ledger/engine";
import { commodityPrecision, roundToDisplayPrecision, wasActuallyConverted } from "./ledgerFormat.js";
import { isExcludedAccount } from "./transactions.js";

export interface AnalysisCategory {
  name: string;
  color_index?: number;
  payees?: string[];
  accounts?: string[];
  hidden?: boolean;
  show_balance?: boolean;
  // Display-only: AnalysisView flips this category's sign after compute.
  negate?: boolean;
  forecast_enabled?: boolean;
  forecast_lookback?: number;
}

function accountMatches(account: string, catAccounts: readonly string[]): boolean {
  return catAccounts.some((a) => account === a || account.startsWith(`${a}:`));
}

function isExpenseAccount(account: string): boolean {
  return account === "Expenses" || account.startsWith("Expenses:");
}

function matchingCategories(payee: string, account: string, categories: readonly AnalysisCategory[]): AnalysisCategory[] {
  return categories.filter((cat) => (cat.payees ?? []).includes(payee) || accountMatches(account, cat.accounts ?? []));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function endExclusive(d: Date): Date {
  return new Date(d.getTime() + 86_400_000);
}

export interface ComputeAnalysisResult {
  categories: { name: string; color_index: number; total: number; payees: string[] }[];
  uncategorized: { total: number; payees: string[] };
  payees: { name: string; total: number }[];
  accounts: { name: string; total: number }[];
}

/** Port of analysis.compute_analysis. */
export function computeAnalysis(
  journal: Journal,
  index: PriceIndex,
  target: string,
  startDate: string | null,
  endDate: string | null,
  categories: readonly AnalysisCategory[],
  excludedAccounts: readonly string[] = [],
): ComputeAnalysisResult {
  const begin = startDate ? (parseLedgerDate(startDate) ?? undefined) : undefined;
  const parsedEnd = endDate ? parseLedgerDate(endDate) : null;
  const end = parsedEnd ? endExclusive(parsedEnd) : undefined;
  const precision = commodityPrecision(journal, target);

  const payeeTotals = new Map<string, number>();
  const accountTotals = new Map<string, number>();
  const catTotals = new Map<string, number>(categories.map((c) => [c.name, 0]));
  const catPayees = new Map<string, Set<string>>(categories.map((c) => [c.name, new Set<string>()]));
  let uncategorizedTotal = 0;
  const uncategorizedPayees = new Set<string>();

  // Expense-side postings drive payee totals, "uncategorized", and
  // payee-based category matching — scoped to Expenses so a payee
  // assignment only ever counts that payee's actual spend, never the paired
  // Asset/Income posting of the same transaction.
  for (const row of register(journal, { accountPattern: /Expenses/i, begin, end, sort: "none", valuation: { index, target, trackTotal: true } })) {
    if (isExcludedAccount(row.account, excludedAccounts) || !row.valuedAmount) continue;
    const value = roundToDisplayPrecision(row.valuedAmount.qty, precision, wasActuallyConverted(row.amount, row.valuedAmount));
    payeeTotals.set(row.payee, (payeeTotals.get(row.payee) ?? 0) + value);
    accountTotals.set(row.account, (accountTotals.get(row.account) ?? 0) + value);
    const matched = matchingCategories(row.payee, row.account, categories);
    if (matched.length > 0) {
      for (const cat of matched) {
        catTotals.set(cat.name, (catTotals.get(cat.name) ?? 0) + value);
        catPayees.get(cat.name)!.add(row.payee);
      }
    } else {
      uncategorizedTotal += value;
      uncategorizedPayees.add(row.payee);
    }
  }
  // Every other account (Assets, Liabilities, Equity, Income) only surfaces
  // when a category explicitly claims that account.
  for (const row of register(journal, { begin, end, sort: "none", valuation: { index, target, trackTotal: true } })) {
    if (isExpenseAccount(row.account) || isExcludedAccount(row.account, excludedAccounts) || !row.valuedAmount) continue;
    const value = roundToDisplayPrecision(row.valuedAmount.qty, precision, wasActuallyConverted(row.amount, row.valuedAmount));
    accountTotals.set(row.account, (accountTotals.get(row.account) ?? 0) + value);
    for (const cat of categories) {
      if (accountMatches(row.account, cat.accounts ?? [])) catTotals.set(cat.name, (catTotals.get(cat.name) ?? 0) + value);
    }
  }
  return {
    categories: categories.map((cat) => ({
      name: cat.name,
      color_index: cat.color_index ?? 0,
      total: round2(catTotals.get(cat.name) ?? 0),
      payees: [...(catPayees.get(cat.name) ?? [])].sort(),
    })),
    uncategorized: { total: round2(uncategorizedTotal), payees: [...uncategorizedPayees].sort() },
    payees: [...payeeTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name, v]) => ({ name, total: round2(v) })),
    accounts: [...accountTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name, v]) => ({ name, total: round2(v) })),
  };
}

function addMonths(d: Date, n: number): Date {
  const total = d.getUTCMonth() + n;
  const y = d.getUTCFullYear() + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return new Date(Date.UTC(y, m, 1));
}

function endOfMonth(d: Date): Date {
  return new Date(addMonths(d, 1).getTime() - 86_400_000);
}

function buildPeriods(minDate: Date, maxDate: Date, granularity: string): [Date, Date][] {
  const periods: [Date, Date][] = [];
  if (granularity === "days") {
    let cur = minDate;
    while (cur.getTime() <= maxDate.getTime()) {
      periods.push([cur, cur]);
      cur = new Date(cur.getTime() + 86_400_000);
    }
  } else if (granularity === "years") {
    let cur = new Date(Date.UTC(minDate.getUTCFullYear(), 0, 1));
    const last = new Date(Date.UTC(maxDate.getUTCFullYear(), 0, 1));
    while (cur.getTime() <= last.getTime()) {
      periods.push([cur, new Date(Date.UTC(cur.getUTCFullYear(), 11, 31))]);
      cur = new Date(Date.UTC(cur.getUTCFullYear() + 1, 0, 1));
    }
  } else {
    let cur = new Date(Date.UTC(minDate.getUTCFullYear(), minDate.getUTCMonth(), 1));
    const last = new Date(Date.UTC(maxDate.getUTCFullYear(), maxDate.getUTCMonth(), 1));
    while (cur.getTime() <= last.getTime()) {
      periods.push([cur, endOfMonth(cur)]);
      cur = addMonths(cur, 1);
    }
  }
  if (periods.length === 0) periods.push([minDate, maxDate]);
  return periods;
}

function bucketKey(d: Date, granularity: string): string {
  if (granularity === "days") return formatLedgerDate(d).replace(/\//g, "-");
  if (granularity === "years") return String(d.getUTCFullYear());
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Port of analysis._forecast_values: projects `horizon` future values by
 * extending the average period-over-period change over the last `lookback`
 * actual values. */
function forecastValues(actualValues: readonly number[], lookback: number, horizon: number): number[] {
  if (horizon <= 0 || actualValues.length === 0) return new Array(Math.max(horizon, 0)).fill(0);
  const window = lookback > 0 ? actualValues.slice(-lookback) : actualValues;
  const lastValue = window[window.length - 1];
  if (window.length < 2) return new Array(horizon).fill(round2(lastValue));
  const diffs: number[] = [];
  for (let i = 1; i < window.length; i++) diffs.push(window[i] - window[i - 1]);
  const avgChange = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return Array.from({ length: horizon }, (_, i) => round2(lastValue + avgChange * (i + 1)));
}

export interface SeriesPeriodOut {
  start: string;
  end: string;
}

export interface ComputeSeriesResult {
  periods: SeriesPeriodOut[];
  categories: { name: string; color_index: number; values: number[] }[];
  uncategorized: { values: number[] };
  forecast: { periods: SeriesPeriodOut[]; categories: { name: string; values: number[] }[] };
}

/** Port of analysis.compute_analysis_series. */
export function computeAnalysisSeries(
  journal: Journal,
  index: PriceIndex,
  target: string,
  startDate: string | null,
  endDate: string | null,
  categories: readonly AnalysisCategory[],
  excludedAccounts: readonly string[] = [],
  granularity = "months",
  forecastEndDate: string | null = null,
): ComputeSeriesResult {
  if (!startDate || !endDate) {
    return {
      periods: [],
      categories: categories.map((c) => ({ name: c.name, color_index: c.color_index ?? 0, values: [] })),
      uncategorized: { values: [] },
      forecast: { periods: [], categories: [] },
    };
  }

  const minDate = parseLedgerDate(startDate);
  const maxDate = parseLedgerDate(endDate);
  if (!minDate || !maxDate) {
    throw new Error(`invalid date range: ${startDate} - ${endDate}`);
  }
  const periods = buildPeriods(minDate, maxDate, granularity);
  const periodCount = periods.length;
  const indexByKey = new Map(periods.map(([s], i) => [bucketKey(s, granularity), i]));
  const precision = commodityPrecision(journal, target);

  const catValues = new Map<string, number[]>(categories.map((c) => [c.name, new Array(periodCount).fill(0)]));
  const uncategorizedValues = new Array(periodCount).fill(0);

  const begin = minDate;
  const end = endExclusive(maxDate);

  for (const row of register(journal, { accountPattern: /Expenses/i, begin, end, sort: "none", valuation: { index, target, trackTotal: true } })) {
    if (isExcludedAccount(row.account, excludedAccounts) || !row.valuedAmount) continue;
    const idx = indexByKey.get(bucketKey(row.date, granularity));
    if (idx === undefined) continue;
    const value = roundToDisplayPrecision(row.valuedAmount.qty, precision, wasActuallyConverted(row.amount, row.valuedAmount));
    const matched = matchingCategories(row.payee, row.account, categories);
    if (matched.length > 0) {
      for (const cat of matched) catValues.get(cat.name)![idx] += value;
    } else {
      uncategorizedValues[idx] += value;
    }
  }
  for (const row of register(journal, { begin, end, sort: "none", valuation: { index, target, trackTotal: true } })) {
    if (isExpenseAccount(row.account) || isExcludedAccount(row.account, excludedAccounts) || !row.valuedAmount) continue;
    const idx = indexByKey.get(bucketKey(row.date, granularity));
    if (idx === undefined) continue;
    const value = roundToDisplayPrecision(row.valuedAmount.qty, precision, wasActuallyConverted(row.amount, row.valuedAmount));
    for (const cat of categories) {
      if (accountMatches(row.account, cat.accounts ?? [])) catValues.get(cat.name)![idx] += value;
    }
  }
  let forecastPeriodsOut: SeriesPeriodOut[] = [];
  let forecastCategoriesOut: { name: string; values: number[] }[] = [];
  if (forecastEndDate && periods.length > 0) {
    const lastPeriodEnd = periods[periods.length - 1][1];
    const forecastEnd = parseLedgerDate(forecastEndDate);
    if (forecastEnd && forecastEnd.getTime() > lastPeriodEnd.getTime()) {
      const forecastPeriods = buildPeriods(new Date(lastPeriodEnd.getTime() + 86_400_000), forecastEnd, granularity);
      const horizon = forecastPeriods.length;
      for (const cat of categories) {
        if (!cat.forecast_enabled) continue;
        const lookback = Math.max(cat.forecast_lookback ?? 6, 1);
        const rawValues = catValues.get(cat.name)!;
        let seriesForForecast: number[];
        if (cat.show_balance) {
          let running = 0;
          seriesForForecast = rawValues.map((v) => (running += v));
        } else {
          seriesForForecast = rawValues;
        }
        forecastCategoriesOut.push({ name: cat.name, values: forecastValues(seriesForForecast, lookback, horizon) });
      }
      forecastPeriodsOut = forecastPeriods.map(([s, e]) => ({ start: formatLedgerDate(s), end: formatLedgerDate(e) }));
    }
  }

  return {
    periods: periods.map(([s, e]) => ({ start: formatLedgerDate(s), end: formatLedgerDate(e) })),
    categories: categories.map((cat) => ({
      name: cat.name,
      color_index: cat.color_index ?? 0,
      values: catValues.get(cat.name)!.map(round2),
    })),
    uncategorized: { values: uncategorizedValues.map(round2) },
    forecast: { periods: forecastPeriodsOut, categories: forecastCategoriesOut },
  };
}
