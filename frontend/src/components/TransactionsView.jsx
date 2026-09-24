import { useEffect, useMemo, useState, useTransition } from 'react';
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

export default function TransactionsView() {
  const [transactions, setTransactions] = useState([]);
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

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [txns, names, settings] = await Promise.all([
        api.getTransactions(),
        api.getAccountNames(),
        api.getAppSettings(),
      ]);
      setTransactions(txns);
      setAccountNames(names);
      setDefaultCurrency(settings.default_currency);
      setCurrencyInput(settings.default_currency);
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
    load();
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
    for (const t of transactions) {
      counts.set(t.payee, (counts.get(t.payee) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }, [transactions]);

  const sortedByDateDesc = (list) => [...list].sort((a, b) => (a.date < b.date ? 1 : -1));

  const visible = useMemo(() => {
    if (!appliedQuery.trim()) return sortedByDateDesc(transactions);
    return sortedByDateDesc(fuse.search(appliedQuery).map((r) => r.item));
  }, [appliedQuery, transactions, fuse]);

  const handleSave = async (payload) => {
    setSaving(true);
    setFormError(null);
    try {
      if (editing && editing !== 'new') {
        await api.editTransaction({ ...payload, file: editing.file, beg_line: editing.beg_line, end_line: editing.end_line });
      } else {
        await api.addTransaction(payload);
      }
      setEditing(null);
      await load();
      setNote('Saved.');
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
      await api.deleteTransaction({ file: editing.file, beg_line: editing.beg_line, end_line: editing.end_line });
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
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + Add transaction
        </button>
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
                return (
                  <tr key={`${t.file}:${t.beg_line}`}>
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
