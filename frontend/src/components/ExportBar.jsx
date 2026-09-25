import { useEffect, useRef, useState } from 'react';
import { api, isLocalEngine } from '../api';
import { shareBytes } from '../capacitorAdapter';

// Phase 5 §6 items 3+5 / MOBILE_APP.md §9.2: one-tap export from the main
// screen, plus a non-modal staleness nudge ("N writes / D days since your
// last export") — export is the only backup this app has (no git, no cloud
// sync, §9 item 3 of MOBILE_APP.md), so the nudge's whole job is to keep
// that backup from going stale unnoticed. Renders in the app header, next
// to the tabs, so it's visible from every screen — not buried in settings.

// Thresholds are a product judgment call the plan explicitly leaves open
// (MOBILE_APP.md §10: "how much export friction is acceptable... tunable
// after the app exists"). Picked to match the worked example in §9.2 itself
// ("23 entries since your last export") without being noisy on a
// lightly-used install.
const WRITES_THRESHOLD = 10;
const DAYS_THRESHOLD = 7;

function shouldNudge(nudge) {
  if (!nudge) return false;
  if (nudge.writesSinceExport >= WRITES_THRESHOLD) return true;
  if (nudge.daysSinceExport != null && nudge.daysSinceExport >= DAYS_THRESHOLD) return true;
  // Never exported at all, but the journal has real activity — still worth
  // a nudge even before the write-count threshold, since "no backup exists
  // yet" is the worst case §9.2 warns about.
  if (nudge.daysSinceExport == null && nudge.writesSinceExport > 0) return true;
  return false;
}

function nudgeText(nudge) {
  const parts = [];
  if (nudge.writesSinceExport > 0) {
    parts.push(`${nudge.writesSinceExport} ${nudge.writesSinceExport === 1 ? 'entry' : 'entries'}`);
  }
  if (nudge.daysSinceExport != null) {
    parts.push(`${nudge.daysSinceExport} ${nudge.daysSinceExport === 1 ? 'day' : 'days'}`);
  }
  const joined = parts.join(' / ') || 'some activity';
  return nudge.daysSinceExport == null
    ? `No export yet — ${joined} since you started.`
    : `${joined} since your last export.`;
}

export default function ExportBar({ onUndo }) {
  const [nudge, setNudge] = useState(null);
  const [undo, setUndo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const refresh = async () => {
    try {
      const [n, u] = await Promise.all([api.getExportNudge(), api.peekUndo()]);
      setNudge(n);
      setUndo(u);
    } catch {
      // export nudge / undo availability are soft features — a failure here shouldn't block the app
    }
  };

  useEffect(() => {
    if (!isLocalEngine) return; // httpApi has no undo/export-nudge concept — desktop keeps its own git history
    refresh();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  if (!isLocalEngine) return null;

  // Two separate files rather than one combined zip, so each is exactly what
  // the matching ImportScreen step takes on a fresh install: the .ledger for
  // "Choose .ledger file", the settings .zip for the optional config step.
  const doExport = async (kind) => {
    setMenuOpen(false);
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === 'journal') {
        const bytes = await api.exportJournal('manual export');
        await shareBytes(bytes, `ledger-${stamp}.ledger`, 'text/plain');
        setNote('Journal exported.');
      } else {
        const bytes = await api.exportConfig();
        await shareBytes(bytes, `ledger-settings-${stamp}.zip`);
        setNote('Settings exported.');
      }
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const doUndo = async () => {
    if (!confirm(`Undo "${undo.message.replace(/^dashboard: /, '')}"?`)) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await api.undoLastWrite();
      if (result.ok) {
        setNote('Undone.');
        onUndo?.(); // let the current view reload so it reflects the reverted journal
      }
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="export-bar">
      {nudge && shouldNudge(nudge) && <span className="export-nudge">{nudgeText(nudge)}</span>}
      {note && <span className="export-note">{note}</span>}
      {error && <span className="export-note export-note-error">{error}</span>}
      {undo && (
        <button className="btn btn-small" onClick={doUndo} disabled={busy} title={undo.message}>
          Undo
        </button>
      )}
      <span className="export-menu-wrap" ref={menuRef}>
        <button
          className="btn btn-small btn-primary"
          onClick={() => setMenuOpen((o) => !o)}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          {busy ? 'Exporting…' : 'Export ▾'}
        </button>
        {menuOpen && (
          <div className="export-menu" role="menu">
            <button className="export-menu-item" role="menuitem" onClick={() => doExport('journal')}>
              <span>Journal</span>
              <span className="export-menu-hint">.ledger — your transactions</span>
            </button>
            <button className="export-menu-item" role="menuitem" onClick={() => doExport('config')}>
              <span>Settings</span>
              <span className="export-menu-hint">.zip — analyses, automations, budgets, currency</span>
            </button>
          </div>
        )}
      </span>
    </div>
  );
}
