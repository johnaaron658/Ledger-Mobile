// Port of backend/app/accounts.py.
//
// build_account_tree's tree-rollup logic below is the FIXED version of a
// real desktop bug found during Phase 1 (see @ledger/engine's balance.ts
// header): `bal --flat` rows are already the full rolled-up total of
// themselves plus every descendant, so a node that has its own row must NOT
// also sum its children on top — only a pure organizational node (no row of
// its own) needs its total built *from* children. backend/app/accounts.py
// carries the same fix (ground rule 2: fix a genuine desktop bug in both
// places).
//
// `other_balances`/`amount_raw`-style text fields are reconstructed via
// ledgerFormat.ts rather than by string-matching commodity aliases the way
// accounts.py's `is_report_currency` does: engine's valueBalance() already
// converts every commodity that has a price path into the target commodity
// and leaves only genuinely path-less ones native (validated against the
// real fixtures in Phase 1), which is a strictly more principled version of
// the same "convert what you can, leave the rest" rule.

import {
  type Journal,
  type PriceIndex,
  balance,
  formatLedgerDate,
  parseAmount,
  register,
  toNumber,
} from "@ledger/engine";
import { commodityPrecision, deriveCommodityStyles, formatLedgerAmount, roundQuantityToPrecision, wasActuallyConverted } from "./ledgerFormat.js";

export interface OtherBalanceOut {
  raw: string;
  value: number | null;
  currency: string | null;
}

export interface AccountNodeOut {
  name: string;
  full_name: string;
  balance_php: number;
  other_balances: OtherBalanceOut[];
  children: AccountNodeOut[];
}

interface AccountNode {
  name: string;
  fullName: string;
  balancePhp: number;
  hasOwnRow: boolean;
  otherBalances: OtherBalanceOut[];
  children: Map<string, AccountNode>;
}

