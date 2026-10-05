import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Fuse from 'fuse.js';
import { api } from '../api';
import { setCurrencySymbol } from '../format';
import TransactionForm from './TransactionForm';
import TruncateStart from './TruncateStart';
import { PencilIcon, Spinner } from './Icons';

// Rows rendered per "Show more" step. Rendering every transaction at once is
// the slowest thing this view does on a phone (thousands of <tr>s), and
// nobody scrolls that far without searching first.
const PAGE_SIZE = 100;

function splitDate(date) {
  // "2026/09/23" -> { md: "09/23", year: "2026" }
  const [year, month, day] = date.split('/');
  return day ? { md: `${month}/${day}`, year } : { md: date, year: '' };
}

const txnKey = (t) => `${t.file}:${t.beg_line}`;
const virtualKey = (v) => `virtual:${v.id}`;

// Whether the virtual table is expanded. A per-device convenience, so plain
// localStorage, guarded because it can throw in a private window.
const VIRTUAL_OPEN_KEY = 'ledger.virtualTxnsOpen';
function readVirtualOpen() {
  try {
    return localStorage.getItem(VIRTUAL_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeVirtualOpen(open) {
  try {
    localStorage.setItem(VIRTUAL_OPEN_KEY, open ? '1' : '0');
  } catch {
    // Private mode / blocked storage: the panel just won't remember.
  }
}

// Key of the transaction an add of {date, payee} just wrote. Adds append to
// the end of the file, so among same-date/payee matches it's the one with
// the highest beg_line.
function findAddedKey(txns, { date, payee }) {
  let found = null;
  for (const t of txns) {
    if (t.date === date && t.payee === payee && (!found || t.beg_line > found.beg_line)) found = t;
  }
  return found && txnKey(found);
}

// `revealAdded` ({date, payee}, or {virtualId} for a virtual one) is set by
// App after a Quick add so the new transaction is shown even when its date
// sorts it past the first page or the virtual table is collapsed.
export default function TransactionsView({ revealAdded, onRevealed }) {
  const [transactions, setTransactions] = useState([]);
  // null = the backend doesn't support virtual transactions (the desktop
  // one doesn't yet), which hides the table and the form's checkbox.
  const [virtualTxns, setVirtualTxns] = useState(null);
  const [virtualOpen, setVirtualOpen] = useState(readVirtualOpen);
  const [accountNames, setAccountNames] = useState([]);
  const [query, setQuery] = useState('');
  // The query the (expensive) fuzzy filter actually runs against. Lags
  // `query` by a short debounce and is applied in a transition, so typing
  // stays responsive and the spinner has a chance to paint before the
  // re-filter/re-render work starts.
  const [appliedQuery, setAppliedQuery] = useState('');
  const [isFiltering, startFiltering] = useTransition();
  const [shownCount, setShownCount] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | transaction object
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [note, setNote] = useState(null);
  const [defaultCurrency, setDefaultCurrency] = useState('');
  const [currencyInput, setCurrencyInput] = useState('');
  // Row to page to, scroll to and flash after a save. A backdated add sorts
  // below the first PAGE_SIZE rows, and without this it looked like the save
  // had silently failed.
  const [revealKey, setRevealKey] = useState(null);
  const revealRef = useRef(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [txns, names, settings, virtual] = await Promise.all([
        api.getTransactions(),
        api.getAccountNames(),
        api.getAppSettings(),
        api.getVirtualTransactions().catch(() => null),
      ]);
      setTransactions(txns);
      setVirtualTxns(virtual);
      setAccountNames(names);
      setDefaultCurrency(settings.default_currency);
      setCurrencyInput(settings.default_currency);
      return txns;
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const saveDefaultCurrency = async () => {
    const next = currencyInput.trim();
    setDefaultCurrency(next);
    setCurrencySymbol(next); // every view formats money with this
    await api.updateAppSettings({ default_currency: next });
  };

  useEffect(() => {
    load().then((txns) => {
      if (!txns || !revealAdded) return;
      if (revealAdded.virtualId) revealVirtual({ id: revealAdded.virtualId });
      else setRevealKey(findAddedKey(txns, revealAdded));
      onRevealed?.();
    });
    // Mount-only: App remounts this view (via `key`) after every Quick add.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (query === appliedQuery) return;
    const handle = setTimeout(() => {
      startFiltering(() => {
        setAppliedQuery(query);
        setShownCount(PAGE_SIZE);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [query, appliedQuery]);

  const searching = query !== appliedQuery || isFiltering;

  const fuse = useMemo(
    () =>
      new Fuse(transactions, {
        keys: ['payee', 'postings.account'],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [transactions]
  );

  const payees = useMemo(() => {
    const counts = new Map();
    for (const t of [...transactions, ...(virtualTxns ?? [])]) {
      counts.set(t.payee, (counts.get(t.payee) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }, [transactions, virtualTxns]);

  // Same search as the main table. There are few enough of these that a
  // fresh Fuse per change costs nothing.
  const visibleVirtual = useMemo(() => {
    const list = virtualTxns ?? [];
    if (!appliedQuery.trim()) return list;
    const virtualFuse = new Fuse(list, { keys: ['payee', 'postings.account'], threshold: 0.35, ignoreLocation: true });
    return virtualFuse.search(appliedQuery).map((r) => r.item);
  }, [appliedQuery, virtualTxns]);

  const toggleVirtualOpen = () => {
    setVirtualOpen((open) => {
      writeVirtualOpen(!open);
      return !open;
    });
  };

  const sortedByDateDesc = (list) => [...list].sort((a, b) => (a.date < b.date ? 1 : -1));

  const visible = useMemo(() => {
    if (!appliedQuery.trim()) return sortedByDateDesc(transactions);
    return sortedByDateDesc(fuse.search(appliedQuery).map((r) => r.item));
  }, [appliedQuery, transactions, fuse]);

  // Grow the page until the revealed row is rendered, then scroll to it.
  useEffect(() => {
    if (!revealKey) return;
    if (revealKey.startsWith('virtual:')) {
      if (!virtualOpen) return;
      revealRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const handle = setTimeout(() => setRevealKey(null), 2500);
      return () => clearTimeout(handle);
    }
    const idx = visible.findIndex((t) => txnKey(t) === revealKey);
    if (idx < 0) return;
    if (idx >= shownCount) {
      setShownCount(Math.ceil((idx + 1) / PAGE_SIZE) * PAGE_SIZE);
      return;
    }
    revealRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const handle = setTimeout(() => setRevealKey(null), 2500);
    return () => clearTimeout(handle);
  }, [revealKey, visible, shownCount, virtualOpen, virtualTxns]);

  // Reveals a virtual transaction, opening the collapsed table if needed.
  const revealVirtual = (v) => {
    if (!virtualOpen) {
      setVirtualOpen(true);
      writeVirtualOpen(true);
    }
    setRevealKey(virtualKey(v));
  };

  const handleSave = async (payload) => {
    setSaving(true);
    setFormError(null);
    try {
      const { virtual, ...txn } = payload;
      const isEdit = editing && editing !== 'new';
      const wasVirtual = isEdit && editing.virtual;
      const virtualIn = { payee: txn.payee, postings: txn.postings };
      const loc = isEdit && !wasVirtual ? { file: editing.file, beg_line: editing.beg_line, end_line: editing.end_line } : null;
      let savedVirtual = null;
      if (virtual) {
        if (wasVirtual) savedVirtual = await api.editVirtualTransaction({ id: editing.id, ...virtualIn });
        else if (isEdit) savedVirtual = await api.makeTransactionVirtual({ ...loc, ...virtualIn });
        else savedVirtual = await api.addVirtualTransaction(virtualIn);
      } else if (wasVirtual) {
        await api.postVirtualTransaction({ id: editing.id, ...txn });
      } else if (isEdit) {
        await api.editTransaction({ ...txn, ...loc });
      } else {
        await api.addTransaction(txn);
      }
      setEditing(null);
      const txns = await load();
      if (savedVirtual) revealVirtual(savedVirtual);
      // An edit replaces the block in place, so it keeps its beg_line.
      else if (txns) setRevealKey(isEdit && !wasVirtual ? txnKey(editing) : findAddedKey(txns, txn));
      setNote(virtual && !wasVirtual && isEdit ? 'Moved to virtual transactions.' : wasVirtual && !virtual ? 'Posted.' : 'Saved.');
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editing || editing === 'new') return;
    if (!confirm(`Delete "${editing.payee}"?`)) return;
    setSaving(true);
    setFormError(null);
    try {
      if (editing.virtual) await api.deleteVirtualTransaction(editing.id);
      else await api.deleteTransaction({ file: editing.file, beg_line: editing.beg_line, end_line: editing.end_line });
      setEditing(null);
      await load();
      setNote('Deleted.');
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {note && <div className="note-banner">{note}</div>}
      <div className="toolbar">
        <div className="search-wrap">
          <input
            className="search-input"
            placeholder="Fuzzy search payee or account…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching && (
            <span className="search-spinner">
              <Spinner label="Searching" />
            </span>
          )}
        </div>
      </div>
      <div className="toolbar">
        <span className="muted" style={{ fontSize: 13 }}>Default currency (auto-filled on amount fields):</span>
        <input
          style={{ width: 70, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
          value={currencyInput}
          onChange={(e) => setCurrencyInput(e.target.value)}
          onBlur={saveDefaultCurrency}
        />
      </div>
      {virtualTxns && virtualTxns.length > 0 && (
        <div className="panel txn-panel virtual-panel">
          <button
            type="button"
            className="virtual-panel-header"
            onClick={toggleVirtualOpen}
            aria-expanded={virtualOpen}
          >
            <span className={'automation-group-chevron' + (virtualOpen ? '' : ' collapsed')}>▾</span>
            <span className="virtual-panel-title">Virtual transactions</span>
            <span className="muted">
              {appliedQuery.trim() ? `${visibleVirtual.length} of ${virtualTxns.length}` : virtualTxns.length}
            </span>
          </button>
          {virtualOpen && (
            <table className="txn-table">
              <colgroup>
                <col className="txn-col-payee" />
                <col />
                <col className="txn-col-edit" />
              </colgroup>
              <thead>
                <tr>
                  <th>Payee</th>
                  <th>Postings</th>
                  <th aria-label="Edit"></th>
                </tr>
              </thead>
              <tbody>
                {visibleVirtual.map((v) => {
                  const revealed = virtualKey(v) === revealKey;
                  return (
                    <tr
                      key={v.id}
                      ref={revealed ? revealRef : undefined}
                      className={revealed ? 'txn-revealed' : undefined}
                    >
                      <td className="txn-payee">{v.payee}</td>
                      <td className="txn-postings">
                        {v.postings.map((p, i) => (
                          <div className="txn-posting" key={i}>
                            <TruncateStart text={p.account} className="txn-account" />
                            <span className="money txn-amount">{p.amount_raw}</span>
                          </div>
                        ))}
                      </td>
                      <td className="txn-edit">
                        <button
                          className="icon-btn"
                          onClick={() => setEditing({ ...v, virtual: true })}
                          aria-label={`Edit virtual ${v.payee}`}
                          title="Edit"
                        >
                          <PencilIcon />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {visibleVirtual.length === 0 && (
                  <tr>
                    <td colSpan={3} className="muted" style={{ padding: 16 }}>
                      No virtual transactions match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className={'panel txn-panel' + (loading || searching ? ' is-busy' : '')}>
        {(loading || searching) && <div className="progress-bar" aria-hidden="true" />}
        {loading && transactions.length === 0 ? (
          <p className="muted loading-line" style={{ padding: 16 }}>
            <Spinner /> Loading transactions…
          </p>
        ) : (
          <table className="txn-table">
            <colgroup>
              <col className="txn-col-date" />
              <col className="txn-col-payee" />
              <col />
              <col className="txn-col-edit" />
            </colgroup>
            <thead>
              <tr>
                <th>Date</th>
                <th>Payee</th>
                <th>Postings</th>
                <th aria-label="Edit"></th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, shownCount).map((t) => {
                const { md, year } = splitDate(t.date);
                const key = txnKey(t);
                const revealed = key === revealKey;
                return (
                  <tr key={key} ref={revealed ? revealRef : undefined} className={revealed ? 'txn-revealed' : undefined}>
                    <td className="txn-date">
                      <span>{md}</span>
                      <span className="txn-year">{year}</span>
                    </td>
                    <td className="txn-payee">{t.payee}</td>
                    <td className="txn-postings">
                      {t.postings.map((p, i) => (
                        <div className="txn-posting" key={i}>
                          <TruncateStart text={p.account} className="txn-account" />
                          <span className="money txn-amount">{p.amount_raw}</span>
                        </div>
                      ))}
                    </td>
                    <td className="txn-edit">
                      <button
                        className="icon-btn"
                        onClick={() => setEditing(t)}
                        aria-label={`Edit ${t.payee} on ${t.date}`}
                        title="Edit"
                      >
                        <PencilIcon />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && !searching && (
                <tr>
                  <td colSpan={4} className="muted" style={{ padding: 16 }}>
                    No transactions match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {visible.length > shownCount && (
          <div className="show-more">
            <span className="muted">
              Showing {shownCount} of {visible.length}
            </span>
            <button className="btn btn-small" onClick={() => setShownCount((n) => n + PAGE_SIZE)}>
              Show more
            </button>
          </div>
        )}
      </div>
      {editing && (
        <TransactionForm
          initial={editing === 'new' ? null : editing}
          title={editing !== 'new' && editing.virtual ? 'Edit virtual transaction' : undefined}
          allowVirtual={virtualTxns !== null}
          accountNames={accountNames}
          payees={payees}
          defaultCurrency={defaultCurrency}
          onSave={handleSave}
          onClose={() => {
            setEditing(null);
            setFormError(null);
          }}
          onDelete={handleDelete}
          saving={saving}
          error={formError}
        />
      )}
    </div>
  );
}
