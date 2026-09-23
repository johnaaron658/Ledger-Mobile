// Port of backend/app/budgets.py + backend/app/budget_settings.py.
//
// Two big simplifications over the Python original, both because the real
// work already lives in @ledger/engine (Phase 1):
//
// 1. `_period_range`/`_covers`/`_expand_date` are reused directly from
//    engine's periodRange/covers/expandDateToken (periodic.ts's own docs
//    call these out as ports of the exact same functions).
// 2. `_ledger_totals`/`_envelopes` don't need the real backend's per-account
//    query workaround (see budgets.py's own long comment on `_ledger_totals`
//    and periodic.ts's header) — that workaround exists only because the
//    real `ledger` CLI's `--budget` batching has a genuine bug. This engine's
//    budgetRemaining() computes every account independently and correctly by
//    construction, so envelopes() below is one call, batched, always.
//
// parse_budgets_file still has to be a direct text port, unlike everything
// else here: it needs exact 1-indexed line numbers (beg_line/amount_line)
// for add_budget_period's line surgery, which the parsed engine Journal
// doesn't carry per-posting (see MOBILE_APP_IMPLEMENTATION.md §4's "two
// porting traps" — line numbers must be re-derived after every write, never
// cached, since an edit elsewhere in the file shifts them).

import {
  type Journal,
  type PriceIndex,
  balance,
  budgetRemaining,
  covers,
  expandDateToken,
  parseAmount,
  periodRange,
  thisMonthRange,
  toNumber,
} from "@ledger/engine";
import { isExcludedAccount } from "./transactions.js";
import { JournalEditError, type EditResult, splitKeepEnds, writeAndValidate } from "./journalEdit.js";
import type { Storage } from "./store.js";

const NUMERIC_AMOUNT_RE = /^[^\d-]*-?[\d,]+\.?\d*\s*[A-Za-z]*$/;
const DATE_TOKEN = String.raw`\d{4}(?:/\d{1,2}(?:/\d{1,2})?)?`;

export interface BudgetBlock {
  periodText: string;
  amountRaw: string;
  begLine: number; // 1-indexed line of the "~ ..." header
  amountLine: number; // 1-indexed line of the account+amount posting
  isActive: boolean;
}

export interface BudgetCategory {
  account: string;
  blocks: BudgetBlock[];
}

function activeBlock(cat: BudgetCategory): BudgetBlock | null {
  for (let i = cat.blocks.length - 1; i >= 0; i--) {
    if (cat.blocks[i].isActive) return cat.blocks[i];
  }
  return null;
}

/** Port of budgets._period_start_token. */
function periodStartToken(periodText: string): string | null {
  const m = new RegExp(String.raw`\b(?:from|in)\s+(${DATE_TOKEN})`, "i").exec(periodText);
  return m ? m[1] : null;
}

/** Splits "<account>    <amount>" on the FIRST run of 2+ spaces, mirroring
 * Python's `re.split(r"\s{2,}", text, maxsplit=1)`. */
function splitOnceOnDoubleSpace(text: string): [string, string] | null {
  const m = /^(.*?)\s{2,}(.*)$/.exec(text);
  return m ? [m[1], m[2]] : null;
}

/** Port of budgets.parse_budgets_file. */
export function parseBudgetsFile(text: string, today: Date): Map<string, BudgetCategory> {
  const lines = text.split(/\r?\n/);
  const categories = new Map<string, BudgetCategory>();

  let i = 0;
  while (i < lines.length) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("~")) {
      const periodText = stripped.slice(1).trim();
      const headerLineNo = i + 1;
      if (i + 1 < lines.length) {
        const split = splitOnceOnDoubleSpace(lines[i + 1].trim());
        if (split) {
          const [account, amountRaw] = split;
          const block: BudgetBlock = { periodText, amountRaw, begLine: headerLineNo, amountLine: i + 2, isActive: false };
          let cat = categories.get(account);
          if (!cat) {
            cat = { account, blocks: [] };
            categories.set(account, cat);
          }
          cat.blocks.push(block);
        }
      }
      i += 1;
      while (i < lines.length && lines[i].trim()) i += 1;
    }
    i += 1;
  }

  for (const cat of categories.values()) {
    for (const block of cat.blocks) {
      block.isActive = covers(periodRange(block.periodText), today);
    }
  }
  return categories;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const zeroQty = { units: 0n, scale: 0 };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Port of budgets._this_month_actuals. */
