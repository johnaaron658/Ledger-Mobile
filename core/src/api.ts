// Port of backend/app/main.py — the api.js-shaped service layer (§4 of the
// implementation plan). Each method's body is the corresponding FastAPI
// route, minus FastAPI/pydantic itself: `HTTPException(status, detail)` ->
// `throw new Error(detail)`, matching api.js's own error contract
// (`throw new Error(data.detail || ...)` on a non-ok response).
//
// Every method re-reads and re-parses the journal, same as the Python
// backend re-shells to `ledger` on every request — nothing here is cached
// across calls (parse_budgets_file's own line numbers would go stale
// otherwise; see budgets.ts's module header).

import { type Journal, type PriceIndex, buildPriceIndex, parseAndValidate } from "@ledger/engine";
import { buildAccountTree, listAccountNames, accountHistory } from "./accountsView.js";
import { type AnalysisCategory, computeAnalysis, computeAnalysisSeries } from "./analysis.js";
import * as analysisStore from "./analysisStore.js";
import * as automations from "./automations.js";
import type { AutomationLedgerContext, AutomationPayload } from "./automations.js";
import * as budgets from "./budgets.js";
import * as commodities from "./commodities.js";
import { getSettings, updateSettings } from "./settings.js";
import {
  type PostingEditIn,
  appendTransaction,
  deleteTransaction,
  replaceTransaction,
} from "./journalEdit.js";
import type { Storage } from "./store.js";
import { listTransactions } from "./transactions.js";
import {
  type ConfigImportResult,
  type JournalImportResult,
  emptyJournalText,
  exportConfigBundle,
  exportFullBundle,
  importConfig,
  importJournal,
  previewJournalImport,
} from "./importExport.js";
import {
  type ExportNudge,
  type ExportRecord,
  type WriteStats,
  getExportNudge,
  getRetainedExportBytes,
  getWriteStats,
  listRetainedExports,
  recordExport,
  undoLastWrite,
} from "./mobileState.js";

async function loadJournal(storage: Storage): Promise<{ text: string; journal: Journal; index: PriceIndex }> {
  const text = (await storage.readJournal()) ?? "";
  const { journal, result } = parseAndValidate(text);
  if (!journal || !result.ok) {
    const detail = result.issues.map((i) => i.message).join("; ") || "unknown parse error";
    throw new Error(`Journal does not balance: ${detail}`);
  }
  return { text, journal, index: buildPriceIndex(journal) };
}

async function ledgerContext(storage: Storage, journalPath: string): Promise<AutomationLedgerContext & { journal: Journal; index: PriceIndex; text: string }> {
  const { text, journal, index } = await loadJournal(storage);
  const target = (await getSettings(storage)).main_commodity;
  return { storage, journal, index, target, journalPath, budgetsText: text, text };
}

export interface TransactionIn {
  date: string;
  payee: string;
  postings: PostingEditIn[];
}
export interface TransactionEditIn extends TransactionIn {
  file: string;
  beg_line: number;
  end_line: number;
}
export interface TransactionDeleteIn {
  file: string;
  beg_line: number;
  end_line: number;
}
export interface CommodityPriceIn {
  commodity: string;
  date: string;
  amount_raw: string;
  price_commodity?: string;
}
export interface ComputeIn {
  start_date?: string | null;
  end_date?: string | null;
  categories?: AnalysisCategory[];
  excluded_accounts?: string[];
}
export interface ComputeSeriesIn extends ComputeIn {
  granularity?: string;
  forecast_end_date?: string | null;
}

function notFound(message: string): never {
  throw new Error(message);
}

/** Creates the localApi implementation of frontend/src/api.js's `api`
 * object, bound to one Storage + one virtual journal path (echoed back in
 * transaction edit/delete round-trips; not otherwise interpreted — see
 * store.ts, there's only ever one journal). */
