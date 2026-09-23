// Port of backend/app/transactions.py.

import { type Journal, formatLedgerDate, parseAmount } from "@ledger/engine";
import { deriveCommodityStyles, formatLedgerPostingAmount } from "./ledgerFormat.js";

export interface TransactionPostingOut {
  account: string;
  amount_raw: string;
  value: number | null;
  currency: string | null;
}

export interface TransactionOut {
  date: string;
  payee: string;
  file: string;
  beg_line: number;
  end_line: number;
  postings: TransactionPostingOut[];
}

/** Port of transactions.list_transactions. The Python original gets
 * `amount_raw` for free from ledger's own `%(quoted(amount))` CSV output,
 * then re-parses that rendered text back into `(value, currency)` with its
 * own regex — including the cases where the full string doesn't match (a
 * lot/price-annotated posting like "2,500,000 VND {0.002334304 PHP}
 * [2024/11/13]" is NOT a bare `<prefix><num><suffix>`, so Python's own
 * parse_amount returns `(None, None)` for it too). This mirrors that exactly: render the text
 * first (ledgerFormat.ts), then re-derive value/currency from that same
 * text via engine's parseAmount, rather than reading them off the
 * already-parsed Amount directly — the two field pairs are allowed to (and
 * for lots, do) disagree, same as upstream. */
export function listTransactions(journal: Journal, journalPath: string): TransactionOut[] {
  const styles = deriveCommodityStyles(journal);
  // `reg` hides a transaction whose every posting nets to zero by default,
  // same as register.ts's own documented `--empty` behavior — confirmed
  // against the real journal: a "₱0" starting-balance posting (and its
  // equally-zero elided counterpart) never appears in ledger's own output.
  const nonZero = journal.transactions.filter((txn) => txn.postings.some((p) => p.amount && p.amount.qty.units !== 0n));
  // `reg --sort date` — a stable sort, so same-day transactions keep their
  // original document order (matches register.ts's own sort convention).
  const sorted = [...nonZero].sort((a, b) => a.date.getTime() - b.date.getTime());
  return sorted.map((txn) => ({
    date: formatLedgerDate(txn.date),
    payee: txn.payee,
    file: journalPath,
    beg_line: txn.begLine,
    end_line: txn.endLine,
    postings: txn.postings.map((p) => {
      const amountRaw = p.amount ? formatLedgerPostingAmount(p.amount, styles, txn.date) : "";
      const parsed = parseAmount(amountRaw);
      return {
        account: p.account,
        amount_raw: amountRaw,
        value: parsed.quantity ? Number(parsed.quantity.units) / 10 ** parsed.quantity.scale : null,
        currency: parsed.currency,
      };
    }),
  }));
}

/** Port of transactions.is_excluded_account. */
export function isExcludedAccount(account: string, excludedAccounts: readonly string[]): boolean {
  return excludedAccounts.some((ex) => account === ex || account.startsWith(`${ex}:`));
}
