import { useEffect, useState } from 'react';
import { api } from './api';
import { setCurrencySymbol } from './format';
import TransactionsView from './components/TransactionsView';
import BudgetsView from './components/BudgetsView';
import AccountsView from './components/AccountsView';
import AnalysisView from './components/AnalysisView';
import AutomationsView from './components/AutomationsView';
import CommoditiesView from './components/CommoditiesView';
import ImportScreen from './components/ImportScreen';
import ExportBar from './components/ExportBar';
import BiometricLock, { BiometricToggle } from './components/BiometricLock';
import QuickAddButton from './components/QuickAddButton';
import {
  LogoIcon,
  TransactionsIcon,
  BudgetsIcon,
  AccountsIcon,
  AnalysisIcon,
  AutomationsIcon,
  CommoditiesIcon,
} from './components/Icons';
import './App.css';

const TABS = [
  { key: 'transactions', label: 'Transactions', Icon: TransactionsIcon },
  { key: 'budgets', label: 'Budgets', Icon: BudgetsIcon },
  { key: 'accounts', label: 'Accounts', Icon: AccountsIcon },
  { key: 'analysis', label: 'Analysis', Icon: AnalysisIcon },
  { key: 'automations', label: 'Automations', Icon: AutomationsIcon },
  { key: 'commodities', label: 'Commodities', Icon: CommoditiesIcon },
];

function AppTitle({ subtitle }) {
  return (
    <div className="app-title">
      <span className="app-logo">
        <LogoIcon size={20} />
      </span>
      <h1>
        <span className="app-name">Ledger Dashboard</span>
        {subtitle && <span className="app-subtitle">{subtitle}</span>}
      </h1>
    </div>
  );
}

export default function App() {
  return (
    <BiometricLock>
      <AppContent />
    </BiometricLock>
  );
}

function AppContent() {
  const [tab, setTab] = useState('transactions');
  // Bumped on undo (§6 item 4) so the active view remounts and refetches
  // instead of showing stale in-memory state after the journal underneath
  // it changed. Cheap and correct: every view already loads its own data
  // in a mount-time effect (see e.g. TransactionsView's `load()`).
  const [refreshKey, setRefreshKey] = useState(0);
  // Load the display currency before any view renders money, so nothing flashes the
  // default symbol first. Views re-read it via format.js, so no prop threading.
  const [currencyLoaded, setCurrencyLoaded] = useState(false);
  // §5.4's empty-state gate. null = still checking; httpApi's hasJournal()
  // always resolves true, so this only ever shows for the local engine.
  const [hasJournal, setHasJournal] = useState(null);

  useEffect(() => {
    api
      .hasJournal()
      .then(setHasJournal)
      .catch(() => setHasJournal(true)); // fail open rather than strand the user on the import screen
  }, []);

  useEffect(() => {
    if (hasJournal !== true) return;
    api
      .getAppSettings()
      .then((settings) => setCurrencySymbol(settings.default_currency))
      .catch(() => {}) // fall back to format.js's default symbol
      .finally(() => setCurrencyLoaded(true));
  }, [hasJournal]);

  if (hasJournal === null) {
    return (
      <div className="app">
        <main className="app-main">
          <p className="muted">Loading…</p>
        </main>
      </div>
    );
  }

  if (hasJournal === false) {
    return (
      <div className="app">
        <header className="app-header">
          <AppTitle />
        </header>
        <main className="app-main">
          <ImportScreen onImported={() => setHasJournal(true)} />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <AppTitle subtitle={TABS.find((t) => t.key === tab)?.label} />
        {/* Top text tabs on desktop; on phone widths the same <nav> becomes a
            fixed bottom bar of icons (see .tabs in App.css), so all six fit
            on one row without horizontal scrolling. */}
        <nav className="tabs" aria-label="Sections">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={key === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(key)}
              aria-label={label}
              aria-current={key === tab ? 'page' : undefined}
              title={label}
            >
              <Icon className="tab-icon" />
              <span className="tab-label">{label}</span>
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <BiometricToggle />
          <ExportBar onUndo={() => setRefreshKey((k) => k + 1)} />
        </div>
      </header>
      <main className="app-main">
        {!currencyLoaded && <p className="muted">Loading…</p>}
        {currencyLoaded && tab === 'transactions' && <TransactionsView key={refreshKey} />}
        {currencyLoaded && tab === 'budgets' && <BudgetsView key={refreshKey} />}
        {currencyLoaded && tab === 'accounts' && <AccountsView key={refreshKey} />}
        {currencyLoaded && tab === 'analysis' && <AnalysisView key={refreshKey} />}
        {currencyLoaded && tab === 'automations' && <AutomationsView key={refreshKey} />}
        {currencyLoaded && tab === 'commodities' && <CommoditiesView key={refreshKey} />}
      </main>
      {currencyLoaded && <QuickAddButton onSaved={() => setRefreshKey((k) => k + 1)} />}
    </div>
  );
}
