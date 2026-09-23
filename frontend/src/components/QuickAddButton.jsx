import { useState } from 'react';
import { api } from '../api';
import TransactionForm from './TransactionForm';

// Phase 5 §6 item 6: "the new quick-add screen... the single most-used
// action on a phone finance app" (MOBILE_APP.md §6). A floating action
// button, visible on every tab (mounted once in App.jsx, outside the
// per-tab <main> switch), so logging a transaction never requires
// navigating to the Transactions tab first. Reuses TransactionForm as-is —
// the form itself is already phone-workable (single column, big touch
// targets); what was missing was a fast entry point to it from anywhere.
export default function QuickAddButton({ onSaved }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [accountNames, setAccountNames] = useState([]);
  const [payees, setPayees] = useState([]);
  const [defaultCurrency, setDefaultCurrency] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const openForm = async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const [names, txns, settings] = await Promise.all([
        api.getAccountNames(),
        api.getTransactions(),
        api.getAppSettings(),
      ]);
      setAccountNames(names);
      const counts = new Map();
      for (const t of txns) counts.set(t.payee, (counts.get(t.payee) ?? 0) + 1);
      setPayees([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p));
      setDefaultCurrency(settings.default_currency);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const save = async (payload) => {
    setSaving(true);
    setError(null);
    try {
      await api.addTransaction(payload);
      setOpen(false);
      onSaved?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button className="quick-add-fab" onClick={openForm} aria-label="Quick add transaction" title="Quick add transaction">
        +
      </button>
      {open && loading && (
        <div className="modal-backdrop">
          <div className="modal">
            <p className="muted">Loading…</p>
          </div>
        </div>
      )}
      {open && !loading && (
        <TransactionForm
          title="Quick add"
          accountNames={accountNames}
          payees={payees}
          defaultCurrency={defaultCurrency}
          initialPostings={[{ account: '', amount_raw: defaultCurrency }, { account: '', amount_raw: '' }]}
          onSave={save}
          onClose={() => setOpen(false)}
          saving={saving}
          error={error}
        />
      )}
    </>
  );
}
