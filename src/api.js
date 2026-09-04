async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || `Request failed: ${res.status}`);
  }
  return data;
}

export const api = {
  getTransactions: () => request('GET', '/api/transactions'),
  addTransaction: (txn) => request('POST', '/api/transactions', txn),
  editTransaction: (txn) => request('PUT', '/api/transactions', txn),
  deleteTransaction: (loc) => request('DELETE', '/api/transactions', loc),

  getAccounts: () => request('GET', '/api/accounts'),
  getAccountNames: () => request('GET', '/api/accounts/names'),
  getAccountHistory: (account) =>
    request('GET', `/api/accounts/history?account=${encodeURIComponent(account)}`),

  getBudgets: () => request('GET', '/api/budgets'),
  updateBudget: (account, amount_raw) =>
    request('PUT', `/api/budgets/${encodeURIComponent(account)}`, { amount_raw }),
  getBudgetSettings: () => request('GET', '/api/budget-settings'),
  updateBudgetSettings: (settings) => request('PUT', '/api/budget-settings', settings),

  getAnalyses: () => request('GET', '/api/analyses'),
  getAnalysis: (id) => request('GET', `/api/analyses/${encodeURIComponent(id)}`),
  createAnalysis: (analysis) => request('POST', '/api/analyses', analysis),
  updateAnalysis: (id, analysis) => request('PUT', `/api/analyses/${encodeURIComponent(id)}`, analysis),
  deleteAnalysis: (id) => request('DELETE', `/api/analyses/${encodeURIComponent(id)}`),
  computeAnalysis: (draft) => request('POST', '/api/analyses/compute', draft),
  computeAnalysisSeries: (draft) => request('POST', '/api/analyses/compute-series', draft),
};