export function thisMonthActuals(
  journal: Journal,
  index: PriceIndex,
  target: string,
  today: Date,
  excludedAccounts: readonly string[],
): Map<string, number> {
  const { begin, end } = thisMonthRange(today);
  // No price point can exist between today and month-end in any real
  // journal (that would be a price from the future), so asOf=today vs
  // asOf=end never actually differ in practice — today is used since it's
  // the query's real implicit "now", matching the unbounded-query
  // convention documented on balance.ts's own BalanceValuation.asOf.
  const rows = balance(journal, { begin, end, valuation: { index, target, asOf: today } });
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (isExcludedAccount(row.account, excludedAccounts)) continue;
    totals.set(row.account, toNumber(row.balance.get(target) ?? zeroQty));
  }
  return totals;
}

export interface Envelope {
  spent: number;
  budgeted: number;
  remaining: number;
}

/** Port of budgets._envelopes — one batched engine call, always (see module
 * header on why the real backend's per-account workaround doesn't apply). */
export function envelopes(journal: Journal, index: PriceIndex, target: string, today: Date, accounts: readonly string[]): Map<string, Envelope> {
  const out = new Map<string, Envelope>();
  if (accounts.length === 0) return out;
  const pattern = new RegExp(accounts.map((a) => `^${escapeRegExp(a)}$`).join("|"));
  const rows = budgetRemaining(journal, { accountPattern: pattern, cutoff: today, valuation: { index, target }, includeEmpty: [...accounts] });
  for (const row of rows) {
    const spent = toNumber(row.actual.get(target) ?? zeroQty);
    const remaining = toNumber(row.remaining.get(target) ?? zeroQty);
    out.set(row.account, { spent: round2(spent), budgeted: round2(spent + remaining), remaining: round2(remaining) });
  }
  return out;
}

/** Port of budgets._actuals_between: sum of `account`'s EXACT-match postings
 * (report currency) between start and endInclusive. */
function actualsBetween(journal: Journal, index: PriceIndex, target: string, account: string, start: Date | null, endInclusive: Date): number {
  const endExclusive = new Date(endInclusive.getTime() + 86_400_000);
  const rows = balance(journal, {
    accountPattern: new RegExp(`^${escapeRegExp(account)}$`),
    begin: start ?? undefined,
    end: endExclusive,
    valuation: { index, target, asOf: endExclusive },
  });
  return rows.length > 0 ? toNumber(rows[0].balance.get(target) ?? zeroQty) : 0;
}

/** Port of budgets.budget_remaining_as_of (used by automations.ts's
 * $[running_budget(...)] resolution). `budgetsText` is the current journal
 * text — parseBudgetsFile needs it fresh, never cached (see module header). */
export function budgetRemainingAsOf(
  budgetsText: string,
  journal: Journal,
  index: PriceIndex,
  target: string,
  account: string,
  asOf: Date,
): number | null {
  const categories = parseBudgetsFile(budgetsText, asOf);
  const cat = categories.get(account);
  if (!cat) return null;
  let block: BudgetBlock | null = null;
  for (let i = cat.blocks.length - 1; i >= 0; i--) {
    if (covers(periodRange(cat.blocks[i].periodText), asOf)) {
      block = cat.blocks[i];
      break;
    }
  }
  if (!block || !NUMERIC_AMOUNT_RE.test(block.amountRaw.trim())) return null;
  const parsed = parseAmount(block.amountRaw);
  if (parsed.quantity === null) return null;
  const budgeted = toNumber(parsed.quantity);
  const monthStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const spent = actualsBetween(journal, index, target, account, monthStart, asOf);
  return budgeted - Math.abs(spent);
}

export interface BudgetHistoryEntryOut {
  period_text: string;
  amount_raw: string;
  is_active: boolean;
}

export interface BudgetOut {
  account: string;
  active_period: string | null;
  budgeted: number | null;
  spent: number;
  envelope: Envelope | null;
  editable: boolean;
  history: BudgetHistoryEntryOut[];
}

/** Port of budgets.list_budgets. `budgetsText` is the current journal text
 * (parsed fresh here, see parseBudgetsFile). */
export function listBudgets(
  budgetsText: string,
  journal: Journal,
  index: PriceIndex,
  target: string,
  today: Date,
  excludedAccounts: readonly string[],
): BudgetOut[] {
  const categories = parseBudgetsFile(budgetsText, today);
  const actuals = thisMonthActuals(journal, index, target, today, excludedAccounts);
  const result: BudgetOut[] = [];
  const envelopeAccounts: string[] = [];

  for (const [account, cat] of categories) {
    const active = activeBlock(cat);
    const spent = Math.abs(actuals.get(account) ?? 0);
    let budgeted: number | null = null;
    let editable = false;
    if (active) {
      editable = NUMERIC_AMOUNT_RE.test(active.amountRaw.trim());
      if (editable) {
        const parsed = parseAmount(active.amountRaw);
        budgeted = parsed.quantity ? toNumber(parsed.quantity) : null;
      }
      envelopeAccounts.push(account);
    }
    result.push({
      account,
      active_period: active ? active.periodText : null,
      budgeted,
      spent: round2(spent),
      envelope: null,
      editable,
      history: cat.blocks.map((b) => ({ period_text: b.periodText, amount_raw: b.amountRaw, is_active: b.isActive })),
    });
  }

  const env = envelopes(journal, index, target, today, envelopeAccounts);
  for (const entry of result) entry.envelope = env.get(entry.account) ?? null;

  result.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  return result;
}

