// Reconstructs ledger's own per-commodity amount rendering (symbol
// placement, comma-grouping, decimal precision) from the journal that
// establishes it. @ledger/engine parses journal text into structured
// Amounts but never needs to re-print them; several backend/app/*.py ports
// need exactly that, because their Python originals got this text for free
// from ledger's own CSV output (`%(quoted(amount))`, `%(quoted(join(...)))`)
// instead of ever formatting a number themselves:
//   - transactions.py's `amount_raw` (every posting, incl. one ledger fills
//     in itself on elision — there is no "original text" to fall back to)
//   - accounts.py's `other_balances[].raw` (a held non-report-currency
//     balance, shown verbatim rather than converted)
//
// Ledger's real algorithm learns each commodity's display style from EVERY
// occurrence in the file, widening precision (and turning comma-grouping on)
// as it goes, never narrowing. Since the whole file is parsed before any
// query runs, that's equivalent to computing the max/first over the whole
// journal up front — confirmed empirically against the real fixture: a
// plain "₱100.00" posting prints as "₱100.00000" because *some* other ₱/PHP
// amount elsewhere in the journal needed 5 decimal places (a division
// split), while AED — whose amounts never exceed 2 decimals or need commas
// anywhere in the file — always prints at exactly 2, ungrouped, even at 4
// digits ("AED1100.00", not "AED1,100.00").
//
// Any `@ price`-annotated posting's `amount` gets converted to `{price}
// [date]` cost-basis notation when re-printed — not just the one House lot
// purchase; the real journal's VND/KRW/USD currency-conversion postings
// ("2,500,000 VND @ 0.002334304 PHP") get the same treatment, confirmed
// against the real fixture. See formatLedgerPostingAmount below.

import { type Amount, type Journal, type Quantity, formatLedgerDate, toNumber } from "@ledger/engine";

export interface CommodityStyle {
  precision: number;
  commas: boolean;
  prefix: string; // exact text observed before the number, e.g. "₱", "AED", ""
  suffix: string; // exact text observed after the number, e.g. " PHP", ""
}

const TEMPLATE_RE = /^(?<prefix>[^\d-]*)-?(?<num>[\d,]+\.?\d*)(?<suffix>.*)$/;
const TRIVIAL_PAREN_RE = /^\(\s*(-?[^()+*/]+?)\s*\)$/;

/** The amount-field substring of a posting's original source line, mirroring
 * parse.ts's buildPosting split — needed here too since Posting doesn't
 * retain it separately, only the whole-line `raw`. */
function amountText(raw: string): string | null {
  const noComment = raw.replace(/\s*;.*$/, "");
  const parts = noComment.split(/\s{2,}/).filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  return parts.slice(1).join(" ").trim();
}

/** A parenthesized amount with no actual operator inside ("(JPY 14000)") is
 * just a plain amount some ledger users write redundantly wrapped — real
 * ledger still learns JPY's style/precision from it (confirmed against the
 * real journal: JPY only ever appears this way, never bare, and still
 * prints "JPY 14000" / "JPY -14000", not a fallback-styled default). A
 * genuine computation ("(JPY 14000/7)") is excluded, same as before — its
 * result is derived, not written. */
function unwrapTrivialParens(text: string): string | null {
  const m = TRIVIAL_PAREN_RE.exec(text);
  return m ? m[1] : null;
}

