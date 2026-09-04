export function formatPhp(value) {
  if (value === null || value === undefined) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}₱${abs}`;
}
