import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatPhp } from '../format';
import FuzzyCombobox from './FuzzyCombobox';

function SummaryStats({ title, budgeted, spent, over, pct }) {
  return (
    <div style={{ flex: '1 1 320px', minWidth: 280 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', gap: 32, marginBottom: 12 }}>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Budgeted</div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{formatPhp(budgeted)}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Spent</div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{formatPhp(spent)}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>{over ? 'Over' : 'Remaining'}</div>
          <div style={{ fontSize: 22, fontWeight: 600, color: over ? 'var(--danger)' : 'var(--accent)' }}>
            {formatPhp(Math.abs(budgeted - spent))}
          </div>
        </div>
      </div>
      <div className="budget-bar-track" style={{ height: 12 }}>
        <div className={`budget-bar-fill${over ? ' over' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const PERIOD_LABELS = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  semiannually: 'Every 6 months',
  yearly: 'Yearly',
  custom: 'Custom',
};

const CUSTOM_UNIT_LABELS = {
  days: 'Days',
  weeks: 'Weeks',
  months: 'Months',
  years: 'Years',
};

function toLedgerDate(htmlDate) {
  return htmlDate ? htmlDate.replaceAll('-', '/') : '';
}
function todayHtml() {
  return new Date().toISOString().slice(0, 10);
}

function periodPhrase(period, customInterval, customUnit) {
  if (period !== 'custom') return PERIOD_LABELS[period];
  const n = Math.max(1, Number(customInterval) || 1);
  return `Every ${n} ${customUnit}`;
}

// Reverse of periodPhrase, so editing a category defaults to its own cadence.
function inferPeriod(lastPeriodText) {
  const freqMatch = lastPeriodText ? lastPeriodText.match(/^(.*?)\s+(?:from|in)\s+/i) : null;
  const freq = (freqMatch ? freqMatch[1] : 'Monthly').trim().toLowerCase();
  for (const [key, label] of Object.entries(PERIOD_LABELS)) {
    if (key !== 'custom' && label.toLowerCase() === freq) return { period: key, custom_interval: 1, custom_unit: 'months' };
  }
  const everyMatch = freq.match(/^every\s+(\d+)\s+(day|week|month|year)s?$/);
  if (everyMatch) {
    const unit = `${everyMatch[2]}s`;
    return { period: 'custom', custom_interval: Number(everyMatch[1]), custom_unit: unit };
  }
  return { period: 'monthly', custom_interval: 1, custom_unit: 'months' };
}

function BudgetCard({ b, onSave, defaultCurrency }) {
  const [editingPeriod, setEditingPeriod] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [period, setPeriod] = useState('monthly');
  const [customInterval, setCustomInterval] = useState(1);
  const [customUnit, setCustomUnit] = useState('months');
  const [startDate, setStartDate] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const envelope = b.envelope;
  const pct = envelope && envelope.budgeted > 0 ? Math.min(100, (envelope.spent / envelope.budgeted) * 100) : 0;
  const over = envelope !== null && envelope !== undefined && envelope.spent > envelope.budgeted;

  const startEditing = () => {
    const last = b.history[b.history.length - 1];
    const inferred = inferPeriod(last?.period_text);
    setPeriod(inferred.period);
    setCustomInterval(inferred.custom_interval);
    setCustomUnit(inferred.custom_unit);
    setStartDate(todayHtml());
    setAmount(b.budgeted ?? '');
    setError(null);
    setEditingPeriod(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const periodText = `${periodPhrase(period, customInterval, customUnit)} from ${toLedgerDate(startDate)}`;
      await onSave(b.account, periodText, `${defaultCurrency}${amount}`);
      setEditingPeriod(false);
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

      {envelope ? (
        <>
          <div className="budget-bar-track">
            <div className={`budget-bar-fill${over ? ' over' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="budget-numbers">
            <span className={over ? '' : 'muted'}>
              {over
                ? `${formatPhp(envelope.spent - envelope.budgeted)} over`
                : `${formatPhp(envelope.remaining)} left of ${formatPhp(envelope.budgeted)}`}
            </span>
          </div>
          <div className="budget-numbers">
            <span>
              {`Budgeted amount: ${formatPhp(amount)}`}
            </span>
          </div>
        </>
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>
          Spent this month: {formatPhp(b.spent)} (no active budget)
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {editingPeriod ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="form-row">
            <label>Period</label>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} autoFocus>
              {Object.entries(PERIOD_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {period === 'custom' && (
            <div className="form-row">
              <label>Every</label>
              <div className="automation-custom-period">
                <input
                  type="number"
                  min={1}
                  value={customInterval}
                  onChange={(e) => setCustomInterval(e.target.value)}
                />
                <select value={customUnit} onChange={(e) => setCustomUnit(e.target.value)}>
                  {Object.entries(CUSTOM_UNIT_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <div className="form-row">
            <label>Start date</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="form-row">
            <label>Amount</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-small btn-primary" onClick={save} disabled={saving}>
              Save
            </button>
            <button className="btn btn-small" onClick={() => setEditingPeriod(false)} disabled={saving}>
              ✕
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-small" onClick={startEditing}>
            Edit budget
          </button>
          <button className="btn btn-small" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide history' : `History (${b.history.length})`}
          </button>
        </div>
      )}

      {showHistory && !editingPeriod && (
        <ul className="budget-history-list">
          {[...b.history].reverse().map((h, i) => (
            <li key={i} className={h.is_active ? 'budget-history-active' : ''}>
              <span>{h.period_text}</span>
              <span>{h.amount_raw}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewBudgetForm({ accountNames, defaultCurrency, onCreate, onCancel }) {
  const [account, setAccount] = useState('');
  const [period, setPeriod] = useState('monthly');
  const [customInterval, setCustomInterval] = useState(1);
  const [customUnit, setCustomUnit] = useState('months');
  const [startDate, setStartDate] = useState(todayHtml());
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    if (!account.trim() || !amount.trim()) {
      setError('Account and amount are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const periodText = `${periodPhrase(period, customInterval, customUnit)} from ${toLedgerDate(startDate)}`;
      await onCreate(account.trim(), periodText, `${defaultCurrency}${amount}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="budget-card">
      <h3>New budget</h3>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="form-row">
          <label>Account</label>
          <FuzzyCombobox value={account} onChange={setAccount} options={accountNames} placeholder="Account" />
        </div>
        <div className="form-row">
          <label>Period</label>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} autoFocus>
            {Object.entries(PERIOD_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {period === 'custom' && (
          <div className="form-row">
            <label>Every</label>
            <div className="automation-custom-period">
              <input
                type="number"
                min={1}
                value={customInterval}
                onChange={(e) => setCustomInterval(e.target.value)}
              />
              <select value={customUnit} onChange={(e) => setCustomUnit(e.target.value)}>
                {Object.entries(CUSTOM_UNIT_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div className="form-row">
          <label>Start date</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Amount</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-small btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Create'}
          </button>
          <button className="btn btn-small" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BudgetsView() {
  const [budgets, setBudgets] = useState([]);
  const [accountNames, setAccountNames] = useState([]);
  const [excludedAccounts, setExcludedAccounts] = useState([]);
  const [excludeInput, setExcludeInput] = useState('');
  const [defaultCurrency, setDefaultCurrency] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [addingBudget, setAddingBudget] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [budgetsData, names, settings, appSettings] = await Promise.all([
        api.getBudgets(),
        api.getAccountNames(),
        api.getBudgetSettings(),
        api.getAppSettings(),
      ]);
      setBudgets(budgetsData);
      setAccountNames(names);
      setExcludedAccounts(settings.excluded_accounts);
      setDefaultCurrency(appSettings.default_currency);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async (account, periodText, amountRaw) => {
    await api.addBudgetPeriod(account, periodText, amountRaw);
    await load();
  };

  const handleCreate = async (account, periodText, amountRaw) => {
    await api.createBudget(account, periodText, amountRaw);
    setAddingBudget(false);
    await load();
  };

  const budgetedAccounts = new Set(budgets.map((b) => b.account));
  const newBudgetAccountNames = accountNames.filter((a) => !budgetedAccounts.has(a));

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

  const totals = budgets.reduce(
    (acc, b) => {
      if (b.envelope) {
        acc.budgeted += b.envelope.budgeted;
        acc.spent += b.envelope.spent;
      }
      return acc;
    },
    { budgeted: 0, spent: 0 }
  );
  const totalOver = totals.spent > totals.budgeted;
  const totalPct = totals.budgeted > 0 ? Math.min(100, (totals.spent / totals.budgeted) * 100) : 0;

  const monthTotals = budgets.reduce(
    (acc, b) => {
      if (b.budgeted !== null) {
        acc.budgeted += b.budgeted;
        acc.spent += b.spent;
      }
      return acc;
    },
    { budgeted: 0, spent: 0 }
  );
  const monthOver = monthTotals.spent > monthTotals.budgeted;
  const monthPct = monthTotals.budgeted > 0 ? Math.min(100, (monthTotals.spent / monthTotals.budgeted) * 100) : 0;

  if (loading) return <p>Loading…</p>;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setAddingBudget(true)} disabled={addingBudget}>
          + New budget
        </button>
      </div>

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

      <div className="panel" style={{ padding: 16, marginBottom: 20, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <SummaryStats title="This month" budgeted={monthTotals.budgeted} spent={monthTotals.spent} over={monthOver} pct={monthPct} />
      </div>

      <div className="budget-grid">
        {addingBudget && (
          <NewBudgetForm
            accountNames={newBudgetAccountNames}
            defaultCurrency={defaultCurrency}
            onCreate={handleCreate}
            onCancel={() => setAddingBudget(false)}
          />
        )}
        {budgets.map((b) => (
          <BudgetCard key={b.account} b={b} onSave={handleSave} defaultCurrency={defaultCurrency} />
        ))}
      </div>
    </div>
  );
}
