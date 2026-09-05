import { useState } from 'react';
import FuzzyCombobox from './FuzzyCombobox';

function emptyPosting() {
  return { account: '', amount_raw: '' };
}

export default function TransactionForm({ initial, initialDate, accountNames, payees, onSave, onClose, onDelete, saving, error }) {
  const [date, setDate] = useState(initial?.date ?? initialDate ?? new Date().toISOString().slice(0, 10).replace(/-/g, '/'));
  const [payee, setPayee] = useState(initial?.payee ?? '');
  const [postings, setPostings] = useState(
    initial?.postings?.length
      ? initial.postings.map((p) => ({ account: p.account, amount_raw: p.amount_raw }))
      : [emptyPosting(), emptyPosting()]
  );

  const updatePosting = (idx, field, value) => {
    setPostings((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)));
  };

  const addPosting = () => setPostings((prev) => [...prev, emptyPosting()]);
  const removePosting = (idx) => setPostings((prev) => prev.filter((_, i) => i !== idx));

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({
      date,
      payee,
      postings: postings.filter((p) => p.account.trim()),
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? 'Edit transaction' : 'Add transaction'}</h3>
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
                <input
                  placeholder="Amount (blank = balancing)"
                  value={p.amount_raw}
                  onChange={(e) => updatePosting(idx, 'amount_raw', e.target.value)}
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