export function deriveCommodityStyles(journal: Journal): Map<string, CommodityStyle> {
  const styles = new Map<string, CommodityStyle>();

  function widen(commodity: string, scale: number): void {
    const s = styles.get(commodity);
    if (s) s.precision = Math.max(s.precision, scale);
    else styles.set(commodity, { precision: scale, commas: false, prefix: "", suffix: "" });
  }

  // Widens from the DIGIT STRING's own decimal count, never from
  // `Amount.qty.scale` directly — expr.ts's divQuantity pads every division
  // result to at least 10 fractional digits for arithmetic exactness
  // (ground rule 4), which is an internal precision buffer, not something
  // ledger ever displayed or would widen a commodity's precision to. Only
  // text ledger itself actually rendered/wrote can teach a display
  // precision; an elided posting's computed remainder can't either, for the
  // same reason. Learning "10+ decimals" from either would be a bug in this
  // formatter, not a fact about the real journal (confirmed: it produced
  // amounts like "1,661,024.5900000000" against a real fixture reading
  // "1,661,024.59000").
  function widenFromText(commodity: string, numText: string): void {
    const dot = numText.indexOf(".");
    widen(commodity, dot === -1 ? 0 : numText.length - dot - 1);
  }

  function learn(commodity: string, raw: string): void {
    const m = TEMPLATE_RE.exec(raw.trim());
    if (!m || !m.groups) return;
    widenFromText(commodity, m.groups.num);
    const s = styles.get(commodity)!;
    if (m.groups.num.includes(",")) s.commas = true;
    if (!s.prefix && !s.suffix) {
      s.prefix = m.groups.prefix;
      s.suffix = m.groups.suffix;
    }
  }

  for (const block of [...journal.transactions, ...journal.periodics]) {
    for (const posting of block.postings) {
      if (!posting.amount) continue;
      if (posting.amount.lotPrice) {
        // The lot's own quantity ("1 House", "USD90.00") is a literal,
        // never-computed amount, so it's safe to teach BOTH precision and
        // style from — confirmed necessary, not just safe: USD appears
        // exactly once in the whole real journal, as a lot base ("USD90.00 @
        // 57.9080 PHP"), and ledger still renders every USD amount using
        // that one occurrence's own prefix convention, so a lot base that
        // never learn()s would leave USD (and any commodity that ONLY ever
        // appears as a lot base) stuck on the bare fallback style below. The
        // lotPrice side is different: it's a per-unit *price* annotation,
        // not a plain amount, and ledger keeps those at their own literal
        // precision regardless of the priced commodity's registered display
        // precision — confirmed against the real journal, where a price
        // annotation of "0.0404945666666667 PHP" (16 decimals) coexists with
        // PHP's own amount precision staying at 5 everywhere else. Learning
        // from it here would wrongly inflate every plain PHP amount to 16
        // decimals too.
        const text = amountText(posting.raw);
        const baseMatch = text ? /^(.*?)\s*@/.exec(text) : null;
        if (baseMatch) learn(posting.amount.commodity, baseMatch[1]);
        else widen(posting.amount.commodity, posting.amount.qty.scale);
        continue;
      }
      const text = amountText(posting.raw);
      if (!text) continue;
      if (text.startsWith("(")) {
        const trivial = unwrapTrivialParens(text);
        if (trivial) learn(posting.amount.commodity, trivial);
        continue; // a genuine computation doesn't teach precision or plain style
      }
      learn(posting.amount.commodity, text);
    }
  }
  // Deliberately NOT widening from journal.prices: a `P` directive's price
  // value is a price annotation too (its price_commodity is almost always
  // the reporting currency, e.g. "P ... AED 15.85 PHP"), subject to the same
  // exclusion as a lot's `@ price` above — confirmed against the real
  // journal, where a KRW price of "0.0404945666666667 PHP" (16 decimals)
  // would otherwise leak into every plain PHP amount's precision too. PHP
  // does still get its own correct style (precision 5, commas, " PHP"
  // suffix) from this same widen()/learn() pass — it appears as a literal
  // plain posting amount plenty of times in the real journal ("550 PHP",
  // "360,000 PHP", ...), just never as a `@`/`P`-directive price target.

  return styles;
}

/** A single commodity's own display precision, e.g. PHP's — see
 * roundToDisplayPrecision below for why callers need this. */
export function commodityPrecision(journal: Journal, commodity: string, styles?: ReadonlyMap<string, CommodityStyle>): number {
  return (styles ?? deriveCommodityStyles(journal)).get(commodity)?.precision ?? 2;
}

/** Divides `abs` by `divisor`, rounding half-to-even (banker's rounding) —
 * confirmed against the real journal: "(₱5,655.38165/2)" is EXACTLY
 * 2827.690825, a genuine tie at the 6th decimal when narrowing to PHP's
 * 5-decimal precision, and ledger renders "2827.69082" (rounds down, since
 * the preceding digit 2 is already even), not "...69083" (plain
 * round-half-up's answer). Every OTHER narrowing case in the real journal
 * happens not to land on an exact tie, so this only ever changes behavior
 * at one specific transaction pair — but round-half-up was simply wrong
 * for it, not an accepted approximation. */
function divideRoundHalfEven(abs: bigint, divisor: bigint): bigint {
  const quotient = abs / divisor;
  const twiceRemainder = (abs % divisor) * 2n;
  if (twiceRemainder < divisor) return quotient;
  if (twiceRemainder > divisor) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** Divides `abs` by `divisor`, rounding half-away-from-zero (on the
 * magnitude; the caller reapplies sign) — confirmed against the real journal
 * as what an ACTUAL `-X` commodity conversion (a real unit-price
 * multiplication, not just narrowing an already-same-commodity amount)
 * needs, which is DIFFERENT from every other narrowing's half-to-even:
 * "Banh Mi" (2024/11/13, Assets:Checking:Recievables:Girlie) values -50,000
 * VND at the VND price "0.0023139409 PHP", an exact -115.697045 — a genuine
 * tie at PHP's 5-decimal precision — and ledger's own display_amount for
 * that exact posting is "-115.69705", not half-to-even's "-115.69704" (4 is
 * already even, so half-to-even would leave it unrounded). Contrast the
 * *other* confirmed real tie, "(₱5,655.38165/2)" (2025/11/01,
 * Assets:Checking:Recievables:Harriet — a plain PHP÷2 expression, no
 * conversion involved since the posting's own commodity already equals the
 * report target): ledger renders that one "2827.69082", i.e. half-to-even.
 * Same function, same call sites, opposite tie behavior — so which rule
 * applies depends on whether *this specific amount* was actually converted,
 * not on which downstream consumer is asking; see roundQuantityToPrecision's
 * `wasConverted` parameter. */
