// Symbol every money value is displayed with. Mirrors the backend's
// `default_currency` app setting rather than being fixed to one currency; App sets it
// once at startup and TransactionsView re-sets it when the setting is edited. Module
// state is enough here because only the active tab is ever mounted, so every view
// re-reads this on its next render.
let currencySymbol = '₱';

export function setCurrencySymbol(symbol) {
  if (symbol) currencySymbol = symbol;
}

export function formatMoney(value) {
  if (value === null || value === undefined) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${currencySymbol}${abs}`;
}

/** Compact form for chart axes, e.g. "₱1.2M" / "₱340k". */
export function formatMoneyCompact(value) {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${currencySymbol}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${sign}${currencySymbol}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${currencySymbol}${abs.toFixed(0)}`;
}
