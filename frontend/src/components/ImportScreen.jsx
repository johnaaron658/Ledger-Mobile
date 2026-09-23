import { useState } from 'react';
import { api } from '../api';
import { pickBinaryFile, pickTextFile } from '../capacitorAdapter';

// §5.4's first-run import flow, built and debugged in the browser (Phase 4).
// Phase 5 (§6 item 2) swaps the raw <input type="file"> for
// capacitorAdapter's pickTextFile/pickBinaryFile, which open the platform
// document picker natively and fall back to the same kind of hidden
// <input type="file"> in a plain browser — see capacitorAdapter.js's header.
// The rest of this flow (validate before persist, confirmation summary,
// config bundle, re-import confirm) is unchanged from Phase 4.
// Renders in place of the six tabs whenever api.hasJournal() resolves false
// — see App.jsx.

function ImportErrors({ errors }) {
  return (
    <div className="error-banner">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>This file can't be imported:</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {errors.map((e, i) => (
          <li key={i}>
            {e.line != null ? `Line ${e.line}: ` : ''}
            {e.message}
            {e.text ? <code style={{ display: 'block', opacity: 0.8 }}>{e.text}</code> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfigStep({ onDone }) {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [mode, setMode] = useState('merge');

  const pick = async () => {
    setImporting(true);
    setError(null);
    try {
      const picked = await pickBinaryFile({ types: ['application/zip'] });
      if (!picked) return; // user canceled the picker
      const res = await api.importConfig(picked.bytes, mode);
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginTop: 16 }}>
      <h3>Import settings backup (optional)</h3>
      <p className="muted">
        A previously exported settings bundle (saved analyses, automations, budget view, currency) —
        skip this if you don't have one.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {result && (
        <div className="note-banner">
          {result.applied.length > 0 && <div>Applied: {result.applied.join(', ')}</div>}
          {result.skipped.length > 0 && (
            <div>
              Skipped: {result.skipped.map((s) => `${s.file} (${s.reason})`).join('; ')}
            </div>
          )}
          {result.applied.length === 0 && result.skipped.length === 0 && <div>Nothing to import.</div>}
        </div>
      )}
      <div className="form-row">
        <label>On conflict</label>
        <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={importing}>
          <option value="merge">Merge (keep both, bundle wins on id conflict)</option>
          <option value="replace">Replace (bundle overwrites entirely)</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button className="btn" onClick={pick} disabled={importing}>
          {importing ? 'Importing…' : 'Choose backup .zip'}
        </button>
        <button className="btn btn-primary" onClick={onDone} disabled={importing}>
          Continue to dashboard
        </button>
      </div>
    </div>
  );
}

export default function ImportScreen({ onImported }) {
  const [preview, setPreview] = useState(null); // { file, text, result }
  const [committed, setCommitted] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const pickJournal = async () => {
    setError(null);
    try {
      const picked = await pickTextFile({ types: ['text/plain', 'application/octet-stream'] });
      if (!picked) return; // user canceled the picker
      const result = api.previewJournal(picked.text);
      setPreview({ name: picked.name, text: picked.text, result });
    } catch (err) {
      setError(err.message);
    }
  };

  const confirmImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.importJournal(preview.text);
      if (!result.ok) {
        setPreview({ ...preview, result });
        return;
      }
      setCommitted(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const startNew = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.startNewJournal();
      setCommitted(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (committed) {
    return (
      <div className="import-screen">
        <div className="note-banner">Journal imported.</div>
        <ConfigStep onDone={onImported} />
      </div>
    );
  }

  return (
    <div className="import-screen">
      <div className="panel" style={{ padding: 24 }}>
        <h3>Welcome — no journal yet</h3>
        <p className="muted">Import a consolidated `.ledger` file, or start a brand-new one.</p>
        {error && <div className="error-banner">{error}</div>}

        {preview?.result && !preview.result.ok && <ImportErrors errors={preview.result.errors ?? []} />}

        {preview?.result?.ok && (
          <div className="note-banner">
            {preview.result.counts.transactions.toLocaleString()} transactions
            {preview.result.counts.dateRange
              ? `, ${preview.result.counts.dateRange[0]} – ${preview.result.counts.dateRange[1]}`
              : ''}
            , {preview.result.counts.periodics} budget periods, {preview.result.counts.prices} prices.
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn" onClick={pickJournal} disabled={busy}>
            Choose .ledger file
          </button>
          {preview?.result?.ok && (
            <button className="btn btn-primary" onClick={confirmImport} disabled={busy}>
              {busy ? 'Importing…' : `Import "${preview.name}"`}
            </button>
          )}
          <button className="btn" onClick={startNew} disabled={busy}>
            Start a new journal instead
          </button>
        </div>
      </div>
    </div>
  );
}
