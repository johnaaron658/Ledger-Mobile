import { useEffect, useMemo, useState } from 'react';
import Fuse from 'fuse.js';
import { api } from '../api';
import TransactionForm from './TransactionForm';

export default function TransactionsView() {
  const [transactions, setTransactions] = useState([]);
  const [accountNames, setAccountNames] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | transaction object
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [note, setNote] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [txns, names] = await Promise.all([api.getTransactions(), api.getAccountNames()]);
      setTransactions(txns);
      setAccountNames(names);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

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
    if (!query.trim()) return sortedByDateDesc(transactions);
    return sortedByDateDesc(fuse.search(query).map((r) => r.item));
  }, [query, transactions, fuse]);

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
        <input
          className="search-input"
          placeholder="Fuzzy search payee or account…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + Add transaction
        </button>
      </div>
      <div className="panel">
        {loading ? (
          <p style={{ padding: 16 }}>Loading…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Payee</th>
                <th>Postings</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={`${t.file}:${t.beg_line}`}>
                  <td>{t.date}</td>
                  <td>{t.payee}</td>
                  <td>
                    <div className="postings-list">
                      {t.postings.map((p, i) => (
                        <div className="posting-line" key={i}>
                          <span>{p.account}</span>
                          <span className="money">{p.amount_raw}</span>
                        </div>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-small" onClick={() => setEditing(t)}>
                        Edit
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted" style={{ padding: 16 }}>
                    No transactions match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <TransactionForm
          initial={editing === 'new' ? null : editing}
          accountNames={accountNames}
          payees={payees}
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
