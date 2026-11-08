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

  function validOdds(value) {
    const odds = Number(value);
    return Number.isFinite(odds) && odds > 1;
  }

  function priceImpliedProbability(odds) {
    return validOdds(odds) ? 1 / Number(odds) : null;
  }

  function chronologicalSelections(rows) {
    return rows.slice().sort((a, b) => {
      const dateOrder = String(a.ticket_date || '').localeCompare(String(b.ticket_date || ''));
      if (dateOrder) return dateOrder;
      return Number(a.id || 0) - Number(b.id || 0);
    });
  }

  function calculatePerformance(selections) {
    const rows = (Array.isArray(selections) ? selections : []).filter(row => OUTCOMES.includes(row?.outcome));
    const counts = countOutcomes(rows);
    const pricedRows = rows.filter(row => validOdds(row.odds));
    const pricesComplete = rows.length > 0 && pricedRows.length === rows.length;
    const averageOdds = pricedRows.length
      ? pricedRows.reduce((sum, row) => sum + Number(row.odds), 0) / pricedRows.length
      : null;
    const netUnits = pricesComplete ? rows.reduce((sum, row) => {
      if (row.outcome === 'win') return sum + Number(row.odds) - 1;
      if (row.outcome === 'loss') return sum - 1;
      return sum;
    }, 0) : null;

    let currentLosingStreak = 0;
    let maxLosingStreak = 0;
    chronologicalSelections(rows).forEach(row => {
      if (row.outcome === 'loss') {
        currentLosingStreak += 1;
        maxLosingStreak = Math.max(maxLosingStreak, currentLosingStreak);
      } else if (row.outcome === 'win') {
        currentLosingStreak = 0;
      }
      // Voids return stake and neither lengthen nor reset a losing streak.
    });

    const roi = pricesComplete ? netUnits / rows.length : null;
    return {
      selections: rows.length,
      wins: counts.win,
      losses: counts.loss,
      voids: counts.void,
      decisive: counts.total,
      winRate: counts.total > 0 ? counts.win / counts.total : null,
      pricedCount: pricedRows.length,
      priceCoverage: rows.length > 0 ? pricedRows.length / rows.length : null,
      averageOdds,
      netUnits,
      roi,
      yield: roi,
      maxLosingStreak
    };
  }

  function groupPerformance(selections, groupBy = 'month', limit = 6) {
    const rows = (Array.isArray(selections) ? selections : []).filter(row => OUTCOMES.includes(row?.outcome));
    const groups = new Map();
    rows.forEach(row => {
      const dateKey = String(row.ticket_date || '').slice(0, 7);
      const key = groupBy === 'league'
        ? String(row.league || '').trim() || 'League not recorded'
        : /^\d{4}-\d{2}$/.test(dateKey) ? dateKey : 'Date not recorded';
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    });
    const size = Math.max(0, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 6));
    return Array.from(groups, ([key, values]) => ({ key, ...calculatePerformance(values) }))
      .sort((a, b) => {
        if (groupBy === 'league') return b.selections - a.selections || a.key.localeCompare(b.key);
        if (a.key === 'Date not recorded') return 1;
        if (b.key === 'Date not recorded') return -1;
        return b.key.localeCompare(a.key);
      })
      .slice(0, size);
  }

  function paymentStage(stage) {
    return (STAGES[stage] || STAGES.idle).slice();
  }

  return Object.freeze({
    filterSelections,
    recentOutcomes,
    countOutcomes,
    validOdds,
    priceImpliedProbability,
    calculatePerformance,
    groupPerformance,
    paymentStage
  });
});
