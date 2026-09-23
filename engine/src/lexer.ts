// Line classification for parse.ts. One line in, one classification out —
// no lookahead, no state — so parse.ts's block-assembly logic stays simple.

const TXN_HEADER_RE = /^(\d{4}\/\d{1,2}\/\d{1,2})\s+(.*)$/;
const PRICE_RE = /^P\s+(\d{4}\/\d{1,2}\/\d{1,2})(?:\s+(\d{2}:\d{2}:\d{2}))?\s+(.+)$/;

export type Line =
  | { kind: "blank" }
  | { kind: "whitespace" }
  | { kind: "comment" }
  | { kind: "price"; date: string; time?: string; rest: string }
  | { kind: "periodic-header"; periodText: string }
  | { kind: "transaction-header"; date: string; payee: string }
  | { kind: "posting"; text: string }
  | { kind: "unknown" };

export function classifyLine(raw: string): Line {
  const trimmed = raw.trim();
  if (trimmed === "") {
    // A truly empty line ends a block; a whitespace-only line (rare — 3 in
    // the real journal, e.g. a lone tab) does not. Confirmed against
    // ledger's own beg_line/end_line output: such a line is still counted as
    // part of the preceding transaction's extent rather than the separator
    // that ends it.
    return raw.length === 0 ? { kind: "blank" } : { kind: "whitespace" };
  }
  if (trimmed.startsWith(";") || trimmed.startsWith("//")) return { kind: "comment" };

  // Unindented lines start a directive or a transaction header.
  if (!/^\s/.test(raw)) {
    const priceMatch = PRICE_RE.exec(trimmed);
    if (priceMatch) return { kind: "price", date: priceMatch[1], time: priceMatch[2], rest: priceMatch[3] };

    if (trimmed.startsWith("~")) return { kind: "periodic-header", periodText: trimmed.slice(1).trim() };

    const txnMatch = TXN_HEADER_RE.exec(trimmed);
    if (txnMatch) {
      // A header can carry its own trailing "; note" too, e.g. real journal
      // line 907: "2024/11/14 Cong Caphe    ; Phin Filter".
      const payee = txnMatch[2].replace(/\s*;.*$/, "").trim();
      return { kind: "transaction-header", date: txnMatch[1], payee };
    }

    return { kind: "unknown" };
  }

  // Indented, non-blank, non-comment -> a posting belonging to whatever
  // transaction/periodic block is currently open.
  return { kind: "posting", text: trimmed };
}
