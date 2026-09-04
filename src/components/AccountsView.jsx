import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { api } from '../api';
import { formatPhp } from '../format';

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

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        setTree(await api.getAccounts());
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected) return;
    (async () => {
      setHistoryLoading(true);
      try {
        setHistory(await api.getAccountHistory(selected));
      } catch (e) {
        setError(e.message);
      } finally {
        setHistoryLoading(false);
      }
    })();
  }, [selected]);

  if (loading) return <p>Loading…</p>;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      {selected && (
        <div className="panel" style={{ padding: 16, marginBottom: 20 }}>
          <h3 style={{ marginBottom: 10 }}>{selected}</h3>
          {historyLoading ? (
            <p className="muted">Loading history…</p>
          ) : history.length === 0 ? (
            <p className="muted">No postings for this account.</p>
          ) : (
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => formatPhp(v)} labelFormatter={(l, p) => `${l} — ${p?.[0]?.payload?.payee ?? ''}`} />
                  <Line type="stepAfter" dataKey="running_balance" stroke="#7c3aed" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      <div className="panel account-tree" style={{ padding: '8px 12px' }}>
        {tree.children.map((c) => (
          <AccountNode key={c.full_name} node={c} depth={0} selected={selected} onSelect={setSelected} />
        ))}
      </div>
    </div>
  );
}
