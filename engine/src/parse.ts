// Text -> Journal model (§3.2 step 3).
//
// Amount resolution (plain literal / `( ... )` expression / `N Commodity @
// price` lot) lives here too, even though lots are officially step 5 — the
// lot-vs-plain-vs-expression distinction is pure grammar (which the doc's
// build order agrees belongs to "parse"), while what step 5 actually adds is
// how *reports* use `lotPrice` for valuation. Elision (step 4, filling in the
// null amount on a fully-elided posting) is deliberately NOT done here — it
// needs every other posting resolved first and is validate.ts's job.

import { type Amount, negateQuantity, parseAmount } from "./amount.js";
import { evaluateExpr, valueToAmount } from "./expr.js";
import {
  type Journal,
  type Periodic,
  type Posting,
  type PricePoint,
  type Transaction,
  parseLedgerDate,
} from "./journal.js";
import { type Line, classifyLine } from "./lexer.js";

export class ParseError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(`line ${line}: ${message}`);
  }
}

function parsePlainAmount(text: string, line: number): Amount {
  const direct = parseAmount(text);
  if (direct.quantity !== null && direct.currency !== null) {
    return { commodity: direct.currency, qty: direct.quantity };
  }
  // amount.ts's AMOUNT_RE is a verbatim port of ledger's own *output* format,
  // where a negative always reads "<prefix>-<digits>" (e.g. "₱-1,661,024.59"
  // — see amount.spec.ts). Raw source text is looser and occasionally writes
  // the sign first instead ("-₱1661024.59", confirmed against the real
  // journal via the parse.ts/golden-fixture crosscheck) — a source-grammar
  // quirk, not something that belongs in the ledger-output-oriented regex.
  if (text.startsWith("-")) {
    const retry = parseAmount(text.slice(1));
    if (retry.quantity !== null && retry.currency !== null) {
      return { commodity: retry.currency, qty: negateQuantity(retry.quantity) };
    }
  }
  throw new ParseError(`cannot parse amount ${JSON.stringify(text)}`, line);
}

const LOT_RE = /^(.*?)\s@\s(.*)$/;

function parseAmountField(text: string, line: number): Amount {
  const trimmed = text.trim();
  if (trimmed.startsWith("(")) {
    try {
      return valueToAmount(evaluateExpr(trimmed));
    } catch (e) {
      throw new ParseError(`${(e as Error).message}`, line);
    }
  }
  const lotMatch = LOT_RE.exec(trimmed);
  if (lotMatch) {
    const qtyAmount = parsePlainAmount(lotMatch[1].trim(), line);
    const lotPrice = parsePlainAmount(lotMatch[2].trim(), line);
    return { ...qtyAmount, lotPrice };
  }
  return parsePlainAmount(trimmed, line);
}

function buildPosting(text: string, line: number): Posting {
  const noComment = text.replace(/\s*;.*$/, "");
  const parts = noComment.split(/\s{2,}/).filter((p) => p.length > 0);
  const account = (parts[0] ?? "").trim();
  const amountText = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
  const amount = amountText ? parseAmountField(amountText, line) : null;
  return { account, amount, raw: text };
}

interface BlockLine {
  index: number; // 0-indexed into `lines`
  text: string;
}

function consumeBlock(lines: string[], headerIndex: number): { block: BlockLine[]; lastContentIndex: number; nextIndex: number } {
  const block: BlockLine[] = [];
  let lastContentIndex = headerIndex;
  let i = headerIndex + 1;
  while (i < lines.length) {
    const cls = classifyLine(lines[i]);
    if (cls.kind === "posting") {
      block.push({ index: i, text: cls.text });
      lastContentIndex = i;
      i++;
      continue;
    }
    if (cls.kind === "comment" || cls.kind === "whitespace") {
      // Neither ends the block (see lexer.ts on "whitespace"), but a
      // trailing one still extends the transaction's line range to match
      // ledger's own end_line.
      lastContentIndex = i;
      i++;
      continue;
    }
    break; // a truly blank line, or a new header/price/unknown line -> block ends
  }
  return { block, lastContentIndex, nextIndex: i };
}

function parsePricePoint(cls: Extract<Line, { kind: "price" }>, line: number): PricePoint {
  const date = parseLedgerDate(cls.date);
  if (!date) throw new ParseError(`invalid price date ${JSON.stringify(cls.date)}`, line);
  const spaceIdx = cls.rest.indexOf(" ");
  if (spaceIdx === -1) throw new ParseError(`malformed price directive: ${JSON.stringify(cls.rest)}`, line);
  const commodity = cls.rest.slice(0, spaceIdx);
  const amountText = cls.rest.slice(spaceIdx + 1).trim();
  const price = parsePlainAmount(amountText, line);
  // amountText is "<amount> <price-commodity>" (e.g. "1,800,000 PHP");
  // amountRaw is just the numeric portion ledger's own P_LINE_RE would
  // capture, i.e. everything up to the next whitespace.
  const amountRaw = amountText.split(/\s+/)[0] ?? amountText;
  return { date, time: cls.time, commodity, price, line, amountRaw };
}

export function parseJournal(text: string): Journal {
  const lines = text.split(/\r?\n/);
  const journal: Journal = { transactions: [], periodics: [], prices: [], lines };

  let i = 0;
  while (i < lines.length) {
    const cls = classifyLine(lines[i]);
    const lineNo = i + 1;

    if (cls.kind === "blank" || cls.kind === "whitespace" || cls.kind === "comment" || cls.kind === "unknown" || cls.kind === "posting") {
      // A stray posting with no open header above it is malformed input;
      // ledger would also refuse it, so we just skip rather than crash the
      // whole parse over one bad line.
      i++;
      continue;
    }

    if (cls.kind === "price") {
      journal.prices.push(parsePricePoint(cls, lineNo));
      i++;
      continue;
    }

    const { block, lastContentIndex, nextIndex } = consumeBlock(lines, i);
    const begLine = lineNo;
    const endLine = lastContentIndex + 1;
    const postings = block.map((b) => buildPosting(b.text, b.index + 1));
    const raw = lines.slice(begLine - 1, endLine);

    if (cls.kind === "transaction-header") {
      const date = parseLedgerDate(cls.date);
      if (!date) throw new ParseError(`invalid date ${JSON.stringify(cls.date)}`, begLine);
      journal.transactions.push({ date, payee: cls.payee, postings, begLine, endLine, raw } satisfies Transaction);
    } else {
      journal.periodics.push({ periodText: cls.periodText, postings, begLine, endLine, raw } satisfies Periodic);
    }
    i = nextIndex;
  }

  return journal;
}
