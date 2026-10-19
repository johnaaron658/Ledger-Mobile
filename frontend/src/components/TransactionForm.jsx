import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import FuzzyCombobox from './FuzzyCombobox';
import { formatLedger } from '../dateUtils';

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

// Split math runs on integer minor units (cents) so an equal split of ₱100
// into three is 33.33 + 33.33 + 33.34, never a float that ledger rejects as
// unbalanced.
function decimalsOf(number) {
  const dot = number.indexOf('.');
  return dot === -1 ? 0 : number.length - dot - 1;
}

function toMinor(number, decimals) {
  const clean = number.replace(/,/g, '');
  const negative = clean.startsWith('-');
  const [int = '', frac = ''] = clean.replace('-', '').split('.');
  const minor = Number(int || 0) * 10 ** decimals + Number(frac.padEnd(decimals, '0').slice(0, decimals) || 0);
  return negative ? -minor : minor;
}

function fromMinor(minor, decimals) {
  const abs = String(Math.abs(minor)).padStart(decimals + 1, '0');
  const int = abs.slice(0, abs.length - decimals);
  const frac = decimals ? `.${abs.slice(-decimals)}` : '';
  return `${minor < 0 ? '-' : ''}${int}${frac}`;
}

// Array#findLastIndex needs Chrome 97+, newer than some Android WebViews.
const lastCheckedIndex = (list) => list.reduce((last, p, i) => (p.checked ? i : last), -1);

const pctOf = (minor, total) => (total ? String(+((minor * 100) / total).toFixed(2)) : '');
const PCT_INPUT_RE = /^\d*\.?\d*$/;

