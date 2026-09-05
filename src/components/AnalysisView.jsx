import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Fuse from 'fuse.js';
import {
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../api';
import { formatPhp } from '../format';
import { labelFor, parseLedger } from '../dateUtils';
import FuzzyCombobox from './FuzzyCombobox';
import DateRangeSlider from './DateRangeSlider';

function toHtmlDate(ledgerDate) {
  return ledgerDate ? ledgerDate.replaceAll('/', '-') : '';
}
function toLedgerDate(htmlDate) {
  return htmlDate ? htmlDate.replaceAll('-', '/') : '';
}
function todayLedger() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
function monthStartLedger() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/01`;
}
function seriesColor(colorIndex) {
  return colorIndex === null ? 'var(--series-muted)' : `var(--series-${(colorIndex % 8) + 1})`;
}
function swatchStyle(colorIndex) {
  return { background: seriesColor(colorIndex) };
}
function formatPhpCompact(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}₱${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${sign}₱${(abs / 1000).toFixed(1)}k`;
  return `${sign}₱${abs.toFixed(0)}`;
}
function ClickableDot({ cx, cy, stroke, payload, dataKey, onPointClick, r = 4 }) {
  if (cx == null || cy == null) return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      fill={stroke}
      stroke="var(--bg)"
      strokeWidth={1}
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        onPointClick(dataKey, payload);
      }}
    />
  );
}

