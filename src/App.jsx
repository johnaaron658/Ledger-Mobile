import { useState } from 'react';
import TransactionsView from './components/TransactionsView';
import BudgetsView from './components/BudgetsView';
import AccountsView from './components/AccountsView';
import AnalysisView from './components/AnalysisView';
import './App.css';

const TABS = [
  { key: 'transactions', label: 'Transactions' },
  { key: 'budgets', label: 'Budgets' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'analysis', label: 'Analysis' },
];

export default function App() {
  const [tab, setTab] = useState('transactions');

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
        {tab === 'transactions' && <TransactionsView />}
        {tab === 'budgets' && <BudgetsView />}
        {tab === 'accounts' && <AccountsView />}
        {tab === 'analysis' && <AnalysisView />}
      </main>
    </div>
  );
}
