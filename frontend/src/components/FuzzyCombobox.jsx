import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Fuse from 'fuse.js';

const DROPDOWN_MAX = 220;
const GAP = 4;

// The visible area, not the layout viewport: on a phone the on-screen
// keyboard covers the bottom, and a lower field's dropdown would open
// underneath it (e.g. the second posting's account in Quick add).
function visibleBounds() {
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  return { top, bottom: top + (vv ? vv.height : window.innerHeight) };
}

const isTouch = () => window.matchMedia?.('(pointer: coarse)').matches;

// Stand-in for the keyboard's "Next" action, which we give up (see the
// enterKeyHint comment below). Moves to the next usable field in the form.
function focusNextField(input) {
  const fields = [...(input.form?.elements ?? [])].filter(
    (el) => el.matches('input, select, textarea') && !el.disabled && el.type !== 'hidden'
  );
  fields[fields.indexOf(input) + 1]?.focus();
}

export default function FuzzyCombobox({ value, onChange, options, placeholder, required, autoFocus }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [placement, setPlacement] = useState({ up: false, maxHeight: DROPDOWN_MAX });
  const wrapRef = useRef(null);
  const listRef = useRef(null);

  const fuse = useMemo(() => new Fuse(options, { threshold: 0.4, ignoreLocation: true }), [options]);

  const matches = useMemo(() => {
    if (!value.trim()) return options.slice(0, 8);
    return fuse.search(value).slice(0, 8).map((r) => r.item);
  }, [value, fuse, options]);

  useEffect(() => {
    setHighlight(0);
  }, [value, open]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const showList = open && matches.length > 0;

  // Flip above the input when there's more room there than below. Re-run on
  // viewport changes because the keyboard finishes opening after focus.
  useLayoutEffect(() => {
    if (!showList) return;
    const place = () => {
      const input = wrapRef.current?.firstElementChild;
      if (!input) return;
      const rect = input.getBoundingClientRect();
      const { top, bottom } = visibleBounds();
      const below = bottom - rect.bottom - GAP * 2;
      const above = rect.top - top - GAP * 2;
      const needed = Math.min(listRef.current?.scrollHeight ?? DROPDOWN_MAX, DROPDOWN_MAX);
      const up = below < needed && above > below;
      const maxHeight = Math.max(Math.min(DROPDOWN_MAX, up ? above : below), 88);
      setPlacement((p) => (p.up === up && p.maxHeight === maxHeight ? p : { up, maxHeight }));
    };
    place();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    // Capture: the modal backdrop is the scroller, and scroll doesn't bubble.
    window.addEventListener('scroll', place, true);
    return () => {
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [showList, matches]);

  const pick = (val) => {
    onChange(val);
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    // On touch, Enter behaves like the old "Next" key: take the highlighted
    // match if the list is open, then move on instead of submitting the form.
    if (e.key === 'Enter' && isTouch() && e.currentTarget.form) {
      e.preventDefault();
      if (open && matches[highlight]) pick(matches[highlight]);
      focusNextField(e.currentTarget);
      return;
    }
    if (!open) {
      if (e.key === 'ArrowDown') setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && matches[highlight]) {
        e.preventDefault();
        pick(matches[highlight]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="combobox" ref={wrapRef}>
      <input
        className="combobox-input"
        value={value}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        autoComplete="off"
        // Android's default "Next" key (->|) moves focus natively without
        // sending a key event, so it could never pick the highlighted match.
        // "done" sends a real Enter, which handleKeyDown turns into pick + next.
        enterKeyHint="done"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {showList && (
        <div
          ref={listRef}
          className={`combobox-dropdown${placement.up ? ' up' : ''}`}
          style={{ maxHeight: placement.maxHeight }}
        >
          {matches.map((m, i) => (
            <div
              key={m}
              className={`combobox-option${i === highlight ? ' active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
