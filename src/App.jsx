import { useEffect, useState } from 'react';
import { api } from './api';
import { setCurrencySymbol } from './format';
import TransactionsView from './components/TransactionsView';
import BudgetsView from './components/BudgetsView';
import AccountsView from './components/AccountsView';
import AnalysisView from './components/AnalysisView';
import AutomationsView from './components/AutomationsView';
import CommoditiesView from './components/CommoditiesView';
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

  useEffect(() => {
    api
      .getAppSettings()
      .then((settings) => setCurrencySymbol(settings.default_currency))
      .catch(() => {}) // fall back to format.js's default symbol
      .finally(() => setCurrencyLoaded(true));
  }, []);

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
