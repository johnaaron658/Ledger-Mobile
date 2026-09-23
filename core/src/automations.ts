// Port of backend/app/automations.py. Almost no ledger dependency — only
// `$[running_balance(...)]`/`$[running_budget(...)]` template functions
// touch the journal, via accountsView.ts/budgets.ts.

import type { Journal, PriceIndex } from "@ledger/engine";
import { accountHistory } from "./accountsView.js";
import { budgetRemainingAsOf } from "./budgets.js";
import { type EditResult, appendRawBlock } from "./journalEdit.js";
import { getDefaultCurrency } from "./settings.js";
import type { Storage } from "./store.js";

export class AutomationNotFound extends Error {}
export class OccurrenceNotFound extends Error {}
export class GroupNotFound extends Error {}

const VAR_RE = /\$\[(\w+)\]/g;
const BALANCE_FUNC_RE = /\$\[running_balance\(([^()]*)\)\]/g;
const BUDGET_FUNC_RE = /\$\[running_budget\(([^()]*)\)\]/g;

const PERIODS = new Set(["daily", "weekly", "monthly", "quarterly", "semiannually", "yearly", "custom"]);
const CUSTOM_UNITS = new Set(["days", "weeks", "months", "years"]);

export interface Automation {
  id: string;
  name: string;
  period: string;
  custom_interval: number | null;
  custom_unit: string | null;
  start_date: string;
  end_date: string | null;
  template: string;
  variable_defaults: Record<string, string>;
  generated_through: string | null;
  group_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationOut extends Automation {
  next_due: string | null;
  variables: string[]; // shadows Automation's own shape deliberately, matching Python's output dict
}

export interface PendingOccurrence {
  id: string;
  automation_id: string;
  automation_name: string;
  occurrence_date: string;
  template: string;
  variables: Record<string, string>;
  created_at: string;
  refreshed_at?: string;
}

export interface AutomationGroup {
  id: string;
  name: string;
  created_at: string;
}

interface AutomationsData {
  automations: Automation[];
  pending: PendingOccurrence[];
  groups: AutomationGroup[];
}

function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

async function load(storage: Storage): Promise<AutomationsData> {
  const data = (await storage.readConfig("automations")) as Partial<AutomationsData> | null;
  const automations = (data?.automations ?? []).map((a) => ({
    ...a,
    group_id: a.group_id ?? null,
    custom_interval: a.custom_interval ?? null,
    custom_unit: a.custom_unit ?? null,
  }));
  return { automations, pending: data?.pending ?? [], groups: data?.groups ?? [] };
}

async function save(storage: Storage, data: AutomationsData): Promise<void> {
  await storage.writeConfig("automations", data);
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("/").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function addMonths(d: Date, months: number): Date {
  const total = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month + 1));
  return new Date(Date.UTC(year, month, day));
}

function nextOccurrence(d: Date, period: string, customInterval?: number | null, customUnit?: string | null): Date {
  switch (period) {
    case "daily":
      return new Date(d.getTime() + 86_400_000);
    case "weekly":
      return new Date(d.getTime() + 7 * 86_400_000);
    case "monthly":
      return addMonths(d, 1);
    case "quarterly":
      return addMonths(d, 3);
    case "semiannually":
      return addMonths(d, 6);
    case "yearly":
      return addMonths(d, 12);
    case "custom": {
      const n = customInterval ?? 1;
      if (customUnit === "days") return new Date(d.getTime() + n * 86_400_000);
      if (customUnit === "weeks") return new Date(d.getTime() + n * 7 * 86_400_000);
      if (customUnit === "months") return addMonths(d, n);
      if (customUnit === "years") return addMonths(d, n * 12);
      throw new Error(`Unknown custom unit: ${customUnit}`);
    }
    default:
      throw new Error(`Unknown period: ${period}`);
  }
}

