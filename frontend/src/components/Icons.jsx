// Inline stroke icons (24x24 grid, currentColor) — no icon-font/library
// dependency, so they work offline inside the Capacitor shell and inherit
// the tab/button text color for free.
function Svg({ size = 22, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** App logo: a bound ledger book with ruled entry lines. Same geometry as
 * public/favicon.svg and the Android launcher icon. */
export function LogoIcon(props) {
  return (
    <Svg {...props}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8.5 4v16" />
      <path d="M11 8h5M11 11.5h5M11 15h3" />
    </Svg>
  );
}

export function TransactionsIcon(props) {
  return (
    <Svg {...props}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </Svg>
  );
}

export function BudgetsIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4 7a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v2" />
      <path d="M4 7v11a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-3" />
      <path d="M20 12h-4a2 2 0 0 0 0 4h4z" />
    </Svg>
  );
}

export function AccountsIcon(props) {
  return (
    <Svg {...props}>
      <path d="M3 10 12 4l9 6" />
      <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8" />
      <path d="M3 21h18" />
    </Svg>
  );
}

export function AnalysisIcon(props) {
  return (
    <Svg {...props}>
      <path d="M12 3a9 9 0 1 0 9 9h-9z" />
      <path d="M15 3.5A9 9 0 0 1 20.5 9H15z" />
    </Svg>
  );
}

export function AutomationsIcon(props) {
  return (
    <Svg {...props}>
      <path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4" />
    </Svg>
  );
}

export function CommoditiesIcon(props) {
  return (
    <Svg {...props}>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </Svg>
  );
}

export function PencilIcon(props) {
  return (
    <Svg size={18} {...props}>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />
      <path d="M14.5 5.5l3 3" />
    </Svg>
  );
}

export function PlusIcon(props) {
  return (
    <Svg size={26} strokeWidth="2.2" {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** Small inline loading indicator; spins via .spinner in App.css. */
export function Spinner({ size = 16, label = 'Loading' }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label={label} />;
}
