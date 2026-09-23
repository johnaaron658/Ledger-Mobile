// `( ... )` value-expression evaluator: `+ - * /` and parentheses over
// amounts and bare numbers.
//
// Rules (MOBILE_APP_IMPLEMENTATION.md §3.2 step 2):
//   amount ± amount   requires equal commodity
//   amount × / number  keeps the commodity
//   number ∘ number   stays a bare number
// Mixed amount+number under +/-, and amount*amount or number/amount under
// */÷, are not in the real corpus and are not valid ledger expressions either
// — they raise ExprError, which validate.ts treats the same as a parse error.

import { type Amount, type Commodity, type Quantity, addQuantity, divQuantity, mulQuantity, negateQuantity, parseQuantity } from "./amount.js";

export class ExprError extends Error {}

export type ExprValue = { kind: "amount"; commodity: Commodity; qty: Quantity } | { kind: "number"; qty: Quantity };

export function valueToAmount(v: ExprValue): Amount {
  if (v.kind === "number") {
    throw new ExprError("expression evaluated to a bare number, not an amount");
  }
  return { commodity: v.commodity, qty: v.qty };
}

type TokenType = "AMOUNT" | "NUMBER" | "PLUS" | "MINUS" | "STAR" | "SLASH" | "LPAREN" | "RPAREN" | "EOF";
interface Token {
  type: TokenType;
  commodity?: string;
  qty?: Quantity;
}

// Leading '-' is deliberately excluded from this leaf token (unlike
// amount.ts's AMOUNT_RE) — '-' is always lexed as its own operator, and the
// grammar's unary-minus rule in parseFactor is what applies a sign, so
// "(-₱3974.97)" and "(₱8000 - ₱4230.92)" go through the same code path.
const LEAF_RE = /^(?<prefix>[^\d+\-*/(). \t]*)[ \t]*(?<num>[\d,]+\.?\d*)[ \t]*(?<suffix>[A-Za-z]*)/;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const single: Record<string, TokenType> = { "+": "PLUS", "-": "MINUS", "*": "STAR", "/": "SLASH", "(": "LPAREN", ")": "RPAREN" };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch in single) {
      tokens.push({ type: single[ch] });
      i++;
      continue;
    }
    const rest = text.slice(i);
    const m = LEAF_RE.exec(rest);
    if (!m || !m.groups) {
      throw new ExprError(`unexpected character in expression at offset ${i}: ${JSON.stringify(rest.slice(0, 10))}`);
    }
    const qty = parseQuantity(m.groups.num);
    if (qty === null) {
      throw new ExprError(`invalid number in expression: ${JSON.stringify(m[0])}`);
    }
    const prefix = m.groups.prefix.trim();
    const suffix = m.groups.suffix.trim();
    const commodity = prefix || suffix || null;
    tokens.push(commodity ? { type: "AMOUNT", commodity, qty } : { type: "NUMBER", qty });
    i += m[0].length;
  }
  tokens.push({ type: "EOF" });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const t = this.next();
    if (t.type !== type) throw new ExprError(`expected ${type}, got ${t.type}`);
    return t;
  }

  parseExpression(): ExprValue {
    let left = this.parseTerm();
    while (this.peek().type === "PLUS" || this.peek().type === "MINUS") {
      const op = this.next().type as "PLUS" | "MINUS";
      left = applyAddSub(left, op, this.parseTerm());
    }
    return left;
  }

  private parseTerm(): ExprValue {
    let left = this.parseFactor();
    while (this.peek().type === "STAR" || this.peek().type === "SLASH") {
      const op = this.next().type as "STAR" | "SLASH";
      left = applyMulDiv(left, op, this.parseFactor());
    }
    return left;
  }

  private parseFactor(): ExprValue {
    const t = this.peek();
    if (t.type === "MINUS") {
      this.next();
      return negateValue(this.parseFactor());
    }
    if (t.type === "LPAREN") {
      this.next();
      const v = this.parseExpression();
      this.expect("RPAREN");
      return v;
    }
    if (t.type === "AMOUNT") {
      this.next();
      return { kind: "amount", commodity: t.commodity!, qty: t.qty! };
    }
    if (t.type === "NUMBER") {
      this.next();
      return { kind: "number", qty: t.qty! };
    }
    throw new ExprError(`unexpected token ${t.type} in expression`);
  }

  finish(): void {
    this.expect("EOF");
  }
}

function negateValue(v: ExprValue): ExprValue {
  return { ...v, qty: negateQuantity(v.qty) };
}

function applyAddSub(left: ExprValue, op: "PLUS" | "MINUS", right: ExprValue): ExprValue {
  const verb = op === "PLUS" ? "add" : "subtract";
  const combine = (a: Quantity, b: Quantity) => (op === "PLUS" ? addQuantity(a, b) : addQuantity(a, negateQuantity(b)));
  if (left.kind === "number" && right.kind === "number") {
    return { kind: "number", qty: combine(left.qty, right.qty) };
  }
  if (left.kind === "amount" && right.kind === "amount") {
    if (left.commodity !== right.commodity) {
      throw new ExprError(`cannot ${verb} mismatched commodities: ${left.commodity} and ${right.commodity}`);
    }
    return { kind: "amount", commodity: left.commodity, qty: combine(left.qty, right.qty) };
  }
  throw new ExprError(`cannot ${verb} an amount and a bare number`);
}

function applyMulDiv(left: ExprValue, op: "STAR" | "SLASH", right: ExprValue): ExprValue {
  const qtyOp = op === "STAR" ? mulQuantity : divQuantity;
  if (left.kind === "number" && right.kind === "number") {
    return { kind: "number", qty: qtyOp(left.qty, right.qty) };
  }
  if (left.kind === "amount" && right.kind === "amount") {
    throw new ExprError(`cannot ${op === "STAR" ? "multiply" : "divide"} two amounts`);
  }
  if (op === "SLASH" && left.kind !== "amount") {
    throw new ExprError("cannot divide a bare number by an amount");
  }
  const amount = left.kind === "amount" ? left : (right as ExprValue & { kind: "amount" });
  const number = left.kind === "number" ? left : (right as ExprValue & { kind: "number" });
  return { kind: "amount", commodity: amount.commodity, qty: qtyOp(amount.qty, number.qty) };
}

/** Evaluates a ledger value expression, with or without the enclosing
 * parens — both "(₱8000 - ₱4230.92)" and "₱8000 - ₱4230.92" parse the same,
 * since the grammar's factor rule treats '(' ... ')' as just another factor. */
export function evaluateExpr(text: string): ExprValue {
  const parser = new Parser(tokenize(text));
  const value = parser.parseExpression();
  parser.finish();
  return value;
}
