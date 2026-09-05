import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { api } from '../api';
import { formatPhp } from '../format';
import { parseLedger, formatLedger } from '../dateUtils';
import TransactionForm from './TransactionForm';
import DateRangeSlider from './DateRangeSlider';

function todayLedger() {
  return formatLedger(new Date());
}

function AccountNode({ node, depth, selected, onSelect }) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;

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
        <span className="money">{formatPhp(node.balance_php)}</span>
      </div>
      {open && hasChildren && (
        <div className="account-node-children">
          {node.children.map((c) => (
            <AccountNode key={c.full_name} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
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

  const load = async () => {
    setLoading(true);
    try {
      const [t, txns, names] = await Promise.all([
        api.getAccounts(),
        api.getTransactions(),
        api.getAccountNames(),
      ]);
      setTree(t);
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
      if (editing && editing !== 'new') {
        await api.editTransaction({ ...payload, file: editing.file, beg_line: editing.beg_line, end_line: editing.end_line });
      } else {
        await api.addTransaction(payload);
      }
      setEditing(null);
      await refreshAfterSave();
      setNote('Saved.');
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
    if (editing && editing !== 'new') deleteTransaction(editing);
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
                    <Tooltip formatter={(v) => formatPhp(v)} labelFormatter={(l, p) => `${l}${p?.[0]?.payload?.payee ? ` — ${p[0].payload.payee}` : ''}`} />
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
            <table>
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

      <div className="panel account-tree" style={{ padding: '8px 12px' }}>
        {tree.children.map((c) => (
          <AccountNode key={c.full_name} node={c} depth={0} selected={selected} onSelect={setSelected} />
        ))}
      </div>

      {editing && (
        <TransactionForm
          initial={editing === 'new' ? null : editing}
          initialDate={editing === 'new' ? selectedDate : undefined}
          accountNames={accountNames}
          payees={payees}
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