// A slider is quicker than the keyboard on a phone, so the percentage opens a
// popover with one; the number box stays for exact values. The slider spans
// 0-100% so positions read the same on every posting, and `updatePct` stops
// it at what's still free.
function PctPopover({ label, value, available, amount, onChange, onBlurInput, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    // The wrapper holds the toggle button too, so tapping it closes cleanly
    // instead of closing here and reopening on click.
    const handlePointer = (e) => {
      if (!ref.current?.parentElement.contains(e.target)) onClose();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div className="pct-popover" ref={ref} role="dialog" aria-label={`Percentage for ${label}`}>
      <div className="pct-popover-head">
        <span className="pct-popover-label">{label}</span>
        <span className="money">{amount}</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={parseFloat(value) || 0}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Percentage of split"
      />
      <div className="pct-popover-foot">
        <div className="posting-pct">
          <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlurInput} aria-label="Exact percentage" />
          <span className="posting-pct-suffix">%</span>
        </div>
        <span className="muted pct-popover-hint">up to {available}%</span>
        <button type="button" className="btn btn-small" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
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
  initialVirtual,
  title,
  // Shows the "Virtual" checkbox. Only TransactionsView handles the
  // `virtual` flag in the saved payload, so Quick add leaves it off.
  allowVirtual,
  accountNames,
  payees,
  defaultCurrency,
  onSave,
  onClose,
  onDelete,
  // Given only when editing. Receives the form's current payee, postings and
  // virtual flag; the parent reopens the form as a new, prefilled transaction.
  onDuplicate,
  saving,
  error,
}) {
  const [date, setDate] = useState(initial?.date ?? initialDate ?? formatLedger(new Date()));
  const [payee, setPayee] = useState(initial?.payee ?? initialPayee ?? '');
  const [virtual, setVirtual] = useState(!!(initial?.virtual ?? initialVirtual));
  const [postings, setPostings] = useState(
    initial?.postings?.length
      ? initial.postings.map((p) => ({ account: p.account, amount_raw: p.amount_raw }))
      : initialPostings ?? [emptyPosting(defaultCurrency), emptyPosting(defaultCurrency)]
  );

  // The split is whatever is checked: its total is the checked amounts plus
  // the unallocated remainder held by the proxy posting, and each checked
  // posting shows its share of that total. Amounts stay the source of truth,
  // so checking postings on an existing transaction shows percentages right
  // away. Only a percentage edit holds the total fixed (moving the difference
  // into `unallocated`); checking, unchecking or typing an amount keeps
  // `unallocated` as it is and lets the total follow.
  const [unallocatedRaw, setUnallocatedRaw] = useState('0');
  // Account for the proxy posting that holds the unallocated remainder.
  const [proxyAccount, setProxyAccount] = useState('');
  // Raw text of the percentage being typed, so "12." survives a re-render.
  const [pctDraft, setPctDraft] = useState(null);
  // Index of the posting whose percentage popover is open.
  const [pctOpen, setPctOpen] = useState(null);
  const closePct = useCallback(() => {
    setPctOpen(null);
    setPctDraft(null);
  }, []);

  const currency = defaultCurrency ?? '';
  const numberOf = (p) => splitAmount(p.amount_raw, currency)?.number ?? null;
  const splitting = postings.some((p) => p.checked);
  const decimals = Math.max(
    2,
    decimalsOf(unallocatedRaw),
    ...postings.map((p) => decimalsOf(numberOf(p) ?? ''))
  );
  // Minor units of a posting's amount. Blank is 0; another commodity or a
  // price annotation can't be split, so it's null.
  const minorOf = (p) => {
    const number = numberOf(p);
    return number === null ? null : toMinor(number, decimals);
  };
  const checkedSum = (exceptIdx) =>
    postings.reduce((sum, p, i) => (p.checked && i !== exceptIdx ? sum + (minorOf(p) ?? 0) : sum), 0);
  const unallocated = splitting ? toMinor(unallocatedRaw, decimals) : 0;
  const total = checkedSum() + unallocated;
  const lastCheckedIdx = lastCheckedIndex(postings);
  const amountRaw = (minor) => `${currency}${fromMinor(minor, decimals)}`;

  const updatePosting = (idx, field, value) => {
    setPostings((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)));
  };

  const updatePct = (idx, value) => {
    if (!PCT_INPUT_RE.test(value) || !total) return;
    const others = checkedSum(idx);
    let minor = Math.round((total * (parseFloat(value) || 0)) / 100);
    // The checked postings can't take more than 100% of the total.
    if (Math.abs(others + minor) > Math.abs(total)) {
      minor = total - others;
      value = pctOf(minor, total);
    }
    setPctDraft({ idx, value });
    updatePosting(idx, 'amount_raw', amountRaw(minor));
    setUnallocatedRaw(fromMinor(total - others - minor, decimals));
  };

  const endSplitIfEmpty = (list) => {
    if (!list.some((p) => p.checked)) {
      setUnallocatedRaw('0');
      setProxyAccount('');
    }
  };

  const toggleChecked = (idx, checked) => {
    closePct();
    const next = postings.map((p, i) => (i === idx ? { account: p.account, amount_raw: p.amount_raw, ...(checked ? { checked } : {}) } : p));
    setPostings(next);
    endSplitIfEmpty(next);
  };

  // With nothing checked yet, the first posting with an amount is what gets split.
  const firstWithAmount = postings.findIndex((p) => minorOf(p));
  const canSplit = splitting ? !!total : firstWithAmount !== -1;

  const addSplit = () => {
    let list = postings;
    let splitTotal = total;
    if (!splitting) {
      list = list.map((p, i) => (i === firstWithAmount ? { ...p, checked: true } : p));
      splitTotal = minorOf(postings[firstWithAmount]);
    }
    // The new posting goes directly below the checked ones, and every checked
    // posting (plus the unallocated part) becomes an equal share of the total;
    // the last absorbs rounding.
    const at = lastCheckedIndex(list) + 1;
    list = [...list.slice(0, at), { ...emptyPosting(defaultCurrency), checked: true }, ...list.slice(at)];
    const n = list.filter((p) => p.checked).length;
    const share = Math.trunc(splitTotal / n);
    let seen = 0;
    setPostings(
      list.map((p) => {
        if (!p.checked) return p;
        seen += 1;
        return { ...p, amount_raw: amountRaw(seen === n ? splitTotal - share * (n - 1) : share) };
      })
    );
    setUnallocatedRaw('0');
  };

  const addPosting = () => setPostings((prev) => [...prev, emptyPosting(defaultCurrency)]);
  const removePosting = (idx) => {
    closePct();
    const next = postings.filter((_, i) => i !== idx);
    setPostings(next);
    endSplitIfEmpty(next);
  };

  // Plain { account, amount_raw } postings, with the proxy posting (if any)
  // materialized right below the checked ones.
  const finalPostings = () => {
    const plain = postings.map((p) => ({ account: p.account, amount_raw: p.amount_raw }));
    if (!unallocated) return plain;
    const proxy = { account: proxyAccount, amount_raw: amountRaw(unallocated) };
    return [...plain.slice(0, lastCheckedIdx + 1), proxy, ...plain.slice(lastCheckedIdx + 1)];
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({
      date,
      payee,
      ...(allowVirtual ? { virtual } : {}),
      postings: finalPostings()
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
          {allowVirtual && (
            <label className="form-check">
              <input type="checkbox" checked={virtual} onChange={(e) => setVirtual(e.target.checked)} />
              <span>
                Virtual
                <span className="muted form-check-hint">Not posted yet. No date, and no effect on balances.</span>
              </span>
            </label>
          )}
          {!virtual && (
            <div className="form-row">
              <label>Date (YYYY/MM/DD)</label>
              <input value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
          )}
          <div className="form-row">
            <label>Payee</label>
            <FuzzyCombobox value={payee} onChange={setPayee} options={payees} placeholder="Payee" required autoFocus />
          </div>
          <div className="form-row">
            <label>Postings</label>
            {postings.map((p, idx) => (
              <Fragment key={idx}>
                <div className={`posting-row${splitting ? ' has-split' : ''}`}>
                  <input
                    type="checkbox"
                    className="posting-check"
                    title="Include in split"
                    aria-label="Include in split"
                    checked={!!p.checked}
                    onChange={(e) => toggleChecked(idx, e.target.checked)}
                  />
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
                  {splitting &&
                    (p.checked ? (
                      <div className="posting-pct">
                        <button
                          type="button"
                          className="posting-pct-btn"
                          aria-label="Percentage of split"
                          aria-expanded={pctOpen === idx}
                          onClick={() => (pctOpen === idx ? closePct() : setPctOpen(idx))}
                          disabled={minorOf(p) === null || !total}
                        >
                          {minorOf(p) === null ? '' : pctOf(minorOf(p), total)}
                          <span className="posting-pct-suffix">%</span>
                        </button>
                        {pctOpen === idx && minorOf(p) !== null && (
                          <PctPopover
                            label={p.account.trim() || 'Posting'}
                            value={pctDraft?.idx === idx ? pctDraft.value : pctOf(minorOf(p), total)}
                            available={pctOf(total - checkedSum(idx), total)}
                            amount={amountRaw(minorOf(p))}
                            onChange={(v) => updatePct(idx, v)}
                            onBlurInput={() => setPctDraft(null)}
                            onClose={closePct}
                          />
                        )}
                      </div>
                    ) : (
                      <span />
                    ))}
                  <button
                    type="button"
                    className="btn btn-small posting-remove"
                    onClick={() => removePosting(idx)}
                    disabled={postings.length <= 2}
                  >
                    ✕
                  </button>
                </div>
                {idx === lastCheckedIdx && unallocated !== 0 && (
                  <div className="posting-row has-split posting-proxy">
                    <span className="posting-check" />
                    <FuzzyCombobox
                      value={proxyAccount}
                      onChange={setProxyAccount}
                      options={accountNames}
                      placeholder="Unallocated account"
                      required
                    />
                    <div className="amount-input posting-proxy-amount">
                      {currency && <span className="amount-input-prefix">{currency}</span>}
                      <input value={fromMinor(unallocated, decimals)} readOnly tabIndex={-1} />
                    </div>
                    <div className="posting-pct">
                      <input value={pctOf(unallocated, total)} readOnly tabIndex={-1} />
                      <span className="posting-pct-suffix">%</span>
                    </div>
                    {/* Keeps the columns aligned with the rows above. */}
                    <button type="button" className="btn btn-small posting-remove" style={{ visibility: 'hidden' }} tabIndex={-1}>
                      ✕
                    </button>
                  </div>
                )}
              </Fragment>
            ))}
            {splitting && (
              <div className="muted posting-split-total">
                Splitting {currency}
                {fromMinor(total, decimals)}
                {unallocated !== 0 && ` · ${pctOf(unallocated, total)}% unallocated`}
              </div>
            )}
            <div className="posting-buttons">
              <button type="button" className="btn btn-small" onClick={addPosting}>
                + Add posting
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={addSplit}
                disabled={!canSplit}
                title="Add a posting and share the checked amount equally"
              >
                + Add split
              </button>
            </div>
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
            {initial && onDuplicate && (
              <button
                type="button"
                className="btn"
                onClick={() => onDuplicate({ payee, virtual, postings: finalPostings() })}
                disabled={saving}
              >
                Duplicate
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
