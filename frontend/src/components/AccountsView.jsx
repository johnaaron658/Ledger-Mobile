import { useEffect, useMemo, useState } from 'react';
import Fuse from 'fuse.js';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { api } from '../api';
import { formatMoney } from '../format';
import { parseLedger, formatLedger } from '../dateUtils';
import TransactionForm from './TransactionForm';
import DateRangeSlider from './DateRangeSlider';
import TruncateStart from './TruncateStart';

function todayLedger() {
  return formatLedger(new Date());
}

function AccountNode({ node, depth, selected, onSelect, expandAll, collapseSignal }) {
  // Phase 5 §6 item 6 (MOBILE_APP.md §6: "tree needs collapsing by
  // default"): every level starts collapsed, not just depth >= 1 — a deep
  // chart of accounts is a lot of vertical scroll on a phone before you've
  // even picked one. `collapseSignal` bumps (a changing number, not a
  // boolean, since a plain flag can't re-trigger an already-false state) to
  // force every node back closed via the toolbar's "Collapse all" button.
  const [open, setOpen] = useState(false);
  const hasChildren = node.children.length > 0;

  useEffect(() => {
    if (expandAll) setOpen(true);
  }, [expandAll]);

  useEffect(() => {
    if (collapseSignal) setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseSignal]);

  return (
    <div className="account-node">
      <div
        className="account-node-row"
        style={{ paddingLeft: depth * 16, fontWeight: selected === node.full_name ? 600 : 400 }}
        onClick={() => onSelect(node.full_name)}
      >
        <span
          className="disclosure"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setOpen((o) => !o);
          }}
        >
          {hasChildren ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="account-name">{node.name}</span>
        <span className="money">{formatMoney(node.balance_php)}</span>
      </div>
      {open && hasChildren && (
        <div className="account-node-children">
          {node.children.map((c) => (
            <AccountNode
              key={c.full_name}
              node={c}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              expandAll={expandAll}
              collapseSignal={collapseSignal}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AccountsView() {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [accountFilter, setAccountFilter] = useState('');
  // Phase 5 §6 item 6: manual "Expand all / Collapse all" toggle, on top of
  // the tree's new collapsed-by-default state and the existing
  // search-driven auto-expand. `collapseSignal` is a bumped counter (see
  // AccountNode) rather than a boolean because forcing already-open nodes
  // shut needs an edge to react to, not just a false prop value.
  const [forceExpandAll, setForceExpandAll] = useState(false);
  const [collapseSignal, setCollapseSignal] = useState(0);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [startDate, setStartDate] = useState(null);
  const [endDate, setEndDate] = useState(null);
  const [granularity, setGranularity] = useState('months');
  const [selectedDate, setSelectedDate] = useState(null);

  const [transactions, setTransactions] = useState([]);
  const [accountNames, setAccountNames] = useState([]);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [note, setNote] = useState(null);
  const [defaultCurrency, setDefaultCurrency] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [t, txns, names, settings] = await Promise.all([
        api.getAccounts(),
        api.getTransactions(),
        api.getAccountNames(),
        api.getAppSettings(),
      ]);
      setTree(t);
      setTransactions(txns);
      setAccountNames(names);
      setDefaultCurrency(settings.default_currency);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!selected) return;
    setSelectedDate(null);
    (async () => {
      setHistoryLoading(true);
      try {
        const h = await api.getAccountHistory(selected);
        setHistory(h);
        const today = todayLedger();
        if (h.length) {
          setStartDate(h[0].date);
          setEndDate(h[h.length - 1].date > today ? h[h.length - 1].date : today);
        } else {
          setStartDate(null);
          setEndDate(null);
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setHistoryLoading(false);
      }
    })();
  }, [selected]);

  const allAccountFullNames = useMemo(() => {
    if (!tree) return [];
    const names = [];
    const walk = (node) => {
      for (const c of node.children) {
        names.push(c.full_name);
        walk(c);
      }
    };
    walk(tree);
    return names;
  }, [tree]);

  const accountFuse = useMemo(
    () => new Fuse(allAccountFullNames, { threshold: 0.4, ignoreLocation: true }),
    [allAccountFullNames]
  );

  const filteredTree = useMemo(() => {
    if (!tree || !accountFilter.trim()) return tree;
    const matched = new Set(accountFuse.search(accountFilter).map((r) => r.item));
    const filterNode = (node) => {
      const children = node.children.map(filterNode).filter(Boolean);
      if (matched.has(node.full_name) || children.length > 0) {
        return { ...node, children };
      }
      return null;
    };
    return { ...tree, children: tree.children.map(filterNode).filter(Boolean) };
  }, [tree, accountFilter, accountFuse]);

  const payees = useMemo(() => {
    const counts = new Map();
    for (const t of transactions) {
      counts.set(t.payee, (counts.get(t.payee) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }, [transactions]);

  const dateBounds = useMemo(() => {
    if (!history.length) return null;
    const today = todayLedger();
    const last = history[history.length - 1].date;
    return { min: history[0].date, max: last > today ? last : today };
  }, [history]);

  // Focuses the chart on [startDate, endDate] while preserving the running
  // balance at both edges: an anchor point carries forward the balance from
  // before the window so the line doesn't jump, and the window's last known
  // balance is held flat out to the end date.
  const displayedHistory = useMemo(() => {
    if (!history.length || !startDate || !endDate) return history;
    const startD = parseLedger(startDate);
    const endD = parseLedger(endDate);

    let carriedBalance = null;
    const within = [];
    for (const h of history) {
      const d = parseLedger(h.date);
      if (d < startD) {
        carriedBalance = h.running_balance;
      } else if (d <= endD) {
        within.push(h);
      }
    }

    if (within.length === 0) {
      const flat = carriedBalance ?? 0;
      return [
        { date: startDate, running_balance: flat, payee: null },
        { date: endDate, running_balance: flat, payee: null },
      ];
    }

    const points = [...within];
    if (points[0].date !== startDate) {
      points.unshift({ date: startDate, running_balance: carriedBalance ?? 0, payee: null });
    }
    if (points[points.length - 1].date !== endDate) {
      points.push({ date: endDate, running_balance: points[points.length - 1].running_balance, payee: null });
    }
    return points;
  }, [history, startDate, endDate]);

  const handleChartClick = (e) => {
    const idx = e?.activeIndex ?? e?.activeTooltipIndex;
    const point = idx != null ? displayedHistory[idx] : null;
    if (point?.date) setSelectedDate(point.date);
  };

  // Postings for `selected` can span multiple transactions on the same date,
  // so a click opens the full list rather than jumping straight to one edit form.
  const dateTransactions = useMemo(() => {
    if (!selectedDate) return [];
    const keys = new Set(
      history.filter((h) => h.date === selectedDate && h.file && h.beg_line != null).map((h) => `${h.file}:${h.beg_line}`)
    );
    return transactions.filter((t) => keys.has(`${t.file}:${t.beg_line}`));
  }, [history, transactions, selectedDate]);

  const refreshAfterSave = async () => {
    const [t, txns] = await Promise.all([api.getAccounts(), api.getTransactions()]);
    setTree(t);
    setTransactions(txns);
    if (selected) setHistory(await api.getAccountHistory(selected));
  };

  const handleSave = async (payload) => {
    setSaving(true);
    setFormError(null);
    try {
      if (editing && typeof editing === 'object') {
        await api.editTransaction({ ...payload, file: editing.file, beg_line: editing.beg_line, end_line: editing.end_line });
      } else {
        await api.addTransaction(payload);
      }
      setEditing(null);
      await refreshAfterSave();
      setNote(editing === 'new-account' ? 'Account created.' : 'Saved.');
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteTransaction = async (txn) => {
    if (!confirm(`Delete "${txn.payee}"?`)) return;
    setSaving(true);
    setFormError(null);
    try {
      await api.deleteTransaction({ file: txn.file, beg_line: txn.beg_line, end_line: txn.end_line });
      if (editing && editing !== 'new' && editing.file === txn.file && editing.beg_line === txn.beg_line) setEditing(null);
      await refreshAfterSave();
      setNote('Deleted.');
    } catch (e) {
      if (editing && editing !== 'new' && editing.file === txn.file && editing.beg_line === txn.beg_line) {
        setFormError(e.message);
      } else {
        setError(e.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleModalDelete = () => {
    if (editing && typeof editing === 'object') deleteTransaction(editing);
  };

  if (loading) return <p>Loading…</p>;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {note && <div className="note-banner">{note}</div>}

      {selected && (
        <div className="panel" style={{ padding: 16, marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 10px' }}>{selected}</h3>
          {historyLoading ? (
            <p className="muted">Loading history…</p>
          ) : history.length === 0 ? (
            <p className="muted">No postings for this account.</p>
          ) : (
            <>
              {dateBounds && (
                <DateRangeSlider
                  minDate={dateBounds.min}
                  maxDate={dateBounds.max}
                  startDate={startDate}
                  endDate={endDate}
                  granularity={granularity}
                  onGranularityChange={setGranularity}
                  onChange={(from, to) => {
                    setStartDate(from);
                    setEndDate(to);
                  }}
                />
              )}
              <div style={{ height: 260, userSelect: 'none', marginTop: 10 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={displayedHistory} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} onClick={handleChartClick}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => formatMoney(v)} labelFormatter={(l, p) => `${l}${p?.[0]?.payload?.payee ? ` — ${p[0].payload.payee}` : ''}`} />
                    <Line
                      type="stepAfter"
                      dataKey="running_balance"
                      stroke="#7c3aed"
                      dot={false}
                      strokeWidth={2}
                      activeDot={{ r: 5, style: { cursor: 'pointer' } }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                Click a point to see postings on that date
              </p>
            </>
          )}
        </div>
      )}

      {selectedDate && (
        <div className="panel breakdown-panel">
          <div className="breakdown-header">
            <div className="breakdown-title">
              <strong>{selectedDate}</strong>
            </div>
            <button className="btn btn-small" onClick={() => setSelectedDate(null)}>
              ✕
            </button>
          </div>
          {dateTransactions.length === 0 ? (
            <p className="muted">No postings on this date.</p>
          ) : (
            <table className="responsive-table">
              <thead>
                <tr>
                  <th>Payee</th>
                  <th>Postings</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {dateTransactions.map((t) => (
                  <tr key={`${t.file}:${t.beg_line}`}>
                    <td data-label="Payee">{t.payee}</td>
                    <td data-label="Postings">
                      <div className="postings-list">
                        {t.postings.map((p, i) => (
                          <div className="posting-line" key={i}>
                            <TruncateStart text={p.account} />
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
                        <button className="btn btn-small btn-danger" onClick={() => deleteTransaction(t)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-small" onClick={() => setEditing('new')}>
              + Add posting
            </button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <input
          className="search-input"
          placeholder="Fuzzy search accounts…"
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
        />
        <button
          className="btn btn-small"
          onClick={() => {
            if (forceExpandAll) setCollapseSignal((n) => n + 1);
            setForceExpandAll((v) => !v);
          }}
        >
          {forceExpandAll ? 'Collapse all' : 'Expand all'}
        </button>
        <button className="btn btn-primary" onClick={() => setEditing('new-account')}>
          + New account
        </button>
      </div>

      <div className="panel account-tree" style={{ padding: '8px 12px' }}>
        {filteredTree.children.length === 0 ? (
          <p className="muted">No accounts match "{accountFilter}".</p>
        ) : (
          filteredTree.children.map((c) => (
            <AccountNode
              key={c.full_name}
              node={c}
              depth={0}
              selected={selected}
              onSelect={setSelected}
              expandAll={!!accountFilter.trim() || forceExpandAll}
              collapseSignal={collapseSignal}
            />
          ))
        )}
      </div>

      {editing && (
        <TransactionForm
          initial={typeof editing === 'object' ? editing : null}
          initialDate={editing === 'new' ? selectedDate : undefined}
          initialPayee={editing === 'new-account' ? 'Starting Balance' : undefined}
          initialPostings={
            editing === 'new-account'
              ? [{ account: '', amount_raw: defaultCurrency }, { account: 'Equity:Starting Balance', amount_raw: '' }]
              : undefined
          }
          title={editing === 'new-account' ? 'New account' : undefined}
          accountNames={accountNames}
          payees={payees}
          defaultCurrency={defaultCurrency}
          onSave={handleSave}
          onClose={() => {
            setEditing(null);
            setFormError(null);
          }}
          onDelete={handleModalDelete}
          saving={saving}
          error={formError}
        />
      )}
    </div>
  );
}
