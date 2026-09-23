// Amount type, arithmetic, parse, format.
//
// Money is never a JS `number` in here (MOBILE_APP_IMPLEMENTATION.md ground
// rule 4) — quantities are scaled bigints, exact under add/subtract/negate.
// `number` only appears at toNumber(), the API-response boundary, mirroring
// the Python side's `round(x, 2)`.

export type Commodity = string; // "₱", "PHP", "USD", "House"

/** units / 10^scale, e.g. 1234.56 -> { units: 123456n, scale: 2 } */
export interface Quantity {
  units: bigint;
  scale: number;
}

export interface Amount {
  qty: Quantity;
  commodity: Commodity;
  lotPrice?: Amount;
}

/** A multi-commodity value, e.g. an account balance holding both PHP and an
 * unconvertible foreign currency at once. */
export type Balance = Map<Commodity, Quantity>;

/** Adds `amount` into `balance` in place, creating the commodity entry if
 * needed. Shared by register.ts, balance.ts, and periodic.ts — anywhere a
 * running multi-commodity total is accumulated. */
export function addToBalance(balance: Balance, amount: Amount): void {
  const existing = balance.get(amount.commodity);
  balance.set(amount.commodity, existing ? addQuantity(existing, amount.qty) : amount.qty);
}

export interface ParsedAmount {
  quantity: Quantity | null;
  currency: string | null;
}

// Ported verbatim from backend/app/transactions.py's AMOUNT_RE.
const AMOUNT_RE = /^(?<prefix>[^\d\-.]*)(?<num>-?[\d,]+\.?\d*)\s*(?<suffix>[A-Za-z]*)$/;

/** Parses an unsigned digit string ("1,234.56") into a Quantity. Exported for
 * reuse by expr.ts's tokenizer, which lexes '-' as its own operator token
 * rather than folding a sign into the leaf number (see expr.ts). */
export function parseQuantity(numStr: string): Quantity | null {
  const cleaned = numStr.replace(/,/g, "");
  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [intPart, fracPart = ""] = unsigned.split(".");
  if (intPart === "" && fracPart === "") return null;
  const scale = fracPart.length;
  const digits = (intPart || "0") + fracPart;
  if (!/^\d+$/.test(digits)) return null;
  let units = BigInt(digits);
  if (negative) units = -units;
  return { units, scale };
}

/** Port of transactions.parse_amount: splits "₱1,234.56" / "-500 AED" into a
 * quantity plus the surrounding currency token (prefix or suffix, whichever
 * is present). Returns { quantity: null, currency: null } on no match, same
 * as the Python version's (None, None). */
export function parseAmount(raw: string): ParsedAmount {
  const m = AMOUNT_RE.exec(raw.trim());
  if (!m || !m.groups) return { quantity: null, currency: null };
  const quantity = parseQuantity(m.groups.num);
  if (quantity === null) return { quantity: null, currency: null };
  const prefix = m.groups.prefix.trim();
  const suffix = m.groups.suffix.trim();
  const currency = prefix || suffix || null;
  return { quantity, currency };
}

/** Port of transactions.is_report_currency: true for the reporting currency,
 * and for amounts with no commodity at all (bare formula results), which are
 * assumed to already be in that currency. `aliases` must already be
 * uppercased (settings.getReportCurrencyAliases()). */
export function isReportCurrency(currency: string | null, aliases: ReadonlySet<string>): boolean {
  if (currency === null) return true;
  return aliases.has(currency.toUpperCase());
}

function alignScale(a: Quantity, b: Quantity): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  const au = a.units * 10n ** BigInt(scale - a.scale);
  const bu = b.units * 10n ** BigInt(scale - b.scale);
  return [au, bu, scale];
}

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  const [au, bu, scale] = alignScale(a, b);
  return { units: au + bu, scale };
}

export function negateQuantity(a: Quantity): Quantity {
  return { units: -a.units, scale: a.scale };
}

export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  const [au, bu] = alignScale(a, b);
  if (au < bu) return -1;
  if (au > bu) return 1;
  return 0;
}

export function isZeroQuantity(a: Quantity): boolean {
  return a.units === 0n;
}

/** Exact — multiplying two finite decimals never needs rounding. */
export function mulQuantity(a: Quantity, b: Quantity): Quantity {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/** Division isn't always exact (/3, /6, /7 repeat), so it's computed to at
 * least `minScale` decimal digits and rounded half-up — matching what
 * expr.ts needs for `(amount/N)` splits. Phase 1's exit criterion only
 * requires final report numbers to agree with ledger to 2dp, and minScale=10
 * leaves ample headroom above that even after several chained divisions. */
export function divQuantity(a: Quantity, b: Quantity, minScale = 10): Quantity {
  if (b.units === 0n) throw new Error("division by zero");
  const scale = Math.max(a.scale, b.scale, minScale);
  const shift = scale + b.scale - a.scale;
  const numerator = shift >= 0 ? a.units * 10n ** BigInt(shift) : a.units / 10n ** BigInt(-shift);
  const negative = numerator < 0n !== b.units < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = b.units < 0n ? -b.units : b.units;
  const rounded = (absNum * 2n + absDen) / (absDen * 2n); // round-half-up
  return { units: negative ? -rounded : rounded, scale };
}

export function scaleQuantity(a: Quantity, factor: number): Quantity {
  // Rescale by a plain-number multiplier (e.g. unit price), rounding to the
  // wider of the two decimal scales; used for lot valuation, not for summing
  // like-commodity postings (which must stay exact, see addQuantity).
  const scale = Math.max(a.scale, 2);
  const value = toNumber(a) * factor;
  return numberToQuantity(value, scale);
}

export function toNumber(q: Quantity): number {
  return Number(q.units) / 10 ** q.scale;
}

export function numberToQuantity(value: number, scale = 2): Quantity {
  const units = BigInt(Math.round(value * 10 ** scale));
  return { units, scale };
}

/** amount ± amount requires equal commodity (engine invariant, not just a
 * Python port — the desktop never adds mismatched commodities either since
 * every arithmetic path there goes through ledger itself). */
export function addAmount(a: Amount, b: Amount): Amount {
  if (a.commodity !== b.commodity) {
    throw new Error(`cannot add mismatched commodities: ${a.commodity} + ${b.commodity}`);
  }
  return { commodity: a.commodity, qty: addQuantity(a.qty, b.qty) };
}

export function negateAmount(a: Amount): Amount {
  return { commodity: a.commodity, qty: negateQuantity(a.qty), lotPrice: a.lotPrice };
}

export function formatQuantity(q: Quantity): string {
  const negative = q.units < 0n;
  const abs = negative ? -q.units : q.units;
  const digits = abs.toString().padStart(q.scale + 1, "0");
  const intPart = q.scale > 0 ? digits.slice(0, -q.scale) : digits;
  const fracPart = q.scale > 0 ? digits.slice(-q.scale) : "";
  const body = q.scale > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${body}` : body;
}
