import { useState } from 'react';
import FuzzyCombobox from './FuzzyCombobox';

const BARE_NUMBER_RE = /^-?[\d,]+\.?\d*$/;

function emptyPosting(defaultCurrency) {
  return { account: '', amount_raw: defaultCurrency ?? '' };
}

// Untouched prefilled currency (no digits) means "leave blank, let ledger balance it".
// A bare number (no currency symbol/code at all) gets the default currency prepended.
function normalizeAmount(raw, defaultCurrency) {
  const trimmed = raw.trim();
  if (!/\d/.test(trimmed)) return '';
  if (defaultCurrency && BARE_NUMBER_RE.test(trimmed)) return `${defaultCurrency}${trimmed}`;
  return trimmed;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUMBER_INPUT_RE = /^-?[\d,]*\.?\d*$/;

// Splits a raw amount into the fixed currency prefix and the editable number,
// so the field can use the numeric keyboard on phones. Anything else (another
// commodity, a price annotation, `-₱50`) stays a plain text field so editing
// an existing transaction never loses what ledger wrote.
function splitAmount(raw, currency) {
  if (!raw || raw === currency) return { number: '' };
  if (!currency) return NUMBER_INPUT_RE.test(raw) ? { number: raw } : null;
  const m = raw.match(new RegExp(`^${escapeRe(currency)}\\s*(-?[\\d,]*\\.?\\d*)$`));
  return m ? { number: m[1] } : null;
}

function AmountInput({ value, onChange, currency }) {
  const split = splitAmount(value, currency ?? '');
  const numeric = split !== null;
  const text = numeric ? split.number : value;
  const showPrefix = numeric && !!currency && text !== '';

  const handleChange = (e) => {
    const v = e.target.value;
    if (v === '') onChange('');
    // Typed digits keep the currency. Anything else (a physical keyboard on
    // desktop) is taken as-is and the field drops back to free text.
    else if (NUMBER_INPUT_RE.test(v)) onChange(`${currency ?? ''}${v}`);
    else onChange(v);
  };

  // One <input> in both modes, so switching mode mid-typing keeps focus.
  return (
    <div className="amount-input">
      {showPrefix && <span className="amount-input-prefix">{currency}</span>}
      <input
        placeholder="Amount (blank = balancing)"
        inputMode={numeric ? 'decimal' : 'text'}
        value={text}
        onChange={handleChange}
      />
    </div>
  );
}

export default function TransactionForm({
  initial,
  initialDate,
  initialPayee,
  initialPostings,
  title,
  accountNames,
  payees,
  defaultCurrency,
  onSave,
  onClose,
  onDelete,
  saving,
  error,
}) {
  const [date, setDate] = useState(initial?.date ?? initialDate ?? new Date().toISOString().slice(0, 10).replace(/-/g, '/'));
  const [payee, setPayee] = useState(initial?.payee ?? initialPayee ?? '');
  const [postings, setPostings] = useState(
    initial?.postings?.length
      ? initial.postings.map((p) => ({ account: p.account, amount_raw: p.amount_raw }))
      : initialPostings ?? [emptyPosting(defaultCurrency), emptyPosting(defaultCurrency)]
  );

  const updatePosting = (idx, field, value) => {
    setPostings((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)));
  };

  const addPosting = () => setPostings((prev) => [...prev, emptyPosting(defaultCurrency)]);
  const removePosting = (idx) => setPostings((prev) => prev.filter((_, i) => i !== idx));

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({
      date,
      payee,
      postings: postings
        .filter((p) => p.account.trim())
        .map((p) => ({ ...p, amount_raw: normalizeAmount(p.amount_raw, defaultCurrency) })),
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title ?? (initial ? 'Edit transaction' : 'Add transaction')}</h3>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <label>Date (YYYY/MM/DD)</label>
            <input value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div className="form-row">
            <label>Payee</label>
            <FuzzyCombobox value={payee} onChange={setPayee} options={payees} placeholder="Payee" required autoFocus />
          </div>
          <div className="form-row">
            <label>Postings</label>
            {postings.map((p, idx) => (
              <div className="posting-row" key={idx}>
                <FuzzyCombobox
                  value={p.account}
                  onChange={(v) => updatePosting(idx, 'account', v)}
                  options={accountNames}
                  placeholder="Account"
                  required
                />
                <AmountInput
                  value={p.amount_raw}
                  onChange={(v) => updatePosting(idx, 'amount_raw', v)}
                  currency={defaultCurrency}
                />
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => removePosting(idx)}
                  disabled={postings.length <= 2}
                >
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-small" onClick={addPosting}>
              + Add posting
            </button>
          </div>
          <div className="modal-actions">
            {initial && (
              <button
                type="button"
                className="btn btn-danger"
                style={{ marginRight: 'auto' }}
                onClick={onDelete}
                disabled={saving}
              >
                Delete
              </button>
            )}
            <button type="button" className="btn" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
