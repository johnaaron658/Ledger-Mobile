// Journal/Transaction/Posting/Periodic/PricePoint types (§3.1).

import type { Amount } from "./amount.js";

export interface Posting {
  account: string;
  amount: Amount | null; // null = elided, filled in during elision (step 4)
  raw: string; // original posting line text, for round-trip / error messages
}

export interface Transaction {
  date: Date;
  payee: string;
  postings: Posting[];
  begLine: number; // 1-indexed, matches ledger's xact.beg_line
  endLine: number; // 1-indexed, matches ledger's xact.end_line
  raw: string[];
}

export interface Periodic {
  periodText: string;
  postings: Posting[];
  begLine: number;
  endLine: number;
  raw: string[];
}

export interface PricePoint {
  date: Date;
  time?: string;
  commodity: string;
  price: Amount;
  line: number;
  /** The price amount's exact source text (e.g. "1,800,000", comma and all),
   * kept verbatim rather than reformatted from `price.qty` — Phase 2's
   * commodities.ts needs it byte-identical to what prices.py's own regex
   * capture returned as `amount_raw`, which callers echo back unmodified. */
  amountRaw: string;
}

export interface Journal {
  transactions: Transaction[];
  periodics: Periodic[];
  prices: PricePoint[];
  lines: string[];
}

/** Ledger dates carry no timezone — always construct/read them in UTC so a
 * "2024/10/22" round-trips as the same calendar day regardless of host TZ. */
export function ledgerDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

const DATE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;

export function parseLedgerDate(text: string): Date | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  return ledgerDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function formatLedgerDate(d: Date): string {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}