function newNode(name: string, fullName: string): AccountNode {
  return { name, fullName, balancePhp: 0, hasOwnRow: false, otherBalances: [], children: new Map() };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toOut(node: AccountNode): AccountNodeOut {
  return {
    name: node.name,
    full_name: node.fullName,
    balance_php: round2(node.balancePhp),
    other_balances: node.otherBalances,
    children: [...node.children.values()].map(toOut),
  };
}

export function buildAccountTree(journal: Journal, index: PriceIndex, target: string, asOf: Date): { children: AccountNodeOut[] } {
  const styles = deriveCommodityStyles(journal);
  const rows = balance(journal, { valuation: { index, target, asOf } });
  const root = newNode("", "");

  for (const row of rows) {
    const parts = row.account.split(":");
    let node = root;
    const path: string[] = [];
    for (const part of parts) {
      path.push(part);
      let child = node.children.get(part);
      if (!child) {
        child = newNode(part, path.join(":"));
        node.children.set(part, child);
      }
      node = child;
    }
    node.balancePhp += toNumber(row.balance.get(target) ?? { units: 0n, scale: 0 });
    node.hasOwnRow = true;
    for (const [commodity, qty] of row.balance) {
      if (commodity === target) continue;
      const raw = formatLedgerAmount(commodity, qty, styles);
      const parsed = parseAmount(raw);
      node.otherBalances.push({
        raw,
        value: parsed.quantity ? toNumber(parsed.quantity) : null,
        currency: parsed.currency,
      });
    }
  }

  function propagate(node: AccountNode): number {
    if (node.hasOwnRow) {
      for (const child of node.children.values()) propagate(child);
      return node.balancePhp;
    }
    let total = 0;
    for (const child of node.children.values()) total += propagate(child);
    node.balancePhp = total;
    return total;
  }
  for (const child of root.children.values()) propagate(child);

  return { children: [...root.children.values()].map(toOut) };
}

/** Port of accounts.list_account_names: every account with at least one
 * direct posting in a real transaction, regardless of whether its net is
 * zero — confirmed against the real fixture to be a *superset* of
 * `bal --flat`'s own rows (which hide a zero net by default) and to exclude
 * periodic-only budget accounts, which never post a real transaction. */
export function listAccountNames(journal: Journal): string[] {
  const names = new Set<string>();
  for (const txn of journal.transactions) {
    for (const posting of txn.postings) names.add(posting.account);
  }
  return [...names].sort();
}

export interface AccountHistoryRow {
  date: string;
  payee: string;
  running_balance: number;
  file: string;
  beg_line: number;
  end_line: number;
}

const zeroQty = { units: 0n, scale: 0 };

/** Port of accounts.account_history. `account` is used as ledger's own
 * positional `reg` argument would be: an unanchored, case-sensitive-in-form
 * but here case-insensitive substring/regex match (see register.ts's own
 * accountPattern contract), not an exact-match filter — this is what makes
 * querying "Expenses:Subscriptions" also return its children's postings.
 *
 * ledger's own `display_total` isn't simply "the exact running native
 * balance, valued and rounded" at every row: it visibly *compounds*
 * rounding — each row's shown total is (previous shown total) + (this
 * row's own valued amount, ALSO independently rounded to display
 * precision), not a fresh valuation of the exact native balance. Real
 * example, traced by hand against the raw `ledger reg` output for
 * Expenses:Currency:AED: after a 1200-AED holding is valued at
 * 15.7649565217 (exact: 18917.94782604 -> rounds to "18917.94783"), the NEXT
 * posting's compounded total ("18917.94783" + its own rounded delta
 * "11035.46957" = "29953.41740") disagrees with the mathematically fresh
 * total (round(1900 * 15.7649565217, 5) = "29953.41739") by exactly
 * 0.00001 — and ledger inserts a synthetic same-payee, same-beg_line
 * correction row for precisely that difference before the real row,
 * pulling the running total back in line. Confirmed against all 4
 * occurrences in the real journal (two more, ±0.00001 each way); this is a
 * deterministic reconciliation, not noise, so it's reproduced here as a
 * post-processing pass over the engine's own exact runningTotal sequence
 * (kept out of register.ts itself — rounding to display precision is a
 * core-layer, ground-rule-4 concern, not something @ledger/engine does). */
export function accountHistory(journal: Journal, index: PriceIndex, target: string, account: string, journalPath: string): AccountHistoryRow[] {
  const precision = commodityPrecision(journal, target);
  const rows = register(journal, {
    accountPattern: new RegExp(account, "i"),
    valuation: { index, target, trackTotal: true },
  });

  const result: AccountHistoryRow[] = [];
  let displayedTotal: { units: bigint; scale: number } | null = null;

  for (const r of rows) {
    const freshTotal = roundQuantityToPrecision(r.runningTotal?.get(target) ?? zeroQty, precision);
    const file = r.file === null ? "" : journalPath;

    // register.ts's emitRevaluations only skips a checkpoint whose *exact*
    // native-precision delta is zero (ground rule 4 — the engine stays
    // unaware of display precision). A checkpoint can still have a nonzero
    // raw delta that's entirely below the display precision, so its rounded
    // total doesn't visibly move — and ledger's own reg output has no row
    // for that case at all. Confirmed against the real journal:
    // Assets:Checking:Recievables:Claire has a 2024/11/18 revaluation with a
    // nonzero raw delta but a rounded total identical to the prior row;
    // emitting it here produced an extra row with no real counterpart,
    // shifting every subsequent row by one.
    if (r.isRevaluation && displayedTotal !== null && freshTotal.units === displayedTotal.units) {
      continue;
    }

    // A genuine "Commodities revalued" checkpoint (register.ts's own
    // emitRevaluations) is already the exact reconciliation for a price
    // change — it never needs (or gets) a compounding-rounding correction
    // of its own; only a REAL posting row can drift from the fresh total
    // and need one. Confirmed against the real journal: inserting a
    // correction ahead of a revaluation row produces a wrong intermediate
    // value no fixture shows.
    if (displayedTotal !== null && !r.isRevaluation) {
      const ownRoundedDelta = roundQuantityToPrecision(r.valuedAmount?.qty ?? zeroQty, precision, wasActuallyConverted(r.amount, r.valuedAmount));
      const naiveUnits = displayedTotal.units + ownRoundedDelta.units;
      const correctionUnits = freshTotal.units - naiveUnits;
      if (correctionUnits !== 0n) {
        const corrected = { units: displayedTotal.units + correctionUnits, scale: precision };
        result.push({
          date: formatLedgerDate(r.date),
          payee: r.payee,
          running_balance: Number(corrected.units) / 10 ** precision,
          file,
          beg_line: r.begLine,
          end_line: r.endLine,
        });
        displayedTotal = corrected;
      }
    }

    result.push({
      date: formatLedgerDate(r.date),
      payee: r.payee,
      running_balance: Number(freshTotal.units) / 10 ** precision,
      file,
      beg_line: r.begLine,
      end_line: r.endLine,
    });
    displayedTotal = freshTotal;
  }

  return result;
}
