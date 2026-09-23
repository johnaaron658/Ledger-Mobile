// Port of backend/app/journal_edit.py, minus git (§4 of the implementation
// plan): `_is_dirty`, `_finish`, and `_resolve_safe_path` all exist only to
// support auto-committing into LEDGER_DIR and guarding against editing a
// file outside it — neither concept applies once there's a single journal
// file managed entirely through the injected Storage port. The generated
// message string is kept (as `EditResult.message`) since it's slated to
// become the single-level undo label in Phase 5 (§6 item 4).

import { parseAndValidate } from "@ledger/engine";
import type { Storage } from "./store.js";

export class JournalEditError extends Error {}

export interface PostingEditIn {
  account: string;
  amount_raw?: string;
}

export interface EditResult {
  message: string;
}

export function renderTransactionBlock(date: string, payee: string, postings: readonly PostingEditIn[]): string {
  const lines = [`${date} ${payee}`];
  for (const p of postings) {
    const amount = (p.amount_raw ?? "").trim();
    lines.push(amount ? `    ${p.account}    ${amount}` : `    ${p.account}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Mirrors Python's str.splitlines(keepends=True): each line keeps its own
 * trailing "\n" (if any), with no trailing empty element for a
 * newline-terminated string. */
export function splitKeepEnds(text: string): string[] {
  const parts = text.split(/(?<=\n)/);
  return parts.length > 0 && parts[parts.length - 1] === "" ? parts.slice(0, -1) : parts;
}

function separatorFor(original: string): string {
  if (original === "") return "";
  if (original.endsWith("\n\n")) return "";
  return original.endsWith("\n") ? "\n" : "\n\n";
}

function validateOrThrow(text: string): void {
  const { result } = parseAndValidate(text);
  if (!result.ok) {
    const detail = result.issues.map((i) => i.message).join("; ");
    throw new JournalEditError(`Edit rejected, journal would not balance: ${detail}`);
  }
}

async function currentText(storage: Storage): Promise<string> {
  return (await storage.readJournal()) ?? "";
}

export async function appendTransaction(
  storage: Storage,
  date: string,
  payee: string,
  postings: readonly PostingEditIn[],
): Promise<EditResult> {
  const original = await currentText(storage);
  const block = renderTransactionBlock(date, payee, postings);
  const updated = original + separatorFor(original) + block;
  validateOrThrow(updated);
  await storage.writeJournal(updated);
  return { message: `dashboard: add transaction ${date} ${payee}` };
}

/** Appends a pre-rendered ledger block verbatim (e.g. a rendered automation
 * occurrence) — port of journal_edit.append_raw_block. */
export async function appendRawBlock(storage: Storage, blockText: string, message: string): Promise<EditResult> {
  const original = await currentText(storage);
  const block = `${blockText.replace(/^\n+|\n+$/g, "")}\n`;
  const updated = original + separatorFor(original) + block;
  validateOrThrow(updated);
  await storage.writeJournal(updated);
  return { message };
}

export async function replaceTransaction(
  storage: Storage,
  begLine: number,
  endLine: number,
  date: string,
  payee: string,
  postings: readonly PostingEditIn[],
): Promise<EditResult> {
  const original = await currentText(storage);
  const lines = splitKeepEnds(original);
  if (begLine < 1 || endLine > lines.length || begLine > endLine) {
    throw new JournalEditError("Transaction location no longer matches file, refresh and retry.");
  }
  const block = renderTransactionBlock(date, payee, postings);
  const updated = [...lines.slice(0, begLine - 1), block, ...lines.slice(endLine)].join("");
  validateOrThrow(updated);
  await storage.writeJournal(updated);
  return { message: `dashboard: edit transaction ${date} ${payee}` };
}

export async function deleteTransaction(storage: Storage, begLine: number, endLine: number): Promise<EditResult> {
  const original = await currentText(storage);
  const lines = splitKeepEnds(original);
  if (begLine < 1 || endLine > lines.length || begLine > endLine) {
    throw new JournalEditError("Transaction location no longer matches file, refresh and retry.");
  }
  const newLines = [...lines.slice(0, begLine - 1), ...lines.slice(endLine)];
  // avoid leaving a redundant/trailing blank line at the seam where the block used to be
  const seam = begLine - 1;
  if (seam > 0 && seam <= newLines.length && !newLines[seam - 1].trim()) {
    if (seam === newLines.length) newLines.splice(seam - 1, 1);
    else if (!newLines[seam].trim()) newLines.splice(seam, 1);
  }
  const updated = newLines.join("");
  validateOrThrow(updated);
  await storage.writeJournal(updated);
  return { message: `dashboard: delete transaction at line ${begLine}` };
}

/** Writes arbitrary already-assembled journal text (budgets.ts's/
 * commodities.ts's line-splicing edits build the whole new text themselves,
 * unlike the transaction-block helpers above), validating first and never
 * touching storage if validation fails. */
export async function writeAndValidate(storage: Storage, newContent: string): Promise<void> {
  validateOrThrow(newContent);
  await storage.writeJournal(newContent);
}
