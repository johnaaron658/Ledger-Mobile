// Port of backend/app/prices.py, post-consolidation version: reads `P`
// directives straight out of the already-parsed Journal (journal.prices)
// instead of scanning separate `price_histories/*` files — those never
// existed on the engine side to begin with (single-file journal, §3 of
// MOBILE_APP.md), so there's no split-across-files edge case to guard
// against here the way the fixed backend/app/prices.py still has to.

import { formatLedgerDate, type Journal, type PricePoint } from "@ledger/engine";
import { type EditResult, splitKeepEnds, writeAndValidate } from "./journalEdit.js";
import type { Storage } from "./store.js";

export class PriceError extends Error {}

export interface CommodityHistoryEntry {
  date: string;
  time: string | null;
  amount: number;
  amount_raw: string;
  price_commodity: string;
}

export interface CommodityOut {
  commodity: string;
  price_commodity: string;
  latest_amount: number;
  latest_amount_raw: string;
  latest_date: string;
  history: CommodityHistoryEntry[];
}

function sortKey(p: PricePoint): number {
  return p.date.getTime(); // time-of-day beyond a plain date isn't modeled on Date itself, see below
}

/** ledger's own P-directive lines allow an optional HH:MM[:SS] alongside the
 * date; two points on the same calendar day order by that time. `p.date`
 * (via PriceIndex's own construction) doesn't carry time-of-day, so break
 * ties using the raw `time` string directly — lexicographic works since
 * it's always zero-padded "HH:MM[:SS]". */
function sortPoints(points: PricePoint[]): PricePoint[] {
  return [...points].sort((a, b) => sortKey(a) - sortKey(b) || (a.time ?? "").localeCompare(b.time ?? ""));
}

export function listCommodities(journal: Journal): CommodityOut[] {
  const byCommodity = new Map<string, PricePoint[]>();
  for (const p of journal.prices) {
    const list = byCommodity.get(p.commodity);
    if (list) list.push(p);
    else byCommodity.set(p.commodity, [p]);
  }

  const result: CommodityOut[] = [];
  for (const [commodity, points] of byCommodity) {
    const sorted = sortPoints(points);
    const latest = sorted[sorted.length - 1];
    result.push({
      commodity,
      price_commodity: latest.price.commodity,
      latest_amount: Number(latest.price.qty.units) / 10 ** latest.price.qty.scale,
      latest_amount_raw: latest.amountRaw,
      latest_date: formatLedgerDate(latest.date),
      history: [...sorted].reverse().map((p) => ({
        date: formatLedgerDate(p.date),
        time: p.time ?? null,
        amount: Number(p.price.qty.units) / 10 ** p.price.qty.scale,
        amount_raw: p.amountRaw,
        price_commodity: p.price.commodity,
      })),
    });
  }
  // Python's `sorted(..., key=lambda r: r["commodity"].upper())` compares by
  // Unicode codepoint, not locale collation — `localeCompare` would sort a
  // symbol like "₱" differently (collation tables often place symbols before
  // letters; codepoint order puts U+20B1 after every ASCII letter).
  result.sort((a, b) => {
    const ua = a.commodity.toUpperCase();
    const ub = b.commodity.toUpperCase();
    return ua < ub ? -1 : ua > ub ? 1 : 0;
  });
  return result;
}

// Ported verbatim from backend/app/prices.py's P_LINE_RE.
const P_LINE_RE =
  /^P\s+(?<date>\d{4}\/\d{1,2}\/\d{1,2})(?:\s+(?<time>\d{1,2}:\d{2}(?::\d{2})?))?\s+(?<commodity>"[^"]+"|\S+)\s+(?<amount>-?[\d,]+\.?\d*)\s+(?<price_commodity>\S+)\s*$/;

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function slugify(commodity: string): string {
  const slug = commodity
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return slug || "commodity";
}

/** Port of prices.add_price_point (the post-consolidation version, §4 of the
 * implementation plan: splices a new `P` line into the journal directly,
 * rather than into a separate price_histories/*.md file — see
 * backend/app/prices.py's own matching rewrite). */
export async function addPricePoint(
  storage: Storage,
  commodityIn: string,
  dateTextIn: string,
  amountRawIn: string,
  priceCommodityIn: string,
): Promise<EditResult> {
  const commodity = commodityIn.trim();
  const dateText = dateTextIn.trim();
  const amountRaw = amountRawIn.trim();
  const priceCommodity = priceCommodityIn.trim();
  if (!commodity) throw new PriceError("Commodity is required.");
  if (!/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(dateText)) throw new PriceError("Date must be in YYYY/MM/DD format.");
  if (!/^-?[\d,]+\.?\d*$/.test(amountRaw)) throw new PriceError("Amount must be numeric.");
  if (!priceCommodity) throw new PriceError("Price commodity is required.");

  const commodityToken = /\s/.test(commodity) ? `"${commodity}"` : commodity;
  const newLine = `P ${dateText} 00:00:00 ${commodityToken} ${amountRaw} ${priceCommodity}\n`;

  const original = (await storage.readJournal()) ?? "";
  const lines = splitKeepEnds(original);

  const existingLines = lines
    .map((line, i) => ({ i, m: P_LINE_RE.exec(line.trim()) }))
    .filter((x) => x.m && stripQuotes(x.m.groups!.commodity) === commodity)
    .map((x) => x.i);

  let updatedLines: string[];
  if (existingLines.length > 0) {
    const insertAt = existingLines[existingLines.length - 1] + 1;
    updatedLines = [...lines.slice(0, insertAt), newLine, ...lines.slice(insertAt)];
  } else {
    const idx = lines.findIndex((line) => {
      const t = line.trim();
      return t !== "" && !t.startsWith("//") && !P_LINE_RE.test(t);
    });
    const insertAt = idx === -1 ? lines.length : idx;
    const header = `// ---- begin ./price_histories/${slugify(commodity)}.md ----\n`;
    updatedLines = [...lines.slice(0, insertAt), header, newLine, "\n", ...lines.slice(insertAt)];
  }

  const message = `dashboard: price ${commodity} ${dateText} = ${amountRaw} ${priceCommodity}`;
  await writeAndValidate(storage, updatedLines.join(""), message);
  return { message };
}

/** Port of prices.delete_commodity. */
export async function deleteCommodity(storage: Storage, commodityIn: string): Promise<EditResult> {
  const commodity = commodityIn.trim();
  if (!commodity) throw new PriceError("Commodity is required.");

  const original = (await storage.readJournal()) ?? "";
  const lines = splitKeepEnds(original);
  const removeLineIdx = new Set<number>();
  lines.forEach((line, i) => {
    const m = P_LINE_RE.exec(line.trim());
    if (m && stripQuotes(m.groups!.commodity) === commodity) removeLineIdx.add(i);
  });
  if (removeLineIdx.size === 0) throw new PriceError(`No price history found for "${commodity}".`);

  const updated = lines.filter((_, i) => !removeLineIdx.has(i)).join("");
  const message = `dashboard: delete commodity ${commodity}`;
  await writeAndValidate(storage, updated, message);
  return { message };
}