function divideRoundHalfUp(abs: bigint, divisor: bigint): bigint {
  const twiceRemainder = (abs % divisor) * 2n;
  return twiceRemainder >= divisor ? abs / divisor + 1n : abs / divisor;
}

/** Rounds `qty` to `precision` decimal places, returning a Quantity at
 * exactly that scale — the building block `roundToDisplayPrecision` (below)
 * converts to `number` from. Kept as its own exact-bigint step because
 * accountsView.ts's account_history needs to do further exact arithmetic
 * (differencing two rounded totals) on the *rounded* value without
 * reintroducing floating-point error — see accountHistory's own
 * "compounding-rounding correction" comment.
 *
 * `wasConverted` picks the tie rule (see divideRoundHalfUp's comment for the
 * two confirmed, contradictory real cases) — see `wasActuallyConverted`
 * below for how callers should derive it. Defaults to `false`
 * (half-to-even), which is correct for every case except a single-posting
 * conversion delta. */
export function roundQuantityToPrecision(qty: Quantity, precision: number, wasConverted = false): Quantity {
  if (qty.scale <= precision) {
    const scaleUp = precision - qty.scale;
    return { units: qty.units * 10n ** BigInt(scaleUp), scale: precision };
  }
  const divisor = 10n ** BigInt(qty.scale - precision);
  const negative = qty.units < 0n;
  const abs = negative ? -qty.units : qty.units;
  const rounded = wasConverted ? divideRoundHalfUp(abs, divisor) : divideRoundHalfEven(abs, divisor);
  return { units: negative ? -rounded : rounded, scale: precision };
}

/** True when `valued` (a register row's `valuedAmount`) represents a
 * genuinely different real-world number than `native` (that same row's own
 * `amount`) — i.e. `-X` performed a real cross-currency conversion, not a
 * same-reporting-currency symbol/code alias passthrough. Comparing
 * commodity STRINGS for this is wrong: the real journal's identity price
 * ("P ... ₱ 1 PHP", MOBILE_APP_IMPLEMENTATION.md §2.1 item 1) makes prices.ts's
 * valueAt() route "₱"-denominated amounts through its actual multiplication
 * branch too (×1, by an aliased commodity's own price point), so
 * `native.commodity !== target` is true even for a same-currency posting —
 * confirmed as the exact cause of a real regression: "(₱5,655.38165/2)"
 * (2025/11/01, Assets:Checking:Recievables:Harriet) was wrongly flagged
 * "converted" this way, silently flipping its tie to half-up and masking a
 * compounding-correction row ledger actually emits. Comparing the two
 * VALUES instead — normalizing to the wider of the two scales — is
 * unaffected by which alias was used on either side. */
export function wasActuallyConverted(native: Amount | null, valued: Amount | null): boolean {
  if (!native || !valued) return false;
  const scale = native.qty.scale > valued.qty.scale ? native.qty.scale : valued.qty.scale;
  const nativeUnits = native.qty.units * 10n ** BigInt(scale - native.qty.scale);
  const valuedUnits = valued.qty.units * 10n ** BigInt(scale - valued.qty.scale);
  return nativeUnits !== valuedUnits;
}

/** Rounds `qty` to `precision` decimal places, returning a plain number.
 * Needed anywhere a *valued* amount (i.e. one that passed through `-X`) is
 * exposed as a number rather than as text: the Python backend gets this
 * rounding for free because it re-parses ledger's own rendered CSV text,
 * which ledger itself has already truncated to the commodity's display
 * precision (5 decimals for PHP in the real journal, from an unrelated
 * division split elsewhere — see this module's own header). This engine's
 * arithmetic stays exact throughout (ground rule 4), so without this step a
 * value like a running balance carries far more precision than ledger's own
 * output ever would, and disagrees with it from the 6th decimal on. Where a
 * caller sums several such numbers before its own final `round(x, 2)`
 * (analysis.ts's per-posting totals), each contribution must be rounded
 * here *first* — otherwise accumulated sub-cent drift across many postings
 * can tip the final 2dp rounding the wrong way, confirmed against the real
 * fixtures (a saved analysis over ~2,600 postings differed by exactly one
 * centavo without this). A single already-aggregated total (accounts.ts's
 * balance_php, budgets.ts's envelope figures) doesn't need it: ledger itself
 * only converts once there too, matching this engine's own
 * balance()+valueBalance() one-shot pipeline, and the caller's own
 * round(x, 2) already absorbs the sub-5th-decimal noise. */
