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
import './App.css';

const TABS = [
  { key: 'transactions', label: 'Transactions' },
  { key: 'budgets', label: 'Budgets' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'automations', label: 'Automations' },
  { key: 'commodities', label: 'Commodities' },
];

export default function App() {
  const [tab, setTab] = useState('transactions');
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
          <h1>Ledger Dashboard</h1>
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
        <h1>Ledger Dashboard</h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={t.key === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {!currencyLoaded && <p className="muted">Loading…</p>}
        {currencyLoaded && tab === 'transactions' && <TransactionsView />}
        {currencyLoaded && tab === 'budgets' && <BudgetsView />}
        {currencyLoaded && tab === 'accounts' && <AccountsView />}
        {currencyLoaded && tab === 'analysis' && <AnalysisView />}
        {currencyLoaded && tab === 'automations' && <AutomationsView />}
        {currencyLoaded && tab === 'commodities' && <CommoditiesView />}
      </main>
    </div>
  );
}
