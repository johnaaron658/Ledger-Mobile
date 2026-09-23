import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import FuzzyCombobox from './FuzzyCombobox';

const PERIOD_LABELS = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannually: 'Semi-annually',
  yearly: 'Yearly',
  custom: 'Custom',
};

const CUSTOM_UNIT_LABELS = {
  days: 'Days',
  weeks: 'Weeks',
  months: 'Months',
  years: 'Years',
};

function periodLabel(automation) {
  if (automation.period !== 'custom') return PERIOD_LABELS[automation.period];
  const n = automation.custom_interval ?? 1;
  const unit = CUSTOM_UNIT_LABELS[automation.custom_unit]?.toLowerCase() ?? 'months';
  return `Every ${n} ${n === 1 ? unit.replace(/s$/, '') : unit}`;
}

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
  return {
    name: '',
    period: 'monthly',
    custom_interval: 1,
    custom_unit: 'months',
    start_date: todayHtml(),
    end_date: '',
    template: '',
    variable_defaults: {},
  };
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
        custom_interval: form.period === 'custom' ? Math.max(1, Number(form.custom_interval) || 1) : null,
        custom_unit: form.period === 'custom' ? form.custom_unit : null,
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
        {form.period === 'custom' && (
          <div className="form-row">
            <label>Every</label>
            <div className="automation-custom-period">
              <input
                type="number"
                min={1}
                value={form.custom_interval}
                onChange={set('custom_interval')}
                required
              />
              <select value={form.custom_unit} onChange={set('custom_unit')}>
                {Object.entries(CUSTOM_UNIT_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
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

const COLLAPSED_GROUPS_KEY = 'automations.collapsedGroups';
const UNGROUPED_KEY = '__ungrouped__';

/** Touch-compatible drag-and-drop (§6 item 6, MOBILE_APP.md §6: "drag-to-
 * reorder groups needs a touch DnD library"). Built on Pointer Events rather
 * than the HTML5 Drag and Drop API the previous implementation used: HTML5
 * DnD is mouse-only in practice — it does not fire from touch input in
 * WKWebView (iOS) and is unreliable on Android WebView too — while Pointer
 * Events unify mouse, touch and pen and both platforms' webviews support
 * them. Drop targets are found via `document.elementFromPoint` against
 * `data-dnd-type`/`data-dnd-id`/`data-dnd-group` attributes on each
 * draggable/droppable element (see AutomationCard/GroupSection below),
 * rather than the DOM event's own target, since a touch drag's "pointer"
 * stays associated with whatever element it started on.
 *
 * UNVERIFIED ON A TOUCHSCREEN — see MOBILE_APP_IMPLEMENTATION.md's Phase 5
 * writeup. Pointer Events are cross-platform per spec and this was
 * exercised with a mouse during development (mouse is also a pointer type),
 * but a real finger's contact-area/jitter characteristics differ enough
 * from a mouse that this needs a device pass before trusting it.
 */
function usePointerDnD({ onDropAutomation, onDropGroup }) {
  const [dragging, setDragging] = useState(null); // { type: 'automation'|'group', id }
  const [over, setOver] = useState(null); // { type, id } | null
  const draggingRef = useRef(null); // mirrors `dragging` for listeners added outside React's render cycle

  // Group-section containers wrap their own automation cards, so a plain
  // "closest [data-dnd-*]" search would find the nested card first even
  // when dragging a *group* — groups only care about other groups as drop
  // targets, so a group drag searches specifically for a group ancestor.
  const findTarget = (x, y, dragType) => {
    const el = document.elementFromPoint(x, y);
    const selector = dragType === 'group' ? '[data-dnd-type="group"][data-dnd-id]' : '[data-dnd-type][data-dnd-id]';
    const node = el?.closest(selector);
    if (!node) return null;
    return { type: node.getAttribute('data-dnd-type'), id: node.getAttribute('data-dnd-id'), group: node.getAttribute('data-dnd-group') };
  };

  const endDrag = (target) => {
    const current = draggingRef.current;
    draggingRef.current = null;
    setDragging(null);
    setOver(null);
    if (!current || !target) return;
    if (current.type === 'automation') {
      if (target.type === 'automation' && target.id !== current.id) {
        onDropAutomation(current.id, target.group === UNGROUPED_KEY ? null : target.group, target.id);
      } else if (target.type === 'group') {
        onDropAutomation(current.id, target.id === UNGROUPED_KEY ? null : target.id, null);
      }
    } else if (current.type === 'group') {
      if (target.type === 'group' && target.id !== current.id && target.id !== UNGROUPED_KEY) {
        onDropGroup(current.id, target.id);
      }
    }
  };

  const startDrag = (type, id) => (e) => {
    if (e.button != null && e.button !== 0) return; // ignore non-primary mouse buttons
    e.preventDefault();
    const info = { type, id };
    draggingRef.current = info;
    setDragging(info);

    const move = (ev) => {
      if (!draggingRef.current) return;
      ev.preventDefault();
      setOver(findTarget(ev.clientX, ev.clientY, type));
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      endDrag(findTarget(ev.clientX, ev.clientY, type));
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /** Props for the small grab-handle element on a draggable item.
   * `touch-action: none` (see .dnd-handle in App.css) is what stops the
   * browser from treating the gesture as a page scroll before the drag
   * logic above gets a chance to. */
  const handleProps = (type, id) => ({
    onPointerDown: startDrag(type, id),
    className: 'dnd-handle' + (dragging?.type === type && dragging?.id === id ? ' dnd-dragging' : ''),
  });

  /** Data-dnd-* attributes for the droppable container itself (an
   * automation card or a group section) — findTarget() above reads these
   * back via elementFromPoint().closest(). Callers combine this with their
   * own className (see isOverTarget) rather than this hook owning
   * className, since each container already computes its own class string. */
  const dropTargetProps = (type, id, group) => ({
    'data-dnd-type': type,
    'data-dnd-id': id,
    ...(group !== undefined ? { 'data-dnd-group': group } : {}),
  });

  const isOverTarget = (type, id) => over?.type === type && over?.id === id;

  return { handleProps, dropTargetProps, isOverTarget, isDragging: !!dragging };
}

function loadCollapsedGroups() {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(set) {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...set]));
  } catch {
    // ignore (e.g. private browsing)
  }
}

function AutomationCard({ automation, onEdit, onDelete, dnd }) {
  const groupKey = automation.group_id ?? UNGROUPED_KEY;
  return (
    <div
      className={'panel automation-card' + (dnd.isOverTarget('automation', automation.id) ? ' automation-drop-target' : '')}
      style={{ padding: 14 }}
      {...dnd.dropTargetProps('automation', automation.id, groupKey)}
    >
      <div className="automation-card-header">
        <span {...dnd.handleProps('automation', automation.id)} title="Drag to reorder or move to another group">
          ⠿
        </span>
        <h3>{automation.name}</h3>
        <span className="muted">{periodLabel(automation)}</span>
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

function GroupSection({
  group,
  automations,
  onEdit,
  onDelete,
  onRename,
  onDeleteGroup,
  hideHeader,
  collapsed,
  onToggleCollapsed,
  dnd,
}) {
  const [nameDraft, setNameDraft] = useState(group?.name ?? '');

  const isUngrouped = group === null;
  const groupKey = isUngrouped ? UNGROUPED_KEY : group.id;

  // Keep the input in sync when the group's name changes from elsewhere (e.g. a reload).
  useEffect(() => {
    setNameDraft(group?.name ?? '');
  }, [group?.id, group?.name]);

  // Debounced persist, so typing feels instant without firing a request per keystroke.
  useEffect(() => {
    if (isUngrouped) return;
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === group.name) return;
    const handle = setTimeout(() => onRename(group.id, trimmed), 500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameDraft]);

  return (
    <div
      className={'automation-group' + (dnd.isOverTarget('group', groupKey) ? ' automation-drop-target' : '')}
      {...dnd.dropTargetProps('group', groupKey)}
    >
      {!hideHeader && (
        <div className="automation-group-header">
          {!isUngrouped && (
            <span {...dnd.handleProps('group', groupKey)} title="Drag to reorder groups">
              ⠿
            </span>
          )}
          <button
            type="button"
            className="automation-group-collapse-btn"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand group' : 'Collapse group'}
            aria-expanded={!collapsed}
          >
            <span className={'automation-group-chevron' + (collapsed ? ' collapsed' : '')}>▾</span>
          </button>
          {isUngrouped ? (
            <h3>Ungrouped</h3>
          ) : (
            <input
              type="text"
              className="automation-group-name-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur();
              }}
            />
          )}
          {collapsed && <span className="muted">({automations.length})</span>}
          {!isUngrouped && (
            <button className="btn btn-small btn-danger" onClick={() => onDeleteGroup(group.id)}>
              Delete group
            </button>
          )}
        </div>
      )}
      {!collapsed && (
        <div className="automation-grid">
          {automations.map((a) => (
            <AutomationCard key={a.id} automation={a} onEdit={onEdit} onDelete={onDelete} dnd={dnd} />
          ))}
          {automations.length === 0 && <p className="muted">Drag automations here.</p>}
        </div>
      )}
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
  const [groups, setGroups] = useState([]);
  const [pending, setPending] = useState([]);
  const [accountNames, setAccountNames] = useState([]);
  const [payees, setPayees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState(loadCollapsedGroups);

  const toggleGroupCollapsed = (key) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedGroups(next);
      return next;
    });
  };

  const load = async () => {
    setError(null);
    try {
      const [autos, grps, pend, names, txns] = await Promise.all([
        api.getAutomations(),
        api.getAutomationGroups(),
        api.getPendingAutomations(),
        api.getAccountNames(),
        api.getTransactions(),
      ]);
      setAutomationsList(autos);
      setGroups(grps);
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

  const handleCreateGroup = async () => {
    try {
      await api.createAutomationGroup('New Group');
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleRenameGroup = async (id, name) => {
    try {
      await api.renameAutomationGroup(id, name);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDeleteGroup = async (id) => {
    if (!confirm('Delete this group? Its automations will become ungrouped.')) return;
    try {
      await api.deleteAutomationGroup(id);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDragAutomation = async (automationId, groupId, beforeId) => {
    try {
      await api.moveAutomation(automationId, { groupId, beforeId });
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDragGroup = async (draggedGroupId, targetGroupId) => {
    const order = groups.map((g) => g.id);
    const from = order.indexOf(draggedGroupId);
    if (from === -1) return;
    order.splice(from, 1);
    const to = order.indexOf(targetGroupId);
    order.splice(to, 0, draggedGroupId);
    try {
      await api.reorderAutomationGroups(order);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const dnd = usePointerDnD({ onDropAutomation: handleDragAutomation, onDropGroup: handleDragGroup });

  if (loading) return <p>Loading…</p>;

  const automationsByGroup = new Map(groups.map((g) => [g.id, []]));
  const ungrouped = [];
  for (const a of automationsList) {
    if (a.group_id && automationsByGroup.has(a.group_id)) automationsByGroup.get(a.group_id).push(a);
    else ungrouped.push(a);
  }

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
        <button className="btn" onClick={handleCreateGroup}>
          + New group
        </button>
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
                  custom_interval: editing.custom_interval ?? 1,
                  custom_unit: editing.custom_unit ?? 'months',
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

      {groups.map((g) => (
        <GroupSection
          key={g.id}
          group={g}
          automations={automationsByGroup.get(g.id) ?? []}
          onEdit={(auto) => {
            setEditing(auto);
            setShowForm(true);
          }}
          onDelete={handleDelete}
          onRename={handleRenameGroup}
          onDeleteGroup={handleDeleteGroup}
          collapsed={collapsedGroups.has(g.id)}
          onToggleCollapsed={() => toggleGroupCollapsed(g.id)}
          dnd={dnd}
        />
      ))}

      {(groups.length > 0 || ungrouped.length > 0) && (
        <GroupSection
          group={null}
          automations={ungrouped}
          onEdit={(auto) => {
            setEditing(auto);
            setShowForm(true);
          }}
          onDelete={handleDelete}
          hideHeader={groups.length === 0}
          collapsed={collapsedGroups.has(UNGROUPED_KEY)}
          onToggleCollapsed={() => toggleGroupCollapsed(UNGROUPED_KEY)}
          dnd={dnd}
        />
      )}

      {automationsList.length === 0 && groups.length === 0 && <p className="muted">No automations yet.</p>}
    </div>
  );
}
