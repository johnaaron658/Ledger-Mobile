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
  addBudgetPeriod: (account, period_text, amount_raw) =>
    request('PUT', `/api/budgets/${encodeURIComponent(account)}`, { period_text, amount_raw }),
  createBudget: (account, period_text, amount_raw) =>
    request('POST', '/api/budgets', { account, period_text, amount_raw }),
  getBudgetSettings: () => request('GET', '/api/budget-settings'),
  updateBudgetSettings: (settings) => request('PUT', '/api/budget-settings', settings),

  getAppSettings: () => request('GET', '/api/app-settings'),
  updateAppSettings: (settings) => request('PUT', '/api/app-settings', settings),

  getCommodities: () => request('GET', '/api/commodities'),
  addCommodityPrice: (price) => request('POST', '/api/commodities/prices', price),
  deleteCommodity: (commodity) => request('DELETE', `/api/commodities/${encodeURIComponent(commodity)}`),

  getAnalyses: () => request('GET', '/api/analyses'),
  getAnalysis: (id) => request('GET', `/api/analyses/${encodeURIComponent(id)}`),
  createAnalysis: (analysis) => request('POST', '/api/analyses', analysis),
  updateAnalysis: (id, analysis) => request('PUT', `/api/analyses/${encodeURIComponent(id)}`, analysis),
  deleteAnalysis: (id) => request('DELETE', `/api/analyses/${encodeURIComponent(id)}`),
  computeAnalysis: (draft) => request('POST', '/api/analyses/compute', draft),
  computeAnalysisSeries: (draft) => request('POST', '/api/analyses/compute-series', draft),

  getAutomations: () => request('GET', '/api/automations'),
  createAutomation: (automation) => request('POST', '/api/automations', automation),
  updateAutomation: (id, automation) =>
    request('PUT', `/api/automations/${encodeURIComponent(id)}`, automation),
  deleteAutomation: (id) => request('DELETE', `/api/automations/${encodeURIComponent(id)}`),
  getPendingAutomations: () => request('GET', '/api/automations/pending'),
  previewPendingAutomation: (id, variables) =>
    request('POST', `/api/automations/pending/${encodeURIComponent(id)}/preview`, { variables }),
  approvePendingAutomation: (id, { variables, renderedOverride } = {}) =>
    request('POST', `/api/automations/pending/${encodeURIComponent(id)}/approve`, {
      variables: variables ?? null,
      rendered_override: renderedOverride ?? null,
    }),
  skipPendingAutomation: (id) => request('DELETE', `/api/automations/pending/${encodeURIComponent(id)}`),
  moveAutomation: (id, { groupId, beforeId } = {}) =>
    request('PUT', `/api/automations/${encodeURIComponent(id)}/group`, {
      group_id: groupId ?? null,
      before_id: beforeId ?? null,
    }),

  getAutomationGroups: () => request('GET', '/api/automation-groups'),
  createAutomationGroup: (name) => request('POST', '/api/automation-groups', { name }),
  renameAutomationGroup: (id, name) =>
    request('PUT', `/api/automation-groups/${encodeURIComponent(id)}`, { name }),
  deleteAutomationGroup: (id) => request('DELETE', `/api/automation-groups/${encodeURIComponent(id)}`),
  reorderAutomationGroups: (order) => request('PUT', '/api/automation-groups/reorder', { order }),
};