function formatDateToken(d: Date): string {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Port of budgets.add_budget_period. Reads the journal text fresh, splices
 * in the new "~ period / account amount / offset" block (closing the
 * previous open-ended block first, if any), validates, and writes. */
export async function addBudgetPeriod(storage: Storage, today: Date, account: string, periodTextIn: string, amountRawIn: string): Promise<EditResult> {
  const periodText = periodTextIn.trim();
  const amountRaw = amountRawIn.trim();
  if (!periodText) throw new JournalEditError("Period text is required.");
  if (!amountRaw) throw new JournalEditError("Amount is required.");

  const original = (await storage.readJournal()) ?? "";
  const categories = parseBudgetsFile(original, today);
  const cat = categories.get(account);
  if (!cat || cat.blocks.length === 0) throw new JournalEditError(`No existing budget history found for ${account}`);
  const last = cat.blocks[cat.blocks.length - 1];

  const lines = splitKeepEnds(original);

  let offsetAccount = "Assets:Checking";
  if (last.amountLine < lines.length) {
    const m = /^\s*(\S+)/.exec(lines[last.amountLine]);
    if (m) offsetAccount = m[1];
  }

  if (last.isActive && !/\bto\b/i.test(last.periodText)) {
    const startToken = periodStartToken(periodText);
    if (startToken) {
      const closeDate = new Date(expandDateToken(startToken, false).getTime() - 86_400_000);
      const closeToken = formatDateToken(closeDate);
      const closeIdx = last.begLine - 1;
      lines[closeIdx] = `${lines[closeIdx].replace(/\n$/, "")} to ${closeToken}\n`;
    }
  }

  const blockStart = last.begLine - 1;
  let endIdx = blockStart;
  while (endIdx < lines.length && lines[endIdx].trim()) endIdx += 1;
  const newLines = ["\n", `~ ${periodText}\n`, `    ${account}    ${amountRaw}\n`, `    ${offsetAccount}\n`];
  lines.splice(endIdx, 0, ...newLines);

  const updated = lines.join("");
  const message = `dashboard: new budget period for ${account} (${periodText})`;
  await writeAndValidate(storage, updated, message);
  return { message };
}

/** Port of budgets.create_budget. */
export async function createBudget(
  storage: Storage,
  today: Date,
  accountIn: string,
  periodTextIn: string,
  amountRawIn: string,
  offsetAccountIn = "Assets:Checking",
): Promise<EditResult> {
  const account = accountIn.trim();
  const periodText = periodTextIn.trim();
  const amountRaw = amountRawIn.trim();
  const offsetAccount = offsetAccountIn.trim() || "Assets:Checking";
  if (!account) throw new JournalEditError("Account is required.");
  if (!periodText) throw new JournalEditError("Period text is required.");
  if (!amountRaw) throw new JournalEditError("Amount is required.");

  const original = (await storage.readJournal()) ?? "";
  const categories = parseBudgetsFile(original, today);
  if (categories.has(account)) {
    throw new JournalEditError(`${account} already has budget history; edit it instead of creating a new one.`);
  }

  const sep = original.endsWith("\n\n") ? "" : original.endsWith("\n") ? "\n" : "\n\n";
  const label = account.includes(":") ? account.slice(account.lastIndexOf(":") + 1) : account;
  const block = `// ${label} Budget History\n\n~ ${periodText}\n    ${account}    ${amountRaw}\n    ${offsetAccount}\n`;
  const message = `dashboard: new budget for ${account} (${periodText})`;
  await writeAndValidate(storage, original + sep + block, message);
  return { message };
}

// budget_settings.py port — a plain JSON blob via Storage.
export interface BudgetSettings {
  excluded_accounts: string[];
}

const BUDGET_SETTINGS_DEFAULTS: BudgetSettings = { excluded_accounts: [] };

export async function getBudgetSettings(storage: Storage): Promise<BudgetSettings> {
  const stored = (await storage.readConfig("budget_settings")) as Partial<BudgetSettings> | null;
  return { ...BUDGET_SETTINGS_DEFAULTS, ...stored };
}

export async function updateBudgetSettings(storage: Storage, payload: Partial<BudgetSettings>): Promise<BudgetSettings> {
  const settings: BudgetSettings = { excluded_accounts: payload.excluded_accounts ?? [] };
  await storage.writeConfig("budget_settings", settings);
  return settings;
}
