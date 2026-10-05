// Virtual transactions: planned transactions that haven't happened yet. They
// have a payee and postings but no date, and they are deliberately NOT in
// the journal. Keeping them out of the journal is what guarantees they never
// touch an account balance, budget or register, and keeps the journal a
// plain file real `ledger` reads exactly as before. They live in their own
// config file (virtual_transactions.json), so they travel with the config
// bundle like analyses and automations do.
//
// Analysis is the one place they count, by payee (see analysis.ts). To value
// them with the journal's own prices and commodity styles, they're rendered
// as ordinary blocks dated `asOf` (today), appended to the journal text and
// parsed together. That combined text is never written anywhere.

import { type Journal, type Transaction, formatLedgerDate, parseAmount, parseAndValidate } from "@ledger/engine";
import { type PostingEditIn, appendTransaction, deleteTransaction, renderTransactionBlock, splitKeepEnds } from "./journalEdit.js";
import { deriveCommodityStyles, formatLedgerPostingAmount } from "./ledgerFormat.js";
import type { Storage } from "./store.js";
import type { TransactionPostingOut } from "./transactions.js";

export class VirtualTransactionNotFound extends Error {}

export interface VirtualTransaction {
  id: string;
  payee: string;
  postings: PostingEditIn[];
  updated_at: string;
}

export interface VirtualTransactionOut {
  id: string;
  payee: string;
  /** Same shape as TransactionOut's postings, with an elided amount filled
   * in when the set still balances against the current journal. */
  postings: TransactionPostingOut[];
  updated_at: string;
}

export interface VirtualTransactionIn {
  payee: string;
  postings: PostingEditIn[];
}

function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

async function load(storage: Storage): Promise<{ virtual_transactions: VirtualTransaction[] }> {
  const data = (await storage.readConfig("virtual_transactions")) as { virtual_transactions: VirtualTransaction[] } | null;
  return data ?? { virtual_transactions: [] };
}

async function save(storage: Storage, items: VirtualTransaction[]): Promise<void> {
  await storage.writeConfig("virtual_transactions", { virtual_transactions: items });
}

interface Combined {
  journal: Journal | null;
  /** Parsed transaction for each item, in the same order (null if the
   * combined text didn't parse). */
  txns: (Transaction | null)[];
}

/** Parses `items` as if they were appended to `journalText`, dated `asOf`. */
function parseCombined(journalText: string, items: readonly VirtualTransactionIn[], asOf: Date): Combined {
  if (items.length === 0) return { journal: null, txns: [] };
  const date = formatLedgerDate(asOf);
  let text = journalText;
  if (text !== "" && !text.endsWith("\n")) text += "\n";
  if (text !== "") text += "\n";
  let line = splitKeepEnds(text).length;
  const begLines: number[] = [];
  const blocks: string[] = [];
  for (const item of items) {
    const block = renderTransactionBlock(date, item.payee, item.postings);
    begLines.push(line + 1);
    line += splitKeepEnds(block).length + 1; // + the blank separator line
    blocks.push(block);
  }
  const { journal, result } = parseAndValidate(text + blocks.join("\n"));
  if (!journal || !result.ok) return { journal: null, txns: items.map(() => null) };
  const byLine = new Map(journal.transactions.map((t) => [t.begLine, t]));
  return { journal, txns: begLines.map((l) => byLine.get(l) ?? null) };
}

/** Same check journalEdit.ts runs before any write: a virtual transaction
 * has to balance against the current journal, so posting it later can't
 * fail on anything but a date. */
function validateOrThrow(journalText: string, item: VirtualTransactionIn, asOf: Date): void {
  const block = renderTransactionBlock(formatLedgerDate(asOf), item.payee, item.postings);
  const text = journalText === "" ? block : `${journalText}${journalText.endsWith("\n") ? "" : "\n"}\n${block}`;
  const { result } = parseAndValidate(text);
  if (!result.ok) {
    const detail = result.issues.map((i) => i.message).join("; ");
    throw new Error(`Virtual transaction does not balance: ${detail}`);
  }
}

function cleanPostings(postings: readonly PostingEditIn[]): PostingEditIn[] {
  return postings.map((p) => ({ account: p.account.trim(), amount_raw: (p.amount_raw ?? "").trim() }));
}