function CategoryCard({ cat, total, dragOver, onDragOver, onDragLeave, onDrop, onRename, onToggleHidden, onDelete, onUnassign, onChipDragStart }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const payeesRef = useRef(null);

  useLayoutEffect(() => {
    const el = payeesRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [cat.payees, expanded]);

  return (
    <div
      className={
        'category-card dropzone' + (dragOver ? ' drag-over' : '') + (cat.hidden ? ' category-card-hidden' : '')
      }
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="category-card-header">
        <span className="color-swatch" style={swatchStyle(cat.color_index)} />
        <input className="category-name-input" value={cat.name} onChange={(e) => onRename(e.target.value)} />
        <button className="btn btn-small" title={cat.hidden ? 'Show in charts' : 'Hide from charts'} onClick={onToggleHidden}>
          {cat.hidden ? 'Show' : 'Hide'}
        </button>
        <button className="btn btn-small" onClick={onDelete}>
          ✕
        </button>
      </div>
      <div className="category-total money">
        {formatPhp(total)}
        {cat.hidden && <span className="category-hidden-badge">hidden from charts</span>}
      </div>
      <div className={'category-payees' + (expanded ? ' expanded' : '')} ref={payeesRef}>
        {cat.payees.map((p) => (
          <span className="assigned-chip" key={p} draggable onDragStart={(e) => onChipDragStart(p, e)}>
            {p}
            <button onClick={() => onUnassign(p)}>✕</button>
          </span>
        ))}
      </div>
      {(overflowing || expanded) && (
        <button className="category-expand-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'See more'}
        </button>
      )}
    </div>
  );
}

export default function AnalysisView() {
  const [analysesList, setAnalysesList] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [name, setName] = useState('New Analysis');
  const [startDate, setStartDate] = useState(monthStartLedger());
  const [endDate, setEndDate] = useState(todayLedger());
  const [categories, setCategories] = useState([]);
  const [includeUncategorized, setIncludeUncategorized] = useState(true);
  const [excludedAccounts, setExcludedAccounts] = useState([]);
  const [excludeInput, setExcludeInput] = useState('');
  const [accountNames, setAccountNames] = useState([]);
  const [dateBounds, setDateBounds] = useState(null);
  const [granularity, setGranularity] = useState('months');
  const [computed, setComputed] = useState(null);
  const [series, setSeries] = useState(null);
  const [breakdown, setBreakdown] = useState(null);
  const [selectedPayees, setSelectedPayees] = useState(new Set());
  const [payeeSearch, setPayeeSearch] = useState('');
  const [lastClickedIndex, setLastClickedIndex] = useState(null);
  const [dragOverTarget, setDragOverTarget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const draggingRef = useRef(null);
  const breakdownRequestRef = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const [list, names, txns] = await Promise.all([
          api.getAnalyses(),
          api.getAccountNames(),
          api.getTransactions(),
        ]);
        setAnalysesList(list);
        setAccountNames(names);
        if (txns.length) {
          const today = todayLedger();
          const minTxnDate = txns.reduce((min, t) => (t.date < min ? t.date : min), txns[0].date);
          const maxTxnDate = txns.reduce((max, t) => (t.date > max ? t.date : max), txns[0].date);
          setDateBounds({ min: minTxnDate, max: maxTxnDate > today ? maxTxnDate : today });
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const addExcludedAccount = (account) => {
    setExcludedAccounts((prev) => (prev.includes(account) ? prev : [...prev, account]));
    setExcludeInput('');
  };

  const removeExcludedAccount = (account) => {
    setExcludedAccounts((prev) => prev.filter((a) => a !== account));
  };

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const result = await api.computeAnalysis({
          start_date: startDate,
          end_date: endDate,
          categories: categories.map(({ id, ...rest }) => rest),
          excluded_accounts: excludedAccounts,
        });
        if (!cancelled) setComputed(result);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [startDate, endDate, categories, excludedAccounts]);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const result = await api.computeAnalysisSeries({
          start_date: startDate,
          end_date: endDate,
          categories: categories.map(({ id, ...rest }) => rest),
          excluded_accounts: excludedAccounts,
          granularity,
        });
        if (!cancelled) setSeries(result);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [startDate, endDate, categories, excludedAccounts, granularity]);

  const hiddenCategoryNames = useMemo(
    () => new Set(categories.filter((c) => c.hidden).map((c) => c.name)),
    [categories]
  );
  const visibleCategories = useMemo(() => categories.filter((c) => !c.hidden), [categories]);

  const lineData = useMemo(() => {
    if (!series) return [];
    return series.periods.map((p, i) => {
      const row = { label: labelFor(parseLedger(p.start), granularity), periodStart: p.start, periodEnd: p.end };
      for (const cat of series.categories) {
        if (hiddenCategoryNames.has(cat.name)) continue;
        row[cat.name] = cat.values[i];
      }
      if (includeUncategorized) row['Uncategorized'] = series.uncategorized.values[i];
      return row;
    });
  }, [series, granularity, includeUncategorized, hiddenCategoryNames]);

  const assignedPayees = useMemo(() => new Set(categories.flatMap((c) => c.payees)), [categories]);
  const poolPayees = useMemo(
    () => (computed?.payees ?? []).filter((p) => !assignedPayees.has(p.name)),
    [computed, assignedPayees]
  );
  const poolPayeesFuse = useMemo(
    () => new Fuse(poolPayees, { keys: ['name'], threshold: 0.4, ignoreLocation: true }),
    [poolPayees]
  );
  const visiblePoolPayees = useMemo(
    () => (payeeSearch.trim() ? poolPayeesFuse.search(payeeSearch).map((r) => r.item) : poolPayees),
    [payeeSearch, poolPayeesFuse, poolPayees]
  );
  const catTotalByName = useMemo(
    () => new Map((computed?.categories ?? []).map((c) => [c.name, c.total])),
    [computed]
  );
  const pieData = useMemo(() => {
    const base = (computed?.categories ?? [])
      .filter((c) => c.total > 0 && !hiddenCategoryNames.has(c.name))
      .map((c) => ({ name: c.name, value: c.total, color_index: c.color_index }));
    if (includeUncategorized && computed?.uncategorized?.total > 0) {
      base.push({ name: 'Uncategorized', value: computed.uncategorized.total, color_index: null });
    }
    return base;
  }, [computed, includeUncategorized, hiddenCategoryNames]);

  const handleNew = () => {
    setCurrentId(null);
    setName('New Analysis');
    setStartDate(monthStartLedger());
    setEndDate(todayLedger());
    setCategories([]);
    setIncludeUncategorized(true);
    setExcludedAccounts([]);
    setExcludeInput('');
    setSelectedPayees(new Set());
  };

  const handleSelectChange = async (e) => {
    const id = e.target.value;
    if (!id) {
      handleNew();
      return;
    }
    setError(null);
    try {
      const a = await api.getAnalysis(id);
      setCurrentId(a.id);
      setName(a.name);
      setStartDate(a.start_date || monthStartLedger());
      setEndDate(a.end_date || todayLedger());
      setCategories(a.categories.map((c) => ({ ...c, id: `cat-${crypto.randomUUID()}` })));
      setIncludeUncategorized(a.include_uncategorized ?? true);
      setExcludedAccounts(a.excluded_accounts ?? []);
      setExcludeInput('');
      setSelectedPayees(new Set());
    } catch (e) {
      setError(e.message);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      name: name.trim() || 'Untitled',
      start_date: startDate,
      end_date: endDate,
      categories: categories.map(({ id, ...rest }) => rest),
      include_uncategorized: includeUncategorized,
      excluded_accounts: excludedAccounts,
    };
    try {
      if (currentId) {
        await api.updateAnalysis(currentId, payload);
      } else {
        const created = await api.createAnalysis(payload);
        setCurrentId(created.id);
      }
      setAnalysesList(await api.getAnalyses());
      setNote('Saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!currentId) return;
    if (!confirm(`Delete analysis "${name}"?`)) return;
    try {
      await api.deleteAnalysis(currentId);
      setAnalysesList(await api.getAnalyses());
      handleNew();
      setNote('Deleted.');
    } catch (e) {
      setError(e.message);
    }
  };

  const addCategory = () => {
    setCategories((prev) => [
      ...prev,
      { id: `cat-${crypto.randomUUID()}`, name: 'New Category', color_index: prev.length % 8, payees: [], hidden: false },
    ]);
  };

  const renameCategory = (id, newName) => {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, name: newName } : c)));
  };

  const toggleCategoryHidden = (id) => {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, hidden: !c.hidden } : c)));
  };

  const deleteCategory = (id) => {
    setCategories((prev) => prev.filter((c) => c.id !== id));
  };

  const unassign = (catId, payeeName) => {
    setCategories((prev) =>
      prev.map((c) => (c.id === catId ? { ...c, payees: c.payees.filter((p) => p !== payeeName) } : c))
    );
  };

  const handlePayeeClick = (name, index, e) => {
    if (e.shiftKey && lastClickedIndex !== null) {
      const [lo, hi] = [Math.min(lastClickedIndex, index), Math.max(lastClickedIndex, index)];
      setSelectedPayees(new Set(visiblePoolPayees.slice(lo, hi + 1).map((p) => p.name)));
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedPayees((prev) => {
        const next = new Set(prev);
        next.has(name) ? next.delete(name) : next.add(name);
        return next;
      });
      setLastClickedIndex(index);
    } else {
      setSelectedPayees(new Set([name]));
      setLastClickedIndex(index);
    }
  };

  const handleDragStart = (name, e) => {
    const payload = selectedPayees.has(name) ? Array.from(selectedPayees) : [name];
    draggingRef.current = payload;
    if (!selectedPayees.has(name)) setSelectedPayees(new Set([name]));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', payload.join(','));
  };

  const handleDropOnCategory = (catId, e) => {
    e.preventDefault();
    setDragOverTarget(null);
    const names = draggingRef.current;
    if (!names || !names.length) return;
    setCategories((prev) =>
      prev.map((c) => {
        if (c.id === catId) {
          return { ...c, payees: Array.from(new Set([...c.payees, ...names])) };
        }
        if (c.payees.some((p) => names.includes(p))) {
          return { ...c, payees: c.payees.filter((p) => !names.includes(p)) };
        }
        return c;
      })
    );
    draggingRef.current = null;
  };

  const handleDropOnPool = (e) => {
    e.preventDefault();
    setDragOverTarget(null);
    const names = draggingRef.current;
    if (!names || !names.length) return;
    setCategories((prev) => prev.map((c) => ({ ...c, payees: c.payees.filter((p) => !names.includes(p)) })));
    draggingRef.current = null;
  };

  const payeeNamesForCategory = (categoryName, result) => {
    if (categoryName === 'Uncategorized') return new Set(result?.uncategorized?.payees ?? []);
    const cat = categories.find((c) => c.name === categoryName);
    return new Set(cat?.payees ?? []);
  };

  const handlePieClick = (data) => {
    const info = data?.payload ?? data;
    if (!info || !computed) return;
    const names = payeeNamesForCategory(info.name, computed);
    const rows = (computed.payees ?? []).filter((p) => names.has(p.name));
    setBreakdown({
      source: 'pie',
      title: info.name,
      subtitle: `${labelFor(parseLedger(startDate), 'days')} – ${labelFor(parseLedger(endDate), 'days')}`,
      colorIndex: info.color_index,
      rows,
      loading: false,
    });
  };

  const handleLinePointClick = async (categoryName, rowPayload) => {
    if (!rowPayload) return;
    const cat = categories.find((c) => c.name === categoryName);
    const colorIndex = categoryName === 'Uncategorized' ? null : cat?.color_index ?? null;
    const requestId = ++breakdownRequestRef.current;
    setBreakdown({ source: 'line', title: categoryName, subtitle: rowPayload.label, colorIndex, rows: [], loading: true });
    try {
      const result = await api.computeAnalysis({
        start_date: rowPayload.periodStart,
        end_date: rowPayload.periodEnd,
        categories: categories.map(({ id, ...rest }) => rest),
        excluded_accounts: excludedAccounts,
      });
      if (breakdownRequestRef.current !== requestId) return;
      const names = payeeNamesForCategory(categoryName, result);
      const rows = (result.payees ?? []).filter((p) => names.has(p.name));
      setBreakdown({ source: 'line', title: categoryName, subtitle: rowPayload.label, colorIndex, rows, loading: false });
    } catch (e) {
      if (breakdownRequestRef.current !== requestId) return;
      setError(e.message);
      setBreakdown(null);
    }
  };

  if (loading) return <p>Loading…</p>;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {note && <div className="note-banner">{note}</div>}

      <div className="analysis-toolbar">
        <select value={currentId ?? ''} onChange={handleSelectChange}>
          <option value="">— New analysis —</option>
          {analysesList.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Analysis name" />
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {currentId && (
          <button className="btn btn-danger" onClick={handleDelete}>
            Delete
          </button>
        )}
        <button className="btn" onClick={handleNew}>
          New
        </button>
      </div>

      {dateBounds ? (
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
      ) : (
        <div className="period-row">
          <label>
            From{' '}
            <input type="date" value={toHtmlDate(startDate)} onChange={(e) => setStartDate(toLedgerDate(e.target.value))} />
          </label>
          <label>
            To <input type="date" value={toHtmlDate(endDate)} onChange={(e) => setEndDate(toLedgerDate(e.target.value))} />
          </label>
        </div>
      )}

      <div className="period-row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={includeUncategorized}
            onChange={(e) => setIncludeUncategorized(e.target.checked)}
          />
          Show Uncategorized slice
        </label>
      </div>

      <div className="exclude-row">
        <span className="muted" style={{ fontSize: 13 }}>
          Exclude from totals (e.g. clearing accounts like a cash wallet):
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

      <div className="analysis-charts-row">
      <div className="panel analysis-chart-panel" style={{ padding: 16 }}>
        <div className="chart-area">
        {pieData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                outerRadius={85}
                paddingAngle={2}
                stroke="var(--bg)"
                strokeWidth={2}
                onClick={handlePieClick}
              >
                {pieData.map((entry) => (
                  <Cell key={entry.name} fill={seriesColor(entry.color_index)} />
                ))}
              </Pie>
              <Legend />
              <Tooltip formatter={(v) => formatPhp(v)} />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <p className="muted">No categorized spend in this period yet — assign some payees below.</p>
        )}
        </div>
        {pieData.length > 0 && <p className="muted chart-hint">Click a slice to see which payees contributed to it.</p>}
      </div>

      <div className="panel analysis-line-panel" style={{ padding: 16 }}>
        <div className="chart-area">
        {visibleCategories.length > 0 && lineData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={lineData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis tick={{ fontSize: 12, fill: 'var(--text-muted)' }} tickFormatter={formatPhpCompact} width={64} />
              <Tooltip formatter={(v) => formatPhp(v)} />
              <Legend />
              {visibleCategories.map((cat) => (
                <Line
                  key={cat.id}
                  type="monotone"
                  dataKey={cat.name}
                  stroke={seriesColor(cat.color_index)}
                  strokeWidth={2}
                  dot={(dotProps) => (
                    <ClickableDot key={`dot-${cat.id}-${dotProps.index}`} {...dotProps} onPointClick={handleLinePointClick} />
                  )}
                  activeDot={(dotProps) => (
                    <ClickableDot key={`adot-${cat.id}-${dotProps.index}`} {...dotProps} r={6} onPointClick={handleLinePointClick} />
                  )}
                />
              ))}
              {includeUncategorized && (
                <Line
                  type="monotone"
                  dataKey="Uncategorized"
                  stroke={seriesColor(null)}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  dot={(dotProps) => (
                    <ClickableDot key={`dot-uncat-${dotProps.index}`} {...dotProps} onPointClick={handleLinePointClick} />
                  )}
                  activeDot={(dotProps) => (
                    <ClickableDot key={`adot-uncat-${dotProps.index}`} {...dotProps} r={6} onPointClick={handleLinePointClick} />
                  )}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="muted">
            {categories.length > 0
              ? 'All categories are hidden — unhide one below to see it here.'
              : 'Add categories below to see how they change over time.'}
          </p>
        )}
        </div>
        {lineData.length > 0 && visibleCategories.length > 0 && (
          <p className="muted chart-hint">Click a point to see which payees contributed to it.</p>
        )}
      </div>
      </div>

      {breakdown && (
        <div className="panel breakdown-panel">
          <div className="breakdown-header">
            <div className="breakdown-title">
              <span className="color-swatch" style={swatchStyle(breakdown.colorIndex)} />
              <strong>{breakdown.title}</strong>
              <span className="muted"> — {breakdown.subtitle}</span>
            </div>
            <button className="btn btn-small" onClick={() => setBreakdown(null)}>
              ✕
            </button>
          </div>
          {breakdown.loading ? (
            <p className="muted">Loading…</p>
          ) : breakdown.rows.length === 0 ? (
            <p className="muted">No payees contributed to this in this period.</p>
          ) : (
            <table className="breakdown-table">
              <tbody>
                {breakdown.rows.map((p) => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td className="money">{formatPhp(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="analysis-layout">
        <div
          className={'panel dropzone payee-pool' + (dragOverTarget === 'pool' ? ' drag-over' : '')}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverTarget('pool');
          }}
          onDragLeave={() => setDragOverTarget((t) => (t === 'pool' ? null : t))}
          onDrop={handleDropOnPool}
        >
          <div className="payee-pool-header">Payees ({poolPayees.length})</div>
          <input
            type="text"
            className="payee-search"
            placeholder="Search payees..."
            value={payeeSearch}
            onChange={(e) => setPayeeSearch(e.target.value)}
          />
          {visiblePoolPayees.map((p, i) => (
            <div
              key={p.name}
              className={'payee-chip' + (selectedPayees.has(p.name) ? ' selected' : '')}
              draggable
              onDragStart={(e) => handleDragStart(p.name, e)}
              onClick={(e) => handlePayeeClick(p.name, i, e)}
            >
              <span>{p.name}</span>
              <span className="money">{formatPhp(p.total)}</span>
            </div>
          ))}
          {poolPayees.length === 0 && <p className="muted" style={{ padding: 8 }}>All payees categorized.</p>}
          {poolPayees.length > 0 && visiblePoolPayees.length === 0 && (
            <p className="muted" style={{ padding: 8 }}>No payees match "{payeeSearch}".</p>
          )}
        </div>

        <div className="category-grid">
          {categories.map((cat) => (
            <CategoryCard
              key={cat.id}
              cat={cat}
              total={catTotalByName.get(cat.name) ?? 0}
              dragOver={dragOverTarget === cat.id}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverTarget(cat.id);
              }}
              onDragLeave={() => setDragOverTarget((t) => (t === cat.id ? null : t))}
              onDrop={(e) => handleDropOnCategory(cat.id, e)}
              onRename={(newName) => renameCategory(cat.id, newName)}
              onToggleHidden={() => toggleCategoryHidden(cat.id)}
              onDelete={() => deleteCategory(cat.id)}
              onUnassign={(p) => unassign(cat.id, p)}
              onChipDragStart={handleDragStart}
            />
          ))}
          <button className="new-category-card" onClick={addCategory}>
            + New category
          </button>
        </div>
      </div>
    </div>
  );
}
