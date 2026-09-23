// Elision (§3.2 step 4) + validate.ts's balance check, written together per
// the build order — filling in a fully-elided posting *is* the balance
// check: both walk the same per-commodity sums.
//
// Reproduces `ledger bal`'s failure condition only: every transaction
// balances to zero per commodity after elision, and no more than one elided
// posting. Amount-expression and parse errors surface as the same failure
// (see parseAndValidate).

import { type Amount, type Quantity, addQuantity, isZeroQuantity, mulQuantity, negateQuantity } from "./amount.js";
import type { Journal, Periodic, Posting, Transaction } from "./journal.js";
import { ParseError, parseJournal } from "./parse.js";

export interface ValidationIssue {
  message: string;
  begLine?: number;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** The Amount a posting contributes to its block's balance check. A lot
 * posting ("1 House @ 1800000 PHP") balances against its *cost*
 * (qty * lotPrice), not its own commodity — confirmed against the real
 * journal's golden fixture: the elided posting opposite a House lot resolves
 * to -1,800,000 PHP, not -1 House. Balance *reports* (accountsView.ts, later)
 * are what show the account's holding in the lot's own commodity instead. */
function balanceContribution(amount: Amount): Amount {
  if (!amount.lotPrice) return amount;
  return { commodity: amount.lotPrice.commodity, qty: mulQuantity(amount.qty, amount.lotPrice.qty) };
}

function sumByCommodity(postings: Posting[]): Map<string, Quantity> {
  const sums = new Map<string, Quantity>();
  for (const p of postings) {
    if (p.amount === null) continue;
    const c = balanceContribution(p.amount);
    const existing = sums.get(c.commodity);
    sums.set(c.commodity, existing ? addQuantity(existing, c.qty) : c.qty);
  }
  return sums;
}

/** Elides a block's postings in place (fills the one amount-less posting, if
 * any, with the negated remainder) and returns an error message if the block
 * doesn't validly balance — more than one elided posting, or a remainder
 * left in more than one commodity, since a single elided posting can only
 * cancel one. */
function elidePostings(postings: Posting[]): string | null {
  const elided = postings.filter((p) => p.amount === null);
  if (elided.length > 1) {
    return `more than one amount-less posting (${elided.length})`;
  }

  const sums = sumByCommodity(postings);
  const nonZero = [...sums.entries()].filter(([, qty]) => !isZeroQuantity(qty));

  if (elided.length === 0) {
    if (nonZero.length > 0) {
      return `does not balance (${nonZero.map(([c]) => c).join(", ")})`;
    }
    return null;
  }

  if (nonZero.length > 1) {
    return `non-cancelling remainder in more than one commodity (${nonZero.map(([c]) => c).join(", ")})`;
  }

  let commodity: string;
  let qty: Quantity;
  if (nonZero.length === 1) {
    [commodity, qty] = nonZero[0];
  } else {
    // Everything already balances without the elided posting — it still
    // needs *some* commodity, so borrow the first real posting's.
    commodity = postings.find((p) => p.amount !== null)?.amount?.commodity ?? "";
    qty = { units: 0n, scale: 0 };
  }
  elided[0].amount = { commodity, qty: negateQuantity(qty) };
  return null;
}

function elideBlock(block: Transaction | Periodic): ValidationIssue | null {
  const message = elidePostings(block.postings);
  return message ? { message, begLine: block.begLine } : null;
}

/** Elides every transaction and periodic in the journal in place, returning
 * every block that fails to balance. */
export function elideAndValidateJournal(journal: Journal): ValidationResult {
  const issues: ValidationIssue[] = [];
  for (const txn of journal.transactions) {
    const issue = elideBlock(txn);
    if (issue) issues.push(issue);
  }
  for (const periodic of journal.periodics) {
    const issue = elideBlock(periodic);
    if (issue) issues.push(issue);
  }
  return { ok: issues.length === 0, issues };
}

/** Parses and validates in one step, exactly the check `_write_and_validate`
 * runs before persisting an edit (journalEdit.ts, Phase 2) and what §5.4's
 * first-run import runs before accepting a picked file. A parse error (bad
 * syntax, an unevaluable expression) surfaces as the same kind of issue as a
 * balance failure — both mean "don't write this text". */
export function parseAndValidate(text: string): { journal: Journal | null; result: ValidationResult } {
  let journal: Journal;
  try {
    journal = parseJournal(text);
  } catch (e) {
    const issue: ValidationIssue = { message: e instanceof Error ? e.message : String(e), begLine: e instanceof ParseError ? e.line : undefined };
    return { journal: null, result: { ok: false, issues: [issue] } };
  }
  return { journal, result: elideAndValidateJournal(journal) };
}