export async function listVirtualTransactions(storage: Storage, asOf: Date): Promise<VirtualTransactionOut[]> {
  const { virtual_transactions: items } = await load(storage);
  if (items.length === 0) return [];
  const { journal, txns } = parseCombined((await storage.readJournal()) ?? "", items, asOf);
  const styles = journal ? deriveCommodityStyles(journal) : null;
  return items.map((item, i) => {
    const txn = txns[i];
    const postings = item.postings.map((p, j) => {
      const parsedPosting = txn?.postings[j];
      const amountRaw =
        parsedPosting?.amount && styles ? formatLedgerPostingAmount(parsedPosting.amount, styles, asOf) : (p.amount_raw ?? "");
      const parsed = parseAmount(amountRaw);
      return {
        account: p.account,
        amount_raw: amountRaw,
        value: parsed.quantity ? Number(parsed.quantity.units) / 10 ** parsed.quantity.scale : null,
        currency: parsed.currency,
      };
    });
    return { id: item.id, payee: item.payee, postings, updated_at: item.updated_at };
  });
}

/** The virtual transactions as a Journal of their own (dated `asOf`), for
 * analysis.ts. Returns null when there are none, or when they no longer
 * balance against the journal (only possible if the journal changed under
 * them); analysis then simply leaves them out instead of failing. */
export async function virtualJournal(storage: Storage, journalText: string, asOf: Date): Promise<Journal | null> {
  const { virtual_transactions: items } = await load(storage);
  const { journal, txns } = parseCombined(journalText, items, asOf);
  if (!journal) return null;
  return { ...journal, transactions: txns.filter((t): t is Transaction => t !== null), periodics: [] };
}

export async function addVirtualTransaction(storage: Storage, asOf: Date, input: VirtualTransactionIn): Promise<VirtualTransaction> {
  const item: VirtualTransaction = {
    id: newId(),
    payee: input.payee.trim(),
    postings: cleanPostings(input.postings),
    updated_at: new Date().toISOString(),
  };
  validateOrThrow((await storage.readJournal()) ?? "", item, asOf);
  const data = await load(storage);
  await save(storage, [...data.virtual_transactions, item]);
  return item;
}

export async function editVirtualTransaction(
  storage: Storage,
  asOf: Date,
  id: string,
  input: VirtualTransactionIn,
): Promise<VirtualTransaction> {
  const data = await load(storage);
  const idx = data.virtual_transactions.findIndex((v) => v.id === id);
  if (idx < 0) throw new VirtualTransactionNotFound(id);
  const item: VirtualTransaction = {
    id,
    payee: input.payee.trim(),
    postings: cleanPostings(input.postings),
    updated_at: new Date().toISOString(),
  };
  validateOrThrow((await storage.readJournal()) ?? "", item, asOf);
  const next = [...data.virtual_transactions];
  next[idx] = item;
  await save(storage, next);
  return item;
}

export async function deleteVirtualTransaction(storage: Storage, id: string): Promise<void> {
  const data = await load(storage);
  const next = data.virtual_transactions.filter((v) => v.id !== id);
  if (next.length === data.virtual_transactions.length) throw new VirtualTransactionNotFound(id);
  await save(storage, next);
}

/** Turns a journal transaction into a virtual one: the block leaves the
 * journal (so its postings stop counting) and its payee/postings are kept
 * as a virtual transaction. The journal delete goes first since it's the
 * write that validates. A failure there leaves nothing half-done. */
export async function makeTransactionVirtual(
  storage: Storage,
  asOf: Date,
  loc: { beg_line: number; end_line: number },
  input: VirtualTransactionIn,
): Promise<VirtualTransaction> {
  const item: VirtualTransaction = {
    id: newId(),
    payee: input.payee.trim(),
    postings: cleanPostings(input.postings),
    updated_at: new Date().toISOString(),
  };
  validateOrThrow((await storage.readJournal()) ?? "", item, asOf);
  await deleteTransaction(storage, loc.beg_line, loc.end_line);
  const data = await load(storage);
  await save(storage, [...data.virtual_transactions, item]);
  return item;
}

/** Posts a virtual transaction: appends it to the journal on `date` (with
 * whatever payee/postings the form ended up with), then drops it from the
 * virtual list. Append first, for the same reason as above. */
export async function postVirtualTransaction(
  storage: Storage,
  id: string,
  date: string,
  input: VirtualTransactionIn,
): Promise<{ message: string }> {
  const data = await load(storage);
  if (!data.virtual_transactions.some((v) => v.id === id)) throw new VirtualTransactionNotFound(id);
  const result = await appendTransaction(storage, date, input.payee, input.postings);
  await save(storage, data.virtual_transactions.filter((v) => v.id !== id));
  return result;
}
