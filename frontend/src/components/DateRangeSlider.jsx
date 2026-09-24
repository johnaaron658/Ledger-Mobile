import { useMemo } from 'react';
import { buildPeriods, findFromIndex, findToIndex, formatLedger, labelFor } from '../dateUtils';

const GRANULARITIES = ['days', 'months', 'years'];
const GRANULARITY_LABELS = { days: 'Days', months: 'Months', years: 'Years' };

export default function DateRangeSlider({ minDate, maxDate, startDate, endDate, granularity, onGranularityChange, onChange }) {
  const periods = useMemo(
    () => (minDate && maxDate ? buildPeriods(minDate, maxDate, granularity) : []),
    [minDate, maxDate, granularity]
  );

  if (periods.length === 0) return null;

  const maxIndex = periods.length - 1;
  const fromIndex = Math.min(findFromIndex(periods, startDate), maxIndex);
  const toIndex = Math.max(Math.min(findToIndex(periods, endDate), maxIndex), fromIndex);

  const handleFrom = (e) => {
    const idx = Math.min(Number(e.target.value), toIndex);
    onChange(formatLedger(periods[idx].start), endDate);
  };
  const handleTo = (e) => {
    const idx = Math.max(Number(e.target.value), fromIndex);
    onChange(startDate, formatLedger(periods[idx].end));
  };

  const pct = (i) => (maxIndex === 0 ? 0 : (i / maxIndex) * 100);

  const tickTarget = granularity === 'days' ? 8 : granularity === 'months' ? 12 : 10;
  const tickCount = Math.min(periods.length, tickTarget);
  const tickIndices = [...new Set(
    Array.from({ length: tickCount }, (_, i) => Math.round((i * maxIndex) / Math.max(tickCount - 1, 1)))
  )];

  const lowOnTop = fromIndex > maxIndex * 0.85;

  return (
    <div className="date-range-slider">
      <div className="date-range-slider-header">
        <div className="date-range-slider-values">
          <span className="date-range-slider-value">{labelFor(periods[fromIndex].start, granularity)}</span>
          <span className="muted"> to </span>
          <span className="date-range-slider-value">{labelFor(periods[toIndex].end, granularity)}</span>
        </div>
        <div className="granularity-toggle">
          {GRANULARITIES.map((g) => (
            <button
              key={g}
              type="button"
              className={'btn btn-small' + (g === granularity ? ' active' : '')}
              onClick={() => onGranularityChange(g)}
            >
              {GRANULARITY_LABELS[g]}
            </button>
          ))}
        </div>
      </div>

      <div className="date-range-slider-track-wrap">
        <div className="date-range-slider-rail" />
        <div
          className="date-range-slider-fill"
          style={{ left: `${pct(fromIndex)}%`, right: `${100 - pct(toIndex)}%` }}
        />
        <input
          type="range"
          min={0}
          max={maxIndex}
          value={fromIndex}
          onChange={handleFrom}
          className="date-range-slider-input"
          style={{ zIndex: lowOnTop ? 5 : 3 }}
          aria-label="From date"
        />
        <input
          type="range"
          min={0}
          max={maxIndex}
          value={toIndex}
          onChange={handleTo}
          className="date-range-slider-input"
          style={{ zIndex: 4 }}
          aria-label="To date"
        />
      </div>

      {/* Tick marks are plain lines; the date labels under them would
          overlap on a phone, so below 640px only the first/last label (the
          full data range) is kept — the selected range is already spelled
          out in the header above. */}
      <div className="date-range-slider-ticks">
        {tickIndices.map((i, n) => {
          const p = pct(i);
          const align = p <= 0.5 ? 'start' : p >= 99.5 ? 'end' : 'middle';
          const edge = n === 0 || n === tickIndices.length - 1;
          return (
            <span key={i} className="date-range-slider-tick" style={{ left: `${p}%` }}>
              <span
                className={`date-range-slider-tick-label tick-align-${align}${edge ? ' tick-edge' : ''}`}
              >
                {labelFor(periods[i].start, granularity)}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