export function roundToDisplayPrecision(qty: Quantity, precision: number, wasConverted = false): number {
  return toNumber(roundQuantityToPrecision(qty, precision, wasConverted));
}

function formatDigits(qty: Quantity, precision: number, commas: boolean): string {
  const negative = qty.units < 0n;
  const abs = negative ? -qty.units : qty.units;
  // Usually precision >= qty.scale (it's the max ever learned for this
  // commodity, see deriveCommodityStyles) — but an expression-computed
  // amount can carry more internal decimal digits than the commodity's own
  // learned precision (divQuantity's exactness buffer, ground rule 4), and
  // ledger rounds — not truncates — when narrowing to display precision
  // (confirmed against the real fixture: an untruncated 2226.186666...
  // prints as "2226.18667", not "...18666") — and rounds half-to-even on an
  // exact tie (see divideRoundHalfEven's own comment).
  const scaled =
    precision >= qty.scale ? abs * 10n ** BigInt(precision - qty.scale) : divideRoundHalfEven(abs, 10n ** BigInt(qty.scale - precision));
  const digits = scaled.toString().padStart(precision + 1, "0");
  const intPart = precision > 0 ? digits.slice(0, -precision) : digits;
  const fracPart = precision > 0 ? digits.slice(-precision) : "";
  const grouped = commas ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : intPart;
  const body = precision > 0 ? `${grouped}.${fracPart}` : grouped;
  return negative ? `-${body}` : body;
}

/** Renders one commodity/quantity pair the way ledger would print it as part
 * of a plain (non-lot) `amount`: the sign always sits directly against the
 * digits, with any symbol prefix in front of it ("₱-100.00", not "-₱100.00"
 * — confirmed against the real fixture and documented in parse.ts's own
 * AMOUNT_RE comment) and any code suffix after. */
export function formatLedgerAmount(
  commodity: string,
  qty: Quantity,
  styles: ReadonlyMap<string, CommodityStyle>,
  options?: { neverNarrow?: boolean },
): string {
  let style = styles.get(commodity);
  // No style entry, or one that only ever saw this commodity as a lot's own
  // literal quantity (widened for precision but never routed through
  // learn(), e.g. "House" in "1 House @ ..." — see deriveCommodityStyles):
  // fall back to a bare " <commodity>" suffix so the name isn't dropped.
  if (!style || (!style.prefix && !style.suffix)) {
    style = { precision: style?.precision ?? Math.max(qty.scale, 2), commas: style?.commas ?? false, prefix: "", suffix: ` ${commodity}` };
  }
  // A price annotation (see formatLedgerPostingAmount's `{cost}` rendering
  // below) is never truncated down to the commodity's registered precision
  // — only ever padded UP to at least it — confirmed against the real
  // journal: a price of "0.0404945666666667 PHP" (16 decimals) prints with
  // all 16, coexisting with PHP's own plain-amount precision staying at 5.
  const precision = options?.neverNarrow ? Math.max(qty.scale, style.precision) : style.precision;
  return `${style.prefix}${formatDigits(qty, precision, style.commas)}${style.suffix}`;
}

/** Renders a full posting amount, i.e. what transactions.py got for free
 * from `%(quoted(amount))`. `transactionDate` is only used for a lot
 * posting's `[date]` annotation (see below) — pass the owning transaction's
 * own date.
 *
 * A lot's `@ price` annotation is rendered ledger's own way: `{price}
 * [date]`, using the SAME per-unit price value as written (never converted
 * to a total cost — confirmed against the real journal: "2,500,000 VND @
 * 0.002334304 PHP" prints as "2,500,000 VND {0.002334304 PHP} [...]", not
 * "{5,835.76 PHP}") and the transaction's own date as the acquisition date. */
export function formatLedgerPostingAmount(amount: Amount, styles: ReadonlyMap<string, CommodityStyle>, transactionDate: Date): string {
  if (amount.lotPrice) {
    const base = formatLedgerAmount(amount.commodity, amount.qty, styles);
    const price = formatLedgerAmount(amount.lotPrice.commodity, amount.lotPrice.qty, styles, { neverNarrow: true });
    return `${base} {${price}} [${formatLedgerDate(transactionDate)}]`;
  }
  return formatLedgerAmount(amount.commodity, amount.qty, styles);
}
