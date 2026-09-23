import { useEffect, useState } from 'react';
import { api } from '../api';

function todayHtml() {
  return new Date().toISOString().slice(0, 10);
}
function toLedgerDate(htmlDate) {
  return htmlDate ? htmlDate.replaceAll('-', '/') : '';
}

function formatAmount(value) {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function AddPriceForm({ priceCommodity, onSave, onCancel }) {
  const [date, setDate] = useState(todayHtml());
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(toLedgerDate(date), amount);
      onCancel();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-row">
        <label>Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus />
      </div>
      <div className="form-row">
        <label>{`Price (in ${priceCommodity})`}</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 57.90" />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-small btn-primary" onClick={save} disabled={saving || !amount.trim()}>
          Save
        </button>
        <button className="btn btn-small" onClick={onCancel} disabled={saving}>
          ✕
        </button>
      </div>
    </div>
  );
}

function NewCommodityForm({ defaultPriceCommodity, onSave, onCancel }) {
  const [commodity, setCommodity] = useState('');
  const [date, setDate] = useState(todayHtml());
  const [amount, setAmount] = useState('');
  const [priceCommodity, setPriceCommodity] = useState(defaultPriceCommodity);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(commodity.trim(), toLedgerDate(date), amount, priceCommodity.trim());
      onCancel();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="budget-card">
      <h3>New commodity</h3>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-row">
        <label>Commodity</label>
        <input value={commodity} onChange={(e) => setCommodity(e.target.value)} placeholder="e.g. EUR" autoFocus />
      </div>
      <div className="form-row">
        <label>Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Price</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 61.20" />
      </div>
      <div className="form-row">
        <label>In (price commodity)</label>
        <input value={priceCommodity} onChange={(e) => setPriceCommodity(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          className="btn btn-small btn-primary"
          onClick={save}
          disabled={saving || !commodity.trim() || !amount.trim() || !priceCommodity.trim()}
        >
          Save
        </button>
        <button className="btn btn-small" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CommodityCard({ c, onAddPrice, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  const handleDelete = async () => {
    if (!confirm(`Delete "${c.commodity}" and all ${c.history.length} of its price points? This can't be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete(c.commodity);
    } catch (e) {
      setError(e.message);
      setDeleting(false);
    }
  };

  return (
    <div className="budget-card">
      <h3>{c.commodity}</h3>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ fontSize: 22, fontWeight: 600 }}>
        {formatAmount(c.latest_amount)} <span className="muted" style={{ fontSize: 14 }}>{c.price_commodity}</span>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>As of {c.latest_date}</div>

      {adding ? (
        <AddPriceForm
          priceCommodity={c.price_commodity}
          onSave={(date, amount) => onAddPrice(c.commodity, date, amount, c.price_commodity)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn btn-small" onClick={() => setAdding(true)} disabled={deleting}>
            Add price
          </button>
          <button className="btn btn-small" onClick={() => setShowHistory((v) => !v)} disabled={deleting}>
            {showHistory ? 'Hide history' : `History (${c.history.length})`}
          </button>
          <button className="btn btn-small btn-danger" onClick={handleDelete} disabled={deleting}>
            Delete
          </button>
        </div>
      )}

      {showHistory && !adding && (
        <ul className="budget-history-list">
          {c.history.map((h, i) => (
            <li key={i} className={i === 0 ? 'budget-history-active' : ''}>
              <span>{h.date}</span>
              <span>
                {formatAmount(h.amount)} {h.price_commodity}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CommoditiesView() {
  const [commodities, setCommodities] = useState([]);
  const [mainCommodity, setMainCommodity] = useState('');
  const [mainCommodityInput, setMainCommodityInput] = useState('');
  const [addingNew, setAddingNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, settings] = await Promise.all([api.getCommodities(), api.getAppSettings()]);
      setCommodities(data);
      setMainCommodity(settings.main_commodity);
      setMainCommodityInput(settings.main_commodity);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const saveMainCommodity = async () => {
    const next = mainCommodityInput.trim();
    if (!next || next === mainCommodity) {
      setMainCommodityInput(mainCommodity);
      return;
    }
    setMainCommodity(next);
    await api.updateAppSettings({ main_commodity: next });
  };

  const addPrice = async (commodity, date, amount_raw, price_commodity) => {
    await api.addCommodityPrice({ commodity, date, amount_raw, price_commodity });
    await load();
  };

  const deleteCommodity = async (commodity) => {
    await api.deleteCommodity(commodity);
    await load();
  };

  if (loading) return <p>Loading…</p>;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      <div className="toolbar">
        <span className="muted" style={{ fontSize: 13 }}>
          Main commodity (the currency everything is valued into, e.g. for balances and budgets):
        </span>
        <input
          style={{ width: 90, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
          value={mainCommodityInput}
          onChange={(e) => setMainCommodityInput(e.target.value)}
          onBlur={saveMainCommodity}
        />
      </div>

      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setAddingNew((v) => !v)}>
          {addingNew ? 'Cancel' : '+ New commodity'}
        </button>
      </div>

      <div className="budget-grid">
        {addingNew && (
          <NewCommodityForm
            defaultPriceCommodity={mainCommodity}
            onSave={(commodity, date, amount_raw, price_commodity) => addPrice(commodity, date, amount_raw, price_commodity)}
            onCancel={() => setAddingNew(false)}
          />
        )}
        {commodities.map((c) => (
          <CommodityCard key={c.commodity} c={c} onAddPrice={addPrice} onDelete={deleteCommodity} />
        ))}
        {commodities.length === 0 && !addingNew && (
          <p className="muted">No commodity prices found yet.</p>
        )}
      </div>
    </div>
  );
}
