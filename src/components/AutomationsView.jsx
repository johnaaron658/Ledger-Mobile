import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import FuzzyCombobox from './FuzzyCombobox';

const PERIOD_LABELS = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannually: 'Semi-annually',
  yearly: 'Yearly',
};

const VAR_RE = /\$\[(\w+)\]/g;

function extractVariables(template) {
  const seen = [];
  for (const m of template.matchAll(VAR_RE)) {
    if (m[1] !== 'date' && !seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

function renderTemplate(template, occurrenceDate, variables) {
  let text = template.replaceAll('$[date]', occurrenceDate);
  for (const name of extractVariables(template)) {
    text = text.replaceAll(`$[${name}]`, variables[name] ?? '');
  }
  return text;
}

function toHtmlDate(ledgerDate) {
  return ledgerDate ? ledgerDate.replaceAll('/', '-') : '';
}
function toLedgerDate(htmlDate) {
  return htmlDate ? htmlDate.replaceAll('-', '/') : '';
}
function todayHtml() {
  return new Date().toISOString().slice(0, 10);
}

const TEMPLATE_PLACEHOLDER = '$[date] $[payee]\n    Expenses:Rent    $[amount]\n    $[account]';

function emptyForm() {
  return { name: '', period: 'monthly', start_date: todayHtml(), end_date: '', template: '', variable_defaults: {} };
}

function VariableValueInput({ name, value, onChange, accountNames, payees }) {
  if (name === 'account') {
    return <FuzzyCombobox value={value} onChange={onChange} options={accountNames} placeholder="Account" />;
  }
  if (name === 'payee') {
    return <FuzzyCombobox value={value} onChange={onChange} options={payees} placeholder="Payee" />;
  }
  return <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />;
}

function AutomationForm({ initial, accountNames, payees, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const [defaults, setDefaults] = useState(initial.variable_defaults ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const setDefault = (name) => (val) => setDefaults((d) => ({ ...d, [name]: val }));

  const variableNames = useMemo(() => extractVariables(form.template), [form.template]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: form.name.trim(),
        period: form.period,
        start_date: toLedgerDate(form.start_date),
        end_date: form.end_date ? toLedgerDate(form.end_date) : null,
        template: form.template,
        variable_defaults: Object.fromEntries(variableNames.map((n) => [n, defaults[n] ?? ''])),
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="panel automation-form" onSubmit={submit} style={{ padding: 16, marginBottom: 20 }}>
      {error && <div className="error-banner">{error}</div>}
      <div className="automation-form-row">
        <div className="form-row">
          <label>Name</label>
          <input type="text" value={form.name} onChange={set('name')} required />
        </div>
        <div className="form-row">
          <label>Period</label>
          <select value={form.period} onChange={set('period')}>
            {Object.entries(PERIOD_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="automation-form-row">
        <div className="form-row">
          <label>Start date</label>
          <input type="date" value={form.start_date} onChange={set('start_date')} required />
        </div>
        <div className="form-row">
          <label>End date (optional)</label>
          <input type="date" value={form.end_date} onChange={set('end_date')} />
        </div>
      </div>
      <div className="form-row">
        <label>Transaction template</label>
        <textarea
          className="automation-template-input"
          rows={5}
          value={form.template}
          onChange={set('template')}
          placeholder={TEMPLATE_PLACEHOLDER}
          required
        />
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
        Use <code>$[date]</code> for the occurrence date. <code>$[account]</code> and <code>$[payee]</code>{' '}
        are reserved — they show up as fuzzy-searchable dropdowns. <code>$[running_balance(ACCOUNT)]</code>{' '}
        and <code>$[running_budget(ACCOUNT)]</code> are also reserved — no form field, always computed
        live as of the occurrence date (account balance, and that budget's month-to-date remaining
        amount). Any other <code>$[name]</code> (e.g. <code>$[amount]</code>) becomes a plain text field
        when reviewing each pending occurrence.
      </p>

      {variableNames.length > 0 && (
        <div className="form-row">
          <label>Default values (optional, pre-fills the review form)</label>
          <div className="automation-form-row">
            {variableNames.map((name) => (
              <div className="form-row" key={name}>
                <label>{name}</label>
                <VariableValueInput
                  name={name}
                  value={defaults[name] ?? ''}
                  onChange={setDefault(name)}
                  accountNames={accountNames}
                  payees={payees}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AutomationCard({ automation, onEdit, onDelete }) {
  return (
    <div className="panel automation-card" style={{ padding: 14 }}>
      <div className="automation-card-header">
        <h3>{automation.name}</h3>
        <span className="muted">{PERIOD_LABELS[automation.period]}</span>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        {automation.start_date}
        {automation.end_date ? ` – ${automation.end_date}` : ' – ongoing'}
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        Next due: {automation.next_due ?? 'none (ended)'}
      </div>
      {automation.variables.length > 0 && (
        <div className="muted" style={{ fontSize: 13 }}>
          Variables: {automation.variables.join(', ')}
        </div>
      )}
      <pre className="automation-template-preview">{automation.template}</pre>
      <div className="toolbar" style={{ marginTop: 4, marginBottom: 0 }}>
        <button className="btn btn-small" onClick={() => onEdit(automation)}>
          Edit
        </button>
        <button className="btn btn-small btn-danger" onClick={() => onDelete(automation.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}

function PendingCard({ entry, accountNames, payees, onApprove, onSkip }) {
  const [values, setValues] = useState(entry.variables ?? {});
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Instant client-side guess (can't resolve $[running_balance(...)] etc.), replaced by the
  // authoritative server render below once it comes back.
  const [preview, setPreview] = useState(() => renderTemplate(entry.template, entry.occurrence_date, values));
  const [previewLoading, setPreviewLoading] = useState(true);

  const variableNames = useMemo(() => extractVariables(entry.template), [entry.template]);

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    const handle = setTimeout(async () => {
      try {
        const { rendered } = await api.previewPendingAutomation(entry.id, values);
        if (!cancelled) setPreview(rendered);
      } catch {
        // keep the last good preview; the error will surface when they try to approve
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [entry.id, values]);

  const setValue = (name) => (val) => setValues((v) => ({ ...v, [name]: val }));

  const enterRawMode = () => {
    setRawText(preview);
    setRawMode(true);
  };

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      if (rawMode) {
        await onApprove(entry.id, { renderedOverride: rawText });
      } else {
        await onApprove(entry.id, { variables: values });
      }
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const skip = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSkip(entry.id);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="panel automation-card" style={{ padding: 14 }}>
      <div className="automation-card-header">
        <h3>{entry.automation_name}</h3>
        <span className="muted">{entry.occurrence_date}</span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {rawMode ? (
        <textarea
          className="automation-template-input"
          rows={5}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
        />
      ) : (
        <>
          {variableNames.map((name) => (
            <div className="form-row" key={name}>
              <label>{name}</label>
              <VariableValueInput
                name={name}
                value={values[name] ?? ''}
                onChange={setValue(name)}
                accountNames={accountNames}
                payees={payees}
              />
            </div>
          ))}
          <pre className={'automation-template-preview' + (previewLoading ? ' automation-preview-loading' : '')}>
            {preview}
          </pre>
        </>
      )}

      <div className="toolbar" style={{ marginTop: 4, marginBottom: 0 }}>
        <button className="btn btn-small btn-primary" onClick={approve} disabled={busy}>
          {busy ? 'Working…' : 'Approve & post'}
        </button>
        <button className="btn btn-small" onClick={skip} disabled={busy}>
          Skip
        </button>
        {!rawMode && (
          <button type="button" className="btn btn-small" onClick={enterRawMode} disabled={busy}>
            Edit raw text
          </button>
        )}
      </div>
    </div>
  );
}

export default function AutomationsView() {
  const [automationsList, setAutomationsList] = useState([]);
  const [pending, setPending] = useState([]);
  const [accountNames, setAccountNames] = useState([]);
  const [payees, setPayees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [autos, pend, names, txns] = await Promise.all([
        api.getAutomations(),
        api.getPendingAutomations(),
        api.getAccountNames(),
        api.getTransactions(),
      ]);
      setAutomationsList(autos);
      setPending(pend);
      setAccountNames(names);
      const counts = new Map();
      for (const t of txns) counts.set(t.payee, (counts.get(t.payee) ?? 0) + 1);
      setPayees([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async (payload) => {
    if (editing?.id) {
      await api.updateAutomation(editing.id, payload);
    } else {
      await api.createAutomation(payload);
    }
    setShowForm(false);
    setEditing(null);
    setNote('Saved.');
    await load();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this automation? Its pending occurrences will be removed too.')) return;
    try {
      await api.deleteAutomation(id);
      setNote('Deleted.');
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleApprove = async (id, payload) => {
    await api.approvePendingAutomation(id, payload);
    setNote('Posted to journal.');
    await load();
  };

  const handleSkip = async (id) => {
    await api.skipPendingAutomation(id);
    await load();
  };

  if (loading) return <p>Loading…</p>;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {note && <div className="note-banner">{note}</div>}

      {pending.length > 0 && (
        <>
          <h2 className="section-heading">Pending review ({pending.length})</h2>
          <div className="automation-grid">
            {pending.map((entry) => (
              <PendingCard
                key={`${entry.id}:${entry.refreshed_at ?? entry.created_at}`}
                entry={entry}
                accountNames={accountNames}
                payees={payees}
                onApprove={handleApprove}
                onSkip={handleSkip}
              />
            ))}
          </div>
        </>
      )}

      <div className="toolbar">
        <h2 className="section-heading" style={{ flex: 1, marginBottom: 0 }}>
          Automations
        </h2>
        {!showForm && (
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            + New automation
          </button>
        )}
      </div>

      {showForm && (
        <AutomationForm
          accountNames={accountNames}
          payees={payees}
          initial={
            editing
              ? {
                  name: editing.name,
                  period: editing.period,
                  start_date: toHtmlDate(editing.start_date),
                  end_date: toHtmlDate(editing.end_date ?? ''),
                  template: editing.template,
                  variable_defaults: editing.variable_defaults ?? {},
                }
              : emptyForm()
          }
          onSave={handleSave}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      <div className="automation-grid">
        {automationsList.map((a) => (
          <AutomationCard
            key={a.id}
            automation={a}
            onEdit={(auto) => {
              setEditing(auto);
              setShowForm(true);
            }}
            onDelete={handleDelete}
          />
        ))}
        {automationsList.length === 0 && <p className="muted">No automations yet.</p>}
      </div>
    </div>
  );
}