/** Port of automations.extract_variables. */
export function extractVariables(template: string): string[] {
  const seen: string[] = [];
  for (const m of template.matchAll(VAR_RE)) {
    const name = m[1];
    if (name !== "date" && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

async function formatMoney(storage: Storage, value: number): Promise<string> {
  const currency = await getDefaultCurrency(storage);
  return `${currency}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function runningBalanceAsOf(journal: Journal, index: PriceIndex, target: string, journalPath: string, account: string, asOf: Date): number {
  const asOfStr = formatDate(asOf);
  let value = 0;
  for (const h of accountHistory(journal, index, target, account, journalPath)) {
    if (h.date <= asOfStr) value = h.running_balance;
  }
  return value;
}

async function replaceAsync(str: string, regex: RegExp, fn: (m: RegExpMatchArray) => Promise<string>): Promise<string> {
  const matches = [...str.matchAll(regex)];
  if (matches.length === 0) return str;
  const replacements = await Promise.all(matches.map(fn));
  let result = "";
  let lastIndex = 0;
  matches.forEach((m, i) => {
    result += str.slice(lastIndex, m.index);
    result += replacements[i];
    lastIndex = m.index! + m[0].length;
  });
  result += str.slice(lastIndex);
  return result;
}

/** Bundles what render_template/resolve_functions need beyond the template
 * text itself — the injected `Storage` (for the default currency) plus a
 * ready-to-query journal (for $[running_balance]/$[running_budget]). */
export interface AutomationLedgerContext {
  storage: Storage;
  journal: Journal;
  index: PriceIndex;
  target: string;
  journalPath: string;
  budgetsText: string;
}

/** Port of automations.resolve_functions. */
async function resolveFunctions(ctx: AutomationLedgerContext, text: string, occurrenceDate: Date): Promise<string> {
  text = await replaceAsync(text, BALANCE_FUNC_RE, async (m) => {
    const account = m[1].trim();
    const value = runningBalanceAsOf(ctx.journal, ctx.index, ctx.target, ctx.journalPath, account, occurrenceDate);
    return formatMoney(ctx.storage, value);
  });
  text = await replaceAsync(text, BUDGET_FUNC_RE, async (m) => {
    const account = m[1].trim();
    const remaining = budgetRemainingAsOf(ctx.budgetsText, ctx.journal, ctx.index, ctx.target, account, occurrenceDate);
    return remaining !== null ? formatMoney(ctx.storage, remaining) : "N/A";
  });
  return text;
}

/** Port of automations.render_template. */
export async function renderTemplate(
  ctx: AutomationLedgerContext,
  template: string,
  occurrenceDate: Date,
  variables?: Record<string, string>,
): Promise<string> {
  let text = template.split("$[date]").join(formatDate(occurrenceDate));
  const vars = variables ?? {};
  for (const name of extractVariables(template)) {
    text = text.split(`$[${name}]`).join(String(vars[name] ?? ""));
  }
  return resolveFunctions(ctx, text, occurrenceDate);
}

function syncVariableDefaults(template: string, defaults: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of extractVariables(template)) result[name] = defaults[name] ?? "";
  return result;
}

function pendingCursor(automation: Automation): Date | null {
  const endDate = automation.end_date ? parseDate(automation.end_date) : null;
  const cursorRaw = automation.generated_through;
  const nextDate = cursorRaw
    ? nextOccurrence(parseDate(cursorRaw), automation.period, automation.custom_interval, automation.custom_unit)
    : parseDate(automation.start_date);
  if (endDate !== null && nextDate.getTime() > endDate.getTime()) return null;
  return nextDate;
}

function catchUpOne(automation: Automation, today: Date): PendingOccurrence[] {
  const newEntries: PendingOccurrence[] = [];
  let nextDate = pendingCursor(automation);
  while (nextDate !== null && nextDate.getTime() <= today.getTime()) {
    newEntries.push({
      id: newId(),
      automation_id: automation.id,
      automation_name: automation.name,
      occurrence_date: formatDate(nextDate),
      template: automation.template,
      variables: { ...automation.variable_defaults },
      created_at: new Date().toISOString(),
    });
    automation.generated_through = formatDate(nextDate);
    nextDate = pendingCursor(automation);
  }
  return newEntries;
}

/** Port of automations.catch_up: idempotent, enqueues any occurrences newly
 * due as of `today`. */
export async function catchUp(storage: Storage, today: Date): Promise<void> {
  const data = await load(storage);
  let changed = false;
  for (const automation of data.automations) {
    const newEntries = catchUpOne(automation, today);
    if (newEntries.length > 0) {
      data.pending.push(...newEntries);
      changed = true;
    }
  }
  if (changed) await save(storage, data);
}

function withNextDue(automation: Automation): AutomationOut {
  const nextDate = pendingCursor(automation);
  return { ...automation, next_due: nextDate ? formatDate(nextDate) : null, variables: extractVariables(automation.template) };
}

export async function listAutomations(storage: Storage, today: Date): Promise<AutomationOut[]> {
  await catchUp(storage, today);
  const data = await load(storage);
  return data.automations.map(withNextDue);
}

export async function getAutomation(storage: Storage, automationId: string): Promise<AutomationOut> {
  const data = await load(storage);
  const found = data.automations.find((a) => a.id === automationId);
  if (!found) throw new AutomationNotFound(automationId);
  return withNextDue(found);
}

export interface AutomationPayload {
  name: string;
  period: string;
  custom_interval?: number | null;
  custom_unit?: string | null;
  start_date: string;
  end_date?: string | null;
  template: string;
  variable_defaults?: Record<string, string>;
}

function validatePayload(payload: AutomationPayload): void {
  if (!PERIODS.has(payload.period)) throw new Error(`Invalid period: ${payload.period}`);
  if (payload.end_date && payload.end_date < payload.start_date) throw new Error("End date can't be before start date");
  if (payload.period === "custom") {
    if (!payload.custom_unit || !CUSTOM_UNITS.has(payload.custom_unit)) throw new Error(`Invalid custom unit: ${payload.custom_unit}`);
    if (!Number.isInteger(payload.custom_interval) || (payload.custom_interval as number) < 1) {
      throw new Error("Custom interval must be a positive integer");
    }
  }
}

export async function createAutomation(storage: Storage, today: Date, payload: AutomationPayload): Promise<AutomationOut> {
  validatePayload(payload);
  const data = await load(storage);
  const now = new Date().toISOString();
  const automation: Automation = {
    id: newId(),
    name: payload.name,
    period: payload.period,
    custom_interval: payload.period === "custom" ? (payload.custom_interval ?? null) : null,
    custom_unit: payload.period === "custom" ? (payload.custom_unit ?? null) : null,
    start_date: payload.start_date,
    end_date: payload.end_date || null,
    template: payload.template,
    variable_defaults: syncVariableDefaults(payload.template, payload.variable_defaults ?? {}),
    generated_through: null,
    group_id: null,
    created_at: now,
    updated_at: now,
  };
  data.automations.push(automation);
  await save(storage, data);
  await catchUp(storage, today);
  return getAutomation(storage, automation.id);
}

export async function updateAutomation(storage: Storage, today: Date, automationId: string, payload: AutomationPayload): Promise<AutomationOut> {
  validatePayload(payload);
  const data = await load(storage);
  const idx = data.automations.findIndex((a) => a.id === automationId);
  if (idx === -1) throw new AutomationNotFound(automationId);
  const now = new Date().toISOString();
  const updated: Automation = {
    ...data.automations[idx],
    name: payload.name,
    period: payload.period,
    custom_interval: payload.period === "custom" ? (payload.custom_interval ?? null) : null,
    custom_unit: payload.period === "custom" ? (payload.custom_unit ?? null) : null,
    start_date: payload.start_date,
    end_date: payload.end_date || null,
    template: payload.template,
    variable_defaults: syncVariableDefaults(payload.template, payload.variable_defaults ?? {}),
    updated_at: now,
  };
  data.automations[idx] = updated;
  // Not-yet-approved occurrences are still drafts, so keep them in sync with
  // the edited template/defaults instead of leaving them frozen on stale content.
  for (const p of data.pending) {
    if (p.automation_id === automationId) {
      p.automation_name = updated.name;
      p.template = updated.template;
      p.variables = { ...updated.variable_defaults };
      p.refreshed_at = now;
    }
  }
  await save(storage, data);
  await catchUp(storage, today);
  return getAutomation(storage, automationId);
}

export async function deleteAutomation(storage: Storage, automationId: string): Promise<void> {
  const data = await load(storage);
  const before = data.automations.length;
  data.automations = data.automations.filter((a) => a.id !== automationId);
  if (data.automations.length === before) throw new AutomationNotFound(automationId);
  data.pending = data.pending.filter((p) => p.automation_id !== automationId);
  await save(storage, data);
}

export async function listPending(storage: Storage, today: Date): Promise<PendingOccurrence[]> {
  await catchUp(storage, today);
  return (await load(storage)).pending;
}

export async function skipPending(storage: Storage, pendingId: string): Promise<void> {
  const data = await load(storage);
  const before = data.pending.length;
  data.pending = data.pending.filter((p) => p.id !== pendingId);
  if (data.pending.length === before) throw new OccurrenceNotFound(pendingId);
  await save(storage, data);
}

/** Read-only render of a pending occurrence for live review. */
export async function previewPending(
  storage: Storage,
  ctx: AutomationLedgerContext,
  pendingId: string,
  variables?: Record<string, string> | null,
): Promise<string> {
  const data = await load(storage);
  const entry = data.pending.find((p) => p.id === pendingId);
  if (!entry) throw new OccurrenceNotFound(pendingId);
  const occurrenceDate = parseDate(entry.occurrence_date);
  return renderTemplate(ctx, entry.template, occurrenceDate, variables ?? entry.variables ?? {});
}

export async function approvePending(
  storage: Storage,
  ctx: AutomationLedgerContext,
  pendingId: string,
  variables?: Record<string, string> | null,
  renderedOverride?: string | null,
): Promise<EditResult> {
  const data = await load(storage);
  const entry = data.pending.find((p) => p.id === pendingId);
  if (!entry) throw new OccurrenceNotFound(pendingId);
  let text: string;
  if (renderedOverride?.trim()) {
    text = renderedOverride;
  } else {
    const occurrenceDate = parseDate(entry.occurrence_date);
    text = await renderTemplate(ctx, entry.template, occurrenceDate, variables ?? entry.variables ?? {});
  }
  const result = await appendRawBlock(storage, text, `dashboard: automation '${entry.automation_name}' ${entry.occurrence_date}`);
  data.pending = data.pending.filter((p) => p.id !== pendingId);
  await save(storage, data);
  return result;
}

export async function listGroups(storage: Storage): Promise<AutomationGroup[]> {
  return (await load(storage)).groups;
}

export async function createGroup(storage: Storage, name: string): Promise<AutomationGroup> {
  const data = await load(storage);
  const group: AutomationGroup = { id: newId(), name, created_at: new Date().toISOString() };
  data.groups.push(group);
  await save(storage, data);
  return group;
}

export async function renameGroup(storage: Storage, groupId: string, name: string): Promise<AutomationGroup> {
  const data = await load(storage);
  const group = data.groups.find((g) => g.id === groupId);
  if (!group) throw new GroupNotFound(groupId);
  group.name = name;
  await save(storage, data);
  return group;
}

export async function deleteGroup(storage: Storage, groupId: string): Promise<void> {
  const data = await load(storage);
  const before = data.groups.length;
  data.groups = data.groups.filter((g) => g.id !== groupId);
  if (data.groups.length === before) throw new GroupNotFound(groupId);
  for (const a of data.automations) {
    if (a.group_id === groupId) a.group_id = null;
  }
  await save(storage, data);
}

export async function reorderGroups(storage: Storage, orderedIds: readonly string[]): Promise<AutomationGroup[]> {
  const data = await load(storage);
  const byId = new Map(data.groups.map((g) => [g.id, g]));
  const idSet = new Set(orderedIds);
  if (idSet.size !== byId.size || [...byId.keys()].some((id) => !idSet.has(id))) {
    throw new Error("Group id list must match existing groups exactly");
  }
  data.groups = orderedIds.map((id) => byId.get(id)!);
  await save(storage, data);
  return data.groups;
}

export async function moveAutomation(storage: Storage, automationId: string, groupId: string | null, beforeId?: string | null): Promise<void> {
  const data = await load(storage);
  if (groupId !== null && !data.groups.some((g) => g.id === groupId)) throw new GroupNotFound(groupId);
  const idx = data.automations.findIndex((a) => a.id === automationId);
  if (idx === -1) throw new AutomationNotFound(automationId);
  const [automation] = data.automations.splice(idx, 1);
  automation.group_id = groupId;
  if (beforeId != null) {
    const targetIdx = data.automations.findIndex((a) => a.id === beforeId);
    if (targetIdx === -1) data.automations.push(automation);
    else data.automations.splice(targetIdx, 0, automation);
  } else {
    data.automations.push(automation);
  }
  await save(storage, data);
}
