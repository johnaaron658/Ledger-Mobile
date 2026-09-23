// Port of backend/app/analysis_store.py.

import type { AnalysisCategory } from "./analysis.js";
import type { Storage } from "./store.js";

export class AnalysisNotFound extends Error {}

export interface AnalysisRecord {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  categories: AnalysisCategory[];
  include_uncategorized: boolean;
  excluded_accounts: string[];
  allow_multi_category: boolean;
  forecast_end_date: string | null;
  updated_at: string;
}

export interface AnalysisPayload {
  name: string;
  start_date?: string | null;
  end_date?: string | null;
  categories: AnalysisCategory[];
  include_uncategorized?: boolean;
  excluded_accounts?: string[];
  allow_multi_category?: boolean;
  forecast_end_date?: string | null;
}

async function load(storage: Storage): Promise<{ analyses: AnalysisRecord[] }> {
  const data = (await storage.readConfig("analyses")) as { analyses: AnalysisRecord[] } | null;
  return data ?? { analyses: [] };
}

async function save(storage: Storage, data: { analyses: AnalysisRecord[] }): Promise<void> {
  await storage.writeConfig("analyses", data);
}

function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function toRecord(id: string, payload: AnalysisPayload): AnalysisRecord {
  return {
    id,
    name: payload.name,
    start_date: payload.start_date ?? null,
    end_date: payload.end_date ?? null,
    categories: payload.categories,
    include_uncategorized: payload.include_uncategorized ?? true,
    excluded_accounts: payload.excluded_accounts ?? [],
    allow_multi_category: payload.allow_multi_category ?? false,
    forecast_end_date: payload.forecast_end_date ?? null,
    updated_at: new Date().toISOString(),
  };
}

export async function listAnalyses(storage: Storage): Promise<{ id: string; name: string }[]> {
  const data = await load(storage);
  return data.analyses.map((a) => ({ id: a.id, name: a.name }));
}

export async function getAnalysis(storage: Storage, analysisId: string): Promise<AnalysisRecord> {
  const data = await load(storage);
  const found = data.analyses.find((a) => a.id === analysisId);
  if (!found) throw new AnalysisNotFound(analysisId);
  return found;
}

export async function createAnalysis(storage: Storage, payload: AnalysisPayload): Promise<AnalysisRecord> {
  const data = await load(storage);
  const analysis = toRecord(newId(), payload);
  data.analyses.push(analysis);
  await save(storage, data);
  return analysis;
}

export async function updateAnalysis(storage: Storage, analysisId: string, payload: AnalysisPayload): Promise<AnalysisRecord> {
  const data = await load(storage);
  const idx = data.analyses.findIndex((a) => a.id === analysisId);
  if (idx === -1) throw new AnalysisNotFound(analysisId);
  const updated = toRecord(analysisId, payload);
  data.analyses[idx] = updated;
  await save(storage, data);
  return updated;
}

export async function deleteAnalysis(storage: Storage, analysisId: string): Promise<void> {
  const data = await load(storage);
  const before = data.analyses.length;
  data.analyses = data.analyses.filter((a) => a.id !== analysisId);
  if (data.analyses.length === before) throw new AnalysisNotFound(analysisId);
  await save(storage, data);
}
