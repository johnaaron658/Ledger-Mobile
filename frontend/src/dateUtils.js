export function parseLedger(d) {
  const [y, m, day] = d.split('/').map(Number);
  return new Date(y, m - 1, day);
}
export function formatLedger(date) {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
}
export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
export function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}
export function addMonths(date, n) {
  return new Date(date.getFullYear(), date.getMonth() + n, 1);
}
export function startOfYear(date) {
  return new Date(date.getFullYear(), 0, 1);
}
export function endOfYear(date) {
  return new Date(date.getFullYear(), 11, 31);
}

export function buildPeriods(minLedger, maxLedger, granularity) {
  const min = parseLedger(minLedger);
  const max = parseLedger(maxLedger);
  const periods = [];
  if (granularity === 'days') {
    let cur = new Date(min);
    while (cur <= max) {
      periods.push({ start: new Date(cur), end: new Date(cur) });
      cur = addDays(cur, 1);
    }
  } else if (granularity === 'months') {
    let cur = startOfMonth(min);
    const last = startOfMonth(max);
    while (cur <= last) {
      periods.push({ start: new Date(cur), end: endOfMonth(cur) });
      cur = addMonths(cur, 1);
    }
  } else {
    let cur = startOfYear(min);
    const last = startOfYear(max);
    while (cur <= last) {
      periods.push({ start: new Date(cur), end: endOfYear(cur) });
      cur = new Date(cur.getFullYear() + 1, 0, 1);
    }
  }
  if (periods.length === 0) periods.push({ start: min, end: max });
  return periods;
}

export function findFromIndex(periods, ledgerDate) {
  const target = parseLedger(ledgerDate);
  for (let i = 0; i < periods.length; i++) {
    if (periods[i].end >= target) return i;
  }
  return periods.length - 1;
}
export function findToIndex(periods, ledgerDate) {
  const target = parseLedger(ledgerDate);
  for (let i = periods.length - 1; i >= 0; i--) {
    if (periods[i].start <= target) return i;
  }
  return 0;
}

export function labelFor(date, granularity) {
  if (granularity === 'years') return String(date.getFullYear());
  if (granularity === 'months') return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