export function createLocalApi(storage: Storage, journalPath = "journal.ledger") {
  return {
    // Two extra methods outside the ~40 that mirror api.js (§5.4) — the
    // desktop has no equivalent because config.py always points at a folder
    // that already exists. hasJournal() is the empty-state check the import
    // screen gates on; importJournal/importConfig/startNewJournal/
    // exportConfig are the rest of the §5.4 flow.
    async hasJournal(): Promise<boolean> {
      return (await storage.readJournal()) !== null;
    },
    previewJournal(text: string): JournalImportResult {
      return previewJournalImport(text);
    },
    async importJournal(text: string): Promise<JournalImportResult> {
      return importJournal(storage, text);
    },
    async startNewJournal(): Promise<void> {
      const settings = await getSettings(storage);
      await storage.writeJournal(emptyJournalText(settings));
    },
    async importConfig(bundle: Uint8Array, mode: "replace" | "merge"): Promise<ConfigImportResult> {
      return importConfig(storage, bundle, mode);
    },
    async exportConfig(): Promise<Uint8Array> {
      return exportConfigBundle(storage);
    },

    // Phase 5 (§6 items 3-5): the mobile-only one-tap export, single-level
    // undo, and staleness nudge. Not part of the original ~40-method api.js
    // contract (the desktop has no equivalent — no export, no undo beyond
    // its own git history, no "since last export" concept), same rationale
    // as the §5.4 import methods above.
    async exportBundle(label = "export"): Promise<Uint8Array> {
      const bytes = await exportFullBundle(storage);
      await recordExport(storage, bytes, label);
      return bytes;
    },
    async getExportNudge(now?: string): Promise<ExportNudge> {
      return getExportNudge(storage, now ? new Date(now) : new Date());
    },
    async getWriteStats(): Promise<WriteStats> {
      return getWriteStats(storage);
    },
    async listRetainedExports(): Promise<ExportRecord[]> {
      return listRetainedExports(storage);
    },
    async getRetainedExportBytes(id: string): Promise<Uint8Array | null> {
      return getRetainedExportBytes(storage, id);
    },
    async undoLastWrite(): Promise<{ ok: boolean; message?: string }> {
      return undoLastWrite(storage);
    },

    async getTransactions() {
      const { journal } = await loadJournal(storage);
      return listTransactions(journal, journalPath);
    },
    async addTransaction(txn: TransactionIn) {
      const result = await appendTransaction(storage, txn.date, txn.payee, txn.postings);
      return { ok: true, ...result };
    },
    async editTransaction(txn: TransactionEditIn) {
      const result = await replaceTransaction(storage, txn.beg_line, txn.end_line, txn.date, txn.payee, txn.postings);
      return { ok: true, ...result };
    },
    async deleteTransaction(loc: TransactionDeleteIn) {
      const result = await deleteTransaction(storage, loc.beg_line, loc.end_line);
      return { ok: true, ...result };
    },

    async getAccounts() {
      const { journal, index } = await loadJournal(storage);
      const target = (await getSettings(storage)).main_commodity;
      return buildAccountTree(journal, index, target, new Date());
    },
    async getAccountNames() {
      const { journal } = await loadJournal(storage);
      return listAccountNames(journal);
    },
    async getAccountHistory(account: string) {
      const { journal, index } = await loadJournal(storage);
      const target = (await getSettings(storage)).main_commodity;
      return accountHistory(journal, index, target, account, journalPath);
    },

    async getBudgets() {
      const { text, journal, index } = await loadJournal(storage);
      const target = (await getSettings(storage)).main_commodity;
      const settings = await budgets.getBudgetSettings(storage);
      return budgets.listBudgets(text, journal, index, target, new Date(), settings.excluded_accounts);
    },
    async addBudgetPeriod(account: string, period_text: string, amount_raw: string) {
      const result = await budgets.addBudgetPeriod(storage, new Date(), account, period_text, amount_raw);
      return { ok: true, ...result };
    },
    async createBudget(account: string, period_text: string, amount_raw: string) {
      const result = await budgets.createBudget(storage, new Date(), account, period_text, amount_raw);
      return { ok: true, ...result };
    },
    async getBudgetSettings() {
      return budgets.getBudgetSettings(storage);
    },
    async updateBudgetSettings(settings: Partial<budgets.BudgetSettings>) {
      return budgets.updateBudgetSettings(storage, settings);
    },

    async getAppSettings() {
      return getSettings(storage);
    },
    async updateAppSettings(settings: { default_currency?: string; main_commodity?: string }) {
      return updateSettings(storage, settings);
    },

    async getCommodities() {
      const { journal } = await loadJournal(storage);
      return commodities.listCommodities(journal);
    },
    async addCommodityPrice(price: CommodityPriceIn) {
      const target = (await getSettings(storage)).main_commodity;
      try {
        const result = await commodities.addPricePoint(storage, price.commodity, price.date, price.amount_raw, price.price_commodity || target);
        return { ok: true, ...result };
      } catch (e) {
        if (e instanceof commodities.PriceError) throw new Error(e.message);
        throw e;
      }
    },
    async deleteCommodity(commodity: string) {
      try {
        const result = await commodities.deleteCommodity(storage, commodity);
        return { ok: true, ...result };
      } catch (e) {
        if (e instanceof commodities.PriceError) throw new Error(e.message);
        throw e;
      }
    },

    async getAnalyses() {
      return analysisStore.listAnalyses(storage);
    },
    async getAnalysis(id: string) {
      try {
        return await analysisStore.getAnalysis(storage, id);
      } catch (e) {
        if (e instanceof analysisStore.AnalysisNotFound) notFound("Analysis not found");
        throw e;
      }
    },
    async createAnalysis(analysis: analysisStore.AnalysisPayload) {
      return analysisStore.createAnalysis(storage, analysis);
    },
    async updateAnalysis(id: string, analysis: analysisStore.AnalysisPayload) {
      try {
        return await analysisStore.updateAnalysis(storage, id, analysis);
      } catch (e) {
        if (e instanceof analysisStore.AnalysisNotFound) notFound("Analysis not found");
        throw e;
      }
    },
    async deleteAnalysis(id: string) {
      try {
        await analysisStore.deleteAnalysis(storage, id);
      } catch (e) {
        if (e instanceof analysisStore.AnalysisNotFound) notFound("Analysis not found");
        throw e;
      }
      return { ok: true };
    },
    async computeAnalysis(draft: ComputeIn) {
      const { journal, index } = await loadJournal(storage);
      const target = (await getSettings(storage)).main_commodity;
      return computeAnalysis(journal, index, target, draft.start_date ?? null, draft.end_date ?? null, draft.categories ?? [], draft.excluded_accounts ?? []);
    },
    async computeAnalysisSeries(draft: ComputeSeriesIn) {
      const { journal, index } = await loadJournal(storage);
      const target = (await getSettings(storage)).main_commodity;
      return computeAnalysisSeries(
        journal,
        index,
        target,
        draft.start_date ?? null,
        draft.end_date ?? null,
        draft.categories ?? [],
        draft.excluded_accounts ?? [],
        draft.granularity ?? "months",
        draft.forecast_end_date ?? null,
      );
    },

    async getAutomations() {
      return automations.listAutomations(storage, new Date());
    },
    async createAutomation(automation: AutomationPayload) {
      return automations.createAutomation(storage, new Date(), automation);
    },
    async updateAutomation(id: string, automation: AutomationPayload) {
      try {
        return await automations.updateAutomation(storage, new Date(), id, automation);
      } catch (e) {
        if (e instanceof automations.AutomationNotFound) notFound("Automation not found");
        throw e;
      }
    },
    async deleteAutomation(id: string) {
      try {
        await automations.deleteAutomation(storage, id);
      } catch (e) {
        if (e instanceof automations.AutomationNotFound) notFound("Automation not found");
        throw e;
      }
      return { ok: true };
    },
    async getPendingAutomations() {
      return automations.listPending(storage, new Date());
    },
    async previewPendingAutomation(id: string, variables?: Record<string, string> | null) {
      try {
        const ctx = await ledgerContext(storage, journalPath);
        const rendered = await automations.previewPending(storage, ctx, id, variables);
        return { rendered };
      } catch (e) {
        if (e instanceof automations.OccurrenceNotFound) notFound("Pending occurrence not found");
        throw e;
      }
    },
    async approvePendingAutomation(id: string, opts: { variables?: Record<string, string> | null; renderedOverride?: string | null } = {}) {
      try {
        const ctx = await ledgerContext(storage, journalPath);
        const result = await automations.approvePending(storage, ctx, id, opts.variables ?? null, opts.renderedOverride ?? null);
        return { ok: true, ...result };
      } catch (e) {
        if (e instanceof automations.OccurrenceNotFound) notFound("Pending occurrence not found");
        throw e;
      }
    },
    async skipPendingAutomation(id: string) {
      try {
        await automations.skipPending(storage, id);
      } catch (e) {
        if (e instanceof automations.OccurrenceNotFound) notFound("Pending occurrence not found");
        throw e;
      }
      return { ok: true };
    },
    async moveAutomation(id: string, opts: { groupId?: string | null; beforeId?: string | null } = {}) {
      try {
        await automations.moveAutomation(storage, id, opts.groupId ?? null, opts.beforeId ?? null);
      } catch (e) {
        if (e instanceof automations.AutomationNotFound) notFound("Automation not found");
        if (e instanceof automations.GroupNotFound) notFound("Group not found");
        throw e;
      }
      return { ok: true };
    },

    async getAutomationGroups() {
      return automations.listGroups(storage);
    },
    async createAutomationGroup(name: string) {
      return automations.createGroup(storage, name);
    },
    async renameAutomationGroup(id: string, name: string) {
      try {
        return await automations.renameGroup(storage, id, name);
      } catch (e) {
        if (e instanceof automations.GroupNotFound) notFound("Group not found");
        throw e;
      }
    },
    async deleteAutomationGroup(id: string) {
      try {
        await automations.deleteGroup(storage, id);
      } catch (e) {
        if (e instanceof automations.GroupNotFound) notFound("Group not found");
        throw e;
      }
      return { ok: true };
    },
    async reorderAutomationGroups(order: string[]) {
      return automations.reorderGroups(storage, order);
    },
  };
}

export type LocalApi = ReturnType<typeof createLocalApi>;
