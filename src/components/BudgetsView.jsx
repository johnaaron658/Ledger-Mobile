import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from 'recharts';
import { api } from '../api';
import { formatPhp } from '../format';
import FuzzyCombobox from './FuzzyCombobox';

function BudgetCard({ b, onSave }) {
  const [editingAmount, setEditingAmount] = useState(false);
  const [amount, setAmount] = useState(b.budgeted ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const pct = b.budgeted ? Math.min(100, (b.spent / b.budgeted) * 100) : 0;
  const over = b.budgeted !== null && b.spent > b.budgeted;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(b.account, `₱${amount}`);
      setEditingAmount(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="budget-card">
      <h3>{b.account.replace(/^Expenses:/, '')}</h3>
      <div className="muted" style={{ fontSize: 12 }}>{b.active_period ?? 'No active budget'}</div>

      {b.budgeted !== null ? (
        <>
          <div className="budget-bar-track">
            <div className={`budget-bar-fill${over ? ' over' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="budget-numbers">
            <span>{formatPhp(b.spent)} spent</span>
            <span className={over ? '' : 'muted'}>
              {over ? `${formatPhp(b.spent - b.budgeted)} over` : `${formatPhp(b.remaining)} left`}
            </span>
          </div>
        </>
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>
          Spent this month: {formatPhp(b.spent)} (no numeric budget set)
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {b.editable ? (
        editingAmount ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              style={{ flex: 1, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
            <button className="btn btn-small btn-primary" onClick={save} disabled={saving}>
              Save
            </button>
            <button className="btn btn-small" onClick={() => setEditingAmount(false)} disabled={saving}>
              ✕
            </button>
          </div>
        ) : (
          <button className="btn btn-small" onClick={() => setEditingAmount(true)}>
            Edit budget
          </button>
        )
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>Formula-based, edit in budgets.ledger</div>
      )}
    </div>
  );
}

export default function BudgetsView() {
  const [budgets, setBudgets] = useState([]);
  const [accountNames, setAccountNames] = useState([]);
  const [excludedAccounts, setExcludedAccounts] = useState([]);
  const [excludeInput, setExcludeInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [budgetsData, names, settings] = await Promise.all([
        api.getBudgets(),
        api.getAccountNames(),
        api.getBudgetSettings(),
      ]);
      setBudgets(budgetsData);
      setAccountNames(names);
      setExcludedAccounts(settings.excluded_accounts);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async (account, amountRaw) => {
    await api.updateBudget(account, amountRaw);
    await load();
  };

  const addExcludedAccount = async (account) => {
    if (excludedAccounts.includes(account)) return;
    const next = [...excludedAccounts, account];
    setExcludedAccounts(next);
    setExcludeInput('');
    await api.updateBudgetSettings({ excluded_accounts: next });
    await load();
  };

  const removeExcludedAccount = async (account) => {
    const next = excludedAccounts.filter((a) => a !== account);
    setExcludedAccounts(next);
    await api.updateBudgetSettings({ excluded_accounts: next });
    await load();
  };

  const chartData = budgets
    .filter((b) => b.budgeted !== null)
    .map((b) => ({
      name: b.account.replace(/^Expenses:/, ''),
      Budgeted: b.budgeted,
      Spent: b.spent,
    }));

  if (loading) return <p>Loading…</p>;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      <div className="exclude-row">
        <span className="muted" style={{ fontSize: 13 }}>
          Exclude from spent totals (e.g. clearing accounts like a cash wallet):
        </span>
        <div style={{ width: 260 }}>
          <FuzzyCombobox
            value={excludeInput}
            onChange={(v) => {
              setExcludeInput(v);
              if (accountNames.includes(v)) addExcludedAccount(v);
            }}
            options={accountNames}
            placeholder="Search account…"
          />
        </div>
        <div className="exclude-chips">
          {excludedAccounts.map((a) => (
            <span className="assigned-chip" key={a}>
              {a}
              <button onClick={() => removeExcludedAccount(a)}>✕</button>
            </span>
          ))}
        </div>
      </div>

      <div className="panel" style={{ padding: 16, marginBottom: 20, height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 60 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="name" angle={-40} textAnchor="end" interval={0} height={80} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => formatPhp(v)} />
            <Legend />
            <Bar dataKey="Budgeted" fill="#a78bfa" radius={[4, 4, 0, 0]} />
            <Bar dataKey="Spent" fill="#7c3aed" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="budget-grid">
        {budgets.map((b) => (
          <BudgetCard key={b.account} b={b} onSave={handleSave} />
        ))}
      </div>
    </div>
  );
}
