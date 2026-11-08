(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PublicInsights = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OUTCOMES = ['win', 'loss', 'void'];
  const STAGES = {
    idle: ['active', 'pending', 'pending', 'pending'],
    requesting: ['active', 'pending', 'pending', 'pending'],
    awaiting: ['complete', 'complete', 'active', 'pending'],
    success: ['complete', 'complete', 'complete', 'complete'],
    error: ['error', 'pending', 'pending', 'pending'],
    failed: ['complete', 'complete', 'error', 'pending'],
    timeout: ['complete', 'complete', 'active', 'pending']
  };

  function filterSelections(selections, filter) {
    const rows = Array.isArray(selections) ? selections : [];
    return OUTCOMES.includes(filter) ? rows.filter(row => row?.outcome === filter) : rows.slice();
  }

  function recentOutcomes(selections, limit = 14) {
    const rows = Array.isArray(selections) ? selections : [];
    const size = Math.max(0, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 14));
    return rows.filter(row => OUTCOMES.includes(row?.outcome)).slice(0, size);
  }

  function countOutcomes(selections) {
    const rows = Array.isArray(selections) ? selections : [];
    const counts = { win: 0, loss: 0, void: 0, total: 0 };
    rows.forEach(row => {
      if (!OUTCOMES.includes(row?.outcome)) return;
      counts[row.outcome] += 1;
      if (row.outcome !== 'void') counts.total += 1;
    });
    return counts;
  }

  function paymentStage(stage) {
    return (STAGES[stage] || STAGES.idle).slice();
  }

  return Object.freeze({ filterSelections, recentOutcomes, countOutcomes, paymentStage });
});
