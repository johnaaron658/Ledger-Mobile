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
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../api';
import { formatMoney, formatMoneyCompact } from '../format';
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

function CategoryCard({ cat, total, dragOver, onDragOver, onDragLeave, onDrop, onRename, onToggleHidden, onToggleBalance, onToggleForecast, onForecastLookbackChange, onDelete, onUnassign, onChipDragStart }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const payeesRef = useRef(null);

  useLayoutEffect(() => {
    const el = payeesRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [cat.payees, cat.accounts, expanded]);

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
        {formatMoney(total)}
        {cat.hidden && <span className="category-hidden-badge">hidden from charts</span>}
      </div>
      <label className="category-balance-toggle">
        <input type="checkbox" checked={!!cat.show_balance} onChange={onToggleBalance} />
        Show running total on chart
      </label>
      <label className="category-balance-toggle">
        <input type="checkbox" checked={!!cat.forecast_enabled} onChange={onToggleForecast} />
        Forecast trend using last{' '}
        <input
          type="number"
          min={2}
          className="forecast-lookback-input"
          value={cat.forecast_lookback ?? 6}
          disabled={!cat.forecast_enabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onForecastLookbackChange(Math.max(2, Number(e.target.value) || 2))}
        />{' '}
        data points
      </label>
      <div className={'category-payees' + (expanded ? ' expanded' : '')} ref={payeesRef}>
        {cat.payees.map((p) => (
          <span className="assigned-chip" key={`p-${p}`} draggable onDragStart={(e) => onChipDragStart('payee', p, e)}>
            {p}
            <button onClick={() => onUnassign('payee', p)}>✕</button>
          </span>
        ))}
        {cat.accounts.map((a) => (
          <span
            className="assigned-chip assigned-chip-account"
            key={`a-${a}`}
            draggable
            onDragStart={(e) => onChipDragStart('account', a, e)}
          >
            {a}
            <button onClick={() => onUnassign('account', a)}>✕</button>
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
  const [allowMultiCategory, setAllowMultiCategory] = useState(false);
  const [excludedAccounts, setExcludedAccounts] = useState([]);
  const [excludeInput, setExcludeInput] = useState('');
  const [accountNames, setAccountNames] = useState([]);
  const [dateBounds, setDateBounds] = useState(null);
  const [granularity, setGranularity] = useState('months');
  const [forecastEndDate, setForecastEndDate] = useState('');
  const [computed, setComputed] = useState(null);
  const [series, setSeries] = useState(null);
  const [breakdown, setBreakdown] = useState(null);
  const [selectedPayees, setSelectedPayees] = useState(new Set());
  const [payeeSearch, setPayeeSearch] = useState('');
  const [lastClickedIndex, setLastClickedIndex] = useState(null);
  const [selectedAccounts, setSelectedAccounts] = useState(new Set());
  const [accountSearch, setAccountSearch] = useState('');
  const [lastClickedAccountIndex, setLastClickedAccountIndex] = useState(null);
  const [dragOverTarget, setDragOverTarget] = useState(null);
  const [copySourceIds, setCopySourceIds] = useState([]);
  const [otherAnalysisId, setOtherAnalysisId] = useState('');
  const [otherAnalysisCategories, setOtherAnalysisCategories] = useState([]);
  const [otherAnalysisLoading, setOtherAnalysisLoading] = useState(false);
  const [otherCopyIndices, setOtherCopyIndices] = useState([]);
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

  useEffect(() => {
    if (!otherAnalysisId) {
      setOtherAnalysisCategories([]);
      setOtherCopyIndices([]);
      return;
    }
    let cancelled = false;
    setOtherAnalysisLoading(true);
    (async () => {
      try {
        const a = await api.getAnalysis(otherAnalysisId);
        if (!cancelled) setOtherAnalysisCategories(a.categories ?? []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setOtherAnalysisLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [otherAnalysisId]);

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
          forecast_end_date: forecastEndDate || null,
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
  }, [startDate, endDate, categories, excludedAccounts, granularity, forecastEndDate]);

  const hiddenCategoryNames = useMemo(
    () => new Set(categories.filter((c) => c.hidden).map((c) => c.name)),
    [categories]
  );
  const visibleCategories = useMemo(() => categories.filter((c) => !c.hidden), [categories]);
  const balanceCategoryNames = useMemo(
    () => new Set(categories.filter((c) => c.show_balance).map((c) => c.name)),
    [categories]
  );

  const forecastKey = (name) => `${name} (forecast)`;

  const forecastCategoryNames = useMemo(
    () => new Set((series?.forecast?.categories ?? []).map((c) => c.name).filter((n) => !hiddenCategoryNames.has(n))),
    [series, hiddenCategoryNames]
  );

  const lineData = useMemo(() => {
    if (!series) return [];
    const runningByCat = {};
    for (const cat of series.categories) {
      if (!balanceCategoryNames.has(cat.name)) continue;
      let running = 0;
      runningByCat[cat.name] = cat.values.map((v) => (running += v));
    }
    const rows = series.periods.map((p, i) => {
      const row = { label: labelFor(parseLedger(p.start), granularity), periodStart: p.start, periodEnd: p.end };
      for (const cat of series.categories) {
        if (hiddenCategoryNames.has(cat.name)) continue;
        row[cat.name] = runningByCat[cat.name] ? runningByCat[cat.name][i] : cat.values[i];
      }
      if (includeUncategorized) row['Uncategorized'] = series.uncategorized.values[i];
      return row;
    });

    const forecast = series.forecast;
    if (forecast && forecast.periods.length > 0 && forecast.categories.length > 0) {
      const lastRow = rows[rows.length - 1];
      // Backend already returns forecast values in the same units as the plotted series
      // (cumulative for "show running total" categories, per-period otherwise), so just
      // bridge from the last actual point and place them directly — no re-accumulating.
      for (const fc of forecast.categories) {
        if (hiddenCategoryNames.has(fc.name)) continue;
        if (lastRow) lastRow[forecastKey(fc.name)] = lastRow[fc.name];
      }
      forecast.periods.forEach((p, i) => {
        const row = {
          label: labelFor(parseLedger(p.start), granularity),
          periodStart: p.start,
          periodEnd: p.end,
          isForecast: true,
        };
        for (const fc of forecast.categories) {
          if (hiddenCategoryNames.has(fc.name)) continue;
          row[forecastKey(fc.name)] = fc.values[i];
        }
        rows.push(row);
      });
    }
    return rows;
  }, [series, granularity, includeUncategorized, hiddenCategoryNames, balanceCategoryNames]);

  const forecastBoundaryLabel = useMemo(() => {
    if (!series?.forecast?.periods?.length || !series.periods.length) return null;
    const lastActual = series.periods[series.periods.length - 1];
    return labelFor(parseLedger(lastActual.start), granularity);
  }, [series, granularity]);

  const assignedPayees = useMemo(() => new Set(categories.flatMap((c) => c.payees)), [categories]);
  const categoriesByPayee = useMemo(() => {
    const map = new Map();
    for (const c of categories) {
      for (const p of c.payees) {
        if (!map.has(p)) map.set(p, []);
        map.get(p).push(c);
      }
    }
    return map;
  }, [categories]);
  const poolPayees = useMemo(
    () => (computed?.payees ?? []).filter((p) => allowMultiCategory || !assignedPayees.has(p.name)),
    [computed, assignedPayees, allowMultiCategory]
  );
  const poolPayeesFuse = useMemo(
    () => new Fuse(poolPayees, { keys: ['name'], threshold: 0.4, ignoreLocation: true }),
    [poolPayees]
  );
  const visiblePoolPayees = useMemo(
    () => (payeeSearch.trim() ? poolPayeesFuse.search(payeeSearch).map((r) => r.item) : poolPayees),
    [payeeSearch, poolPayeesFuse, poolPayees]
  );

  const assignedAccounts = useMemo(() => new Set(categories.flatMap((c) => c.accounts)), [categories]);
  const categoriesByAccount = useMemo(() => {
    const map = new Map();
    for (const c of categories) {
      for (const a of c.accounts) {
        if (!map.has(a)) map.set(a, []);
        map.get(a).push(c);
      }
    }
    return map;
  }, [categories]);
  const poolAccounts = useMemo(
    () => (computed?.accounts ?? []).filter((a) => allowMultiCategory || !assignedAccounts.has(a.name)),
    [computed, assignedAccounts, allowMultiCategory]
  );
  const poolAccountsFuse = useMemo(
    () => new Fuse(poolAccounts, { keys: ['name'], threshold: 0.4, ignoreLocation: true }),
    [poolAccounts]
  );
  const visiblePoolAccounts = useMemo(
    () => (accountSearch.trim() ? poolAccountsFuse.search(accountSearch).map((r) => r.item) : poolAccounts),
    [accountSearch, poolAccountsFuse, poolAccounts]
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
    setAllowMultiCategory(false);
    setExcludedAccounts([]);
    setExcludeInput('');
    setForecastEndDate('');
    setSelectedPayees(new Set());
    setSelectedAccounts(new Set());
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
      setCategories(
        a.categories.map((c) => ({
          ...c,
          accounts: c.accounts ?? [],
          show_balance: c.show_balance ?? false,
          forecast_enabled: c.forecast_enabled ?? false,
          forecast_lookback: c.forecast_lookback ?? 6,
          id: `cat-${crypto.randomUUID()}`,
        }))
      );
      setIncludeUncategorized(a.include_uncategorized ?? true);
      setAllowMultiCategory(a.allow_multi_category ?? false);
      setExcludedAccounts(a.excluded_accounts ?? []);
      setExcludeInput('');
      setForecastEndDate(a.forecast_end_date ?? '');
      setSelectedPayees(new Set());
      setSelectedAccounts(new Set());
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
      allow_multi_category: allowMultiCategory,
      excluded_accounts: excludedAccounts,
      forecast_end_date: forecastEndDate || null,
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

  const addCategory = (sourceIds) => {
    setCategories((prev) => {
      const sources = sourceIds?.length ? prev.filter((c) => sourceIds.includes(c.id)) : [];
      const payees = Array.from(new Set(sources.flatMap((c) => c.payees)));
      const accounts = Array.from(new Set(sources.flatMap((c) => c.accounts)));
      return [
        ...prev,
        {
          id: `cat-${crypto.randomUUID()}`,
          name: sources.length ? `${sources.map((c) => c.name).join(' + ')} (copy)` : 'New Category',
          color_index: prev.length % 8,
          payees,
          accounts,
          hidden: false,
          show_balance: false,
          forecast_enabled: false,
          forecast_lookback: 6,
        },
      ];
    });
  };

  const addCategoriesFromOther = (indices) => {
    if (!indices.length) return;
    setCategories((prev) => {
      const existingNames = new Set(prev.map((c) => c.name));
      const copies = indices.map((i, offset) => {
        const src = otherAnalysisCategories[i];
        let name = src.name;
        if (existingNames.has(name)) name = `${name} (copy)`;
        existingNames.add(name);
        return {
          id: `cat-${crypto.randomUUID()}`,
          name,
          color_index: (prev.length + offset) % 8,
          payees: [...(src.payees ?? [])],
          accounts: [...(src.accounts ?? [])],
          hidden: false,
          show_balance: src.show_balance ?? false,
          forecast_enabled: src.forecast_enabled ?? false,
          forecast_lookback: src.forecast_lookback ?? 6,
        };
      });
      return [...prev, ...copies];
    });
    setOtherCopyIndices([]);
  };

  const renameCategory = (id, newName) => {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, name: newName } : c)));
  };

  const toggleCategoryHidden = (id) => {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, hidden: !c.hidden } : c)));
  };

  const toggleCategoryBalance = (id) => {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, show_balance: !c.show_balance } : c)));
  };

  const toggleCategoryForecast = (id) => {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, forecast_enabled: !c.forecast_enabled } : c)));
  };

  const setCategoryForecastLookback = (id, lookback) => {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, forecast_lookback: lookback } : c)));
  };

  const deleteCategory = (id) => {
    setCategories((prev) => prev.filter((c) => c.id !== id));
  };

  const fieldForKind = (kind) => (kind === 'payee' ? 'payees' : 'accounts');

  const unassign = (catId, kind, itemName) => {
    const field = fieldForKind(kind);
    setCategories((prev) =>
      prev.map((c) => (c.id === catId ? { ...c, [field]: c[field].filter((n) => n !== itemName) } : c))
    );
  };

  const handleItemClick = (kind, name, index, e) => {
    const isPayee = kind === 'payee';
    const selected = isPayee ? selectedPayees : selectedAccounts;
    const setSelected = isPayee ? setSelectedPayees : setSelectedAccounts;
    const lastIndex = isPayee ? lastClickedIndex : lastClickedAccountIndex;
    const setLastIndex = isPayee ? setLastClickedIndex : setLastClickedAccountIndex;
    const visibleList = isPayee ? visiblePoolPayees : visiblePoolAccounts;
    if (e.shiftKey && lastIndex !== null) {
      const [lo, hi] = [Math.min(lastIndex, index), Math.max(lastIndex, index)];
      setSelected(new Set(visibleList.slice(lo, hi + 1).map((p) => p.name)));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(name) ? next.delete(name) : next.add(name);
        return next;
      });
      setLastIndex(index);
    } else {
      setSelected(new Set([name]));
      setLastIndex(index);
    }
  };

  const handleDragStart = (kind, name, e) => {
    const isPayee = kind === 'payee';
    const selected = isPayee ? selectedPayees : selectedAccounts;
    const setSelected = isPayee ? setSelectedPayees : setSelectedAccounts;
    const payload = selected.has(name) ? Array.from(selected) : [name];
    draggingRef.current = { kind, names: payload };
    if (!selected.has(name)) setSelected(new Set([name]));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', payload.join(','));
  };

  const handleDropOnCategory = (catId, e) => {
    e.preventDefault();
    setDragOverTarget(null);
    const dragging = draggingRef.current;
    if (!dragging || !dragging.names.length) return;
    const { kind, names } = dragging;
    const field = fieldForKind(kind);
    setCategories((prev) =>
      prev.map((c) => {
        if (c.id === catId) {
          return { ...c, [field]: Array.from(new Set([...c[field], ...names])) };
        }
        if (!allowMultiCategory && c[field].some((n) => names.includes(n))) {
          return { ...c, [field]: c[field].filter((n) => !names.includes(n)) };
        }
        return c;
      })
    );
    draggingRef.current = null;
  };

  const handleDropOnPool = (e) => {
    e.preventDefault();
    setDragOverTarget(null);
    const dragging = draggingRef.current;
    if (!dragging || !dragging.names.length) return;
    const { kind, names } = dragging;
    const field = fieldForKind(kind);
    setCategories((prev) => prev.map((c) => ({ ...c, [field]: c[field].filter((n) => !names.includes(n)) })));
    draggingRef.current = null;
  };

  const payeeNamesForCategory = (categoryName, result) => {
    if (categoryName === 'Uncategorized') return new Set(result?.uncategorized?.payees ?? []);
    const cat = (result?.categories ?? []).find((c) => c.name === categoryName);
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
    const isRunning = !!cat?.show_balance;
    const requestId = ++breakdownRequestRef.current;
    const subtitle = isRunning ? `Through ${rowPayload.label}` : rowPayload.label;
    setBreakdown({ source: 'line', title: categoryName, subtitle, colorIndex, rows: [], loading: true });
    try {
      const result = await api.computeAnalysis({
        start_date: isRunning ? startDate : rowPayload.periodStart,
        end_date: rowPayload.periodEnd,
        categories: categories.map(({ id, ...rest }) => rest),
        excluded_accounts: excludedAccounts,
      });
      if (breakdownRequestRef.current !== requestId) return;
      const names = payeeNamesForCategory(categoryName, result);
      const rows = (result.payees ?? []).filter((p) => names.has(p.name));
      setBreakdown({ source: 'line', title: categoryName, subtitle, colorIndex, rows, loading: false });
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={allowMultiCategory}
            onChange={(e) => setAllowMultiCategory(e.target.checked)}
          />
          Allow payees in multiple categories
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Forecast to{' '}
          <input
            type="date"
            value={toHtmlDate(forecastEndDate)}
            min={toHtmlDate(endDate)}
            onChange={(e) => setForecastEndDate(toLedgerDate(e.target.value))}
          />
        </label>
        {forecastEndDate && (
          <button className="btn btn-small" onClick={() => setForecastEndDate('')}>
            Clear forecast
          </button>
        )}
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
              <Tooltip formatter={(v) => formatMoney(v)} />
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
              <YAxis tick={{ fontSize: 12, fill: 'var(--text-muted)' }} tickFormatter={formatMoneyCompact} width={64} />
              <Tooltip formatter={(v) => formatMoney(v)} />
              <Legend />
              {forecastBoundaryLabel && (
                <ReferenceLine
                  x={forecastBoundaryLabel}
                  stroke="var(--text-muted)"
                  strokeDasharray="3 3"
                  label={{ value: 'Forecast', position: 'insideTopRight', fill: 'var(--text-muted)', fontSize: 11 }}
                />
              )}
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
              {visibleCategories
                .filter((cat) => forecastCategoryNames.has(cat.name))
                .map((cat) => (
                  <Line
                    key={`${cat.id}-forecast`}
                    type="monotone"
                    dataKey={forecastKey(cat.name)}
                    name={`${cat.name} (forecast)`}
                    stroke={seriesColor(cat.color_index)}
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    legendType="none"
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
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
                    <td className="money">{formatMoney(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="analysis-layout">
        <div
          className={'panel dropzone payee-pool' + (dragOverTarget === 'payee-pool' ? ' drag-over' : '')}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverTarget('payee-pool');
          }}
          onDragLeave={() => setDragOverTarget((t) => (t === 'payee-pool' ? null : t))}
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
          {visiblePoolPayees.map((p, i) => {
            const memberOf = categoriesByPayee.get(p.name) ?? [];
            return (
              <div
                key={p.name}
                className={'payee-chip' + (selectedPayees.has(p.name) ? ' selected' : '')}
                draggable
                onDragStart={(e) => handleDragStart('payee', p.name, e)}
                onClick={(e) => handleItemClick('payee', p.name, i, e)}
              >
                <span className="payee-chip-name">
                  {memberOf.length > 0 && (
                    <span className="payee-chip-dots" title={`In ${memberOf.map((c) => c.name).join(', ')}`}>
                      {memberOf.map((c) => (
                        <span key={c.id} className="color-swatch" style={swatchStyle(c.color_index)} />
                      ))}
                    </span>
                  )}
                  {p.name}
                </span>
                <span className="money">{formatMoney(p.total)}</span>
              </div>
            );
          })}
          {poolPayees.length === 0 && <p className="muted" style={{ padding: 8 }}>All payees categorized.</p>}
          {poolPayees.length > 0 && visiblePoolPayees.length === 0 && (
            <p className="muted" style={{ padding: 8 }}>No payees match "{payeeSearch}".</p>
          )}
        </div>

        <div
          className={'panel dropzone payee-pool' + (dragOverTarget === 'account-pool' ? ' drag-over' : '')}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverTarget('account-pool');
          }}
          onDragLeave={() => setDragOverTarget((t) => (t === 'account-pool' ? null : t))}
          onDrop={handleDropOnPool}
        >
          <div className="payee-pool-header">Accounts ({poolAccounts.length})</div>
          <input
            type="text"
            className="payee-search"
            placeholder="Search accounts..."
            value={accountSearch}
            onChange={(e) => setAccountSearch(e.target.value)}
          />
          {visiblePoolAccounts.map((a, i) => {
            const memberOf = categoriesByAccount.get(a.name) ?? [];
            return (
              <div
                key={a.name}
                className={'payee-chip' + (selectedAccounts.has(a.name) ? ' selected' : '')}
                draggable
                onDragStart={(e) => handleDragStart('account', a.name, e)}
                onClick={(e) => handleItemClick('account', a.name, i, e)}
              >
                <span className="payee-chip-name">
                  {memberOf.length > 0 && (
                    <span className="payee-chip-dots" title={`In ${memberOf.map((c) => c.name).join(', ')}`}>
                      {memberOf.map((c) => (
                        <span key={c.id} className="color-swatch" style={swatchStyle(c.color_index)} />
                      ))}
                    </span>
                  )}
                  {a.name}
                </span>
                <span className="money">{formatMoney(a.total)}</span>
              </div>
            );
          })}
          {poolAccounts.length === 0 && <p className="muted" style={{ padding: 8 }}>All accounts categorized.</p>}
          {poolAccounts.length > 0 && visiblePoolAccounts.length === 0 && (
            <p className="muted" style={{ padding: 8 }}>No accounts match "{accountSearch}".</p>
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
              onToggleBalance={() => toggleCategoryBalance(cat.id)}
              onToggleForecast={() => toggleCategoryForecast(cat.id)}
              onForecastLookbackChange={(n) => setCategoryForecastLookback(cat.id, n)}
              onDelete={() => deleteCategory(cat.id)}
              onUnassign={(kind, name) => unassign(cat.id, kind, name)}
              onChipDragStart={handleDragStart}
            />
          ))}
          <div className="new-category-card">
            <button className="new-category-btn" onClick={() => addCategory()}>
              + New category
            </button>
            {allowMultiCategory && categories.length > 0 && (
              <div className="copy-category-control">
                <div
                  className="copy-category-list"
                  title="Base the new category off one or more existing ones, copying their payees and accounts"
                >
                  {categories.map((c) => (
                    <label key={c.id} className="copy-category-option">
                      <input
                        type="checkbox"
                        checked={copySourceIds.includes(c.id)}
                        onChange={() =>
                          setCopySourceIds((prev) =>
                            prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id]
                          )
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
                <button
                  className="btn btn-small"
                  disabled={copySourceIds.length === 0}
                  onClick={() => {
                    addCategory(copySourceIds);
                    setCopySourceIds([]);
                  }}
                >
                  Copy from selected
                </button>
              </div>
            )}
            {analysesList.filter((a) => a.id !== currentId).length > 0 && (
              <div className="copy-category-control">
                <select
                  value={otherAnalysisId}
                  onChange={(e) => setOtherAnalysisId(e.target.value)}
                  style={{ width: 170 }}
                >
                  <option value="">Copy from another analysis…</option>
                  {analysesList
                    .filter((a) => a.id !== currentId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
                {otherAnalysisId && (
                  <>
                    {otherAnalysisLoading ? (
                      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                        Loading…
                      </p>
                    ) : otherAnalysisCategories.length === 0 ? (
                      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                        That analysis has no categories.
                      </p>
                    ) : (
                      <>
                        <div className="copy-category-list" title="Copy these categories' payees and accounts into this analysis">
                          {otherAnalysisCategories.map((c, i) => (
                            <label key={`${c.name}-${i}`} className="copy-category-option">
                              <input
                                type="checkbox"
                                checked={otherCopyIndices.includes(i)}
                                onChange={() =>
                                  setOtherCopyIndices((prev) =>
                                    prev.includes(i) ? prev.filter((idx) => idx !== i) : [...prev, i]
                                  )
                                }
                              />
                              {c.name}
                            </label>
                          ))}
                        </div>
                        <button
                          className="btn btn-small"
                          disabled={otherCopyIndices.length === 0}
                          onClick={() => addCategoriesFromOther(otherCopyIndices)}
                        >
                          Copy selected
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
