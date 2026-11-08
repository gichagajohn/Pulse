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

  function buildAccumulatorTickets(selections) {
    const rows = Array.isArray(selections) ? selections : [];
    const groups = new Map();
    rows.forEach(row => {
      if (row?.ticket_id == null || row.ticket_id === '') return;
      const key = String(row.ticket_id);
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    });

    return Array.from(groups, ([ticketId, values]) => {
      const seen = new Set();
      const legs = values.filter((row, index) => {
        const key = row.id != null ? `id:${row.id}` : `row:${index}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
      const settled = legs.length > 0 && legs.every(row => OUTCOMES.includes(row?.outcome));
      const outcome = !settled
        ? 'pending'
        : legs.some(row => row.outcome === 'loss')
          ? 'loss'
          : legs.some(row => row.outcome === 'win') ? 'win' : 'void';
      const everyLegPriced = legs.length > 0 && legs.every(row => validOdds(row.odds));
      const postedCandidate = everyLegPriced
        ? legs.reduce((product, row) => product * Number(row.odds), 1)
        : null;
      const effectiveCandidate = everyLegPriced
        ? legs.reduce((product, row) => row.outcome === 'void' ? product : product * Number(row.odds), 1)
        : null;
      const priceComplete = Boolean(
        everyLegPriced && Number.isFinite(postedCandidate) && postedCandidate > 1 &&
        Number.isFinite(effectiveCandidate) && effectiveCandidate >= 1
      );
      const postedOdds = priceComplete ? postedCandidate : null;
      const effectiveOdds = priceComplete ? effectiveCandidate : null;
      const netUnits = settled && priceComplete
        ? outcome === 'win' ? effectiveOdds - 1 : outcome === 'loss' ? -1 : 0
        : null;
      return {
        ticketId,
        id: Number(ticketId) || 0,
        ticket_date: legs[0]?.ticket_date || '',
        legs: legs.length,
        selections: legs,
        outcome,
        priceComplete,
        postedOdds,
        effectiveOdds,
        netUnits
      };
    });
  }

  function calculateAccumulatorPerformance(tickets) {
    const accumulators = (Array.isArray(tickets) ? tickets : []).filter(ticket => ticket.legs >= 2);
    const settled = accumulators.filter(ticket => OUTCOMES.includes(ticket.outcome));
    const wins = settled.filter(ticket => ticket.outcome === 'win').length;
    const losses = settled.filter(ticket => ticket.outcome === 'loss').length;
    const voids = settled.filter(ticket => ticket.outcome === 'void').length;
    const decisive = wins + losses;
    const pricedTickets = settled.filter(ticket => ticket.priceComplete && Number.isFinite(ticket.netUnits));
    const pricesComplete = settled.length > 0 && pricedTickets.length === settled.length;
    const averageCombinedOdds = pricedTickets.length
      ? pricedTickets.reduce((sum, ticket) => sum + ticket.postedOdds, 0) / pricedTickets.length
      : null;
    const netUnits = pricesComplete
      ? settled.reduce((sum, ticket) => sum + ticket.netUnits, 0)
      : null;

    let currentLosingStreak = 0;
    let maxLosingStreak = 0;
    settled.slice().sort((a, b) => {
      const dateOrder = String(a.ticket_date || '').localeCompare(String(b.ticket_date || ''));
      return dateOrder || Number(a.id || 0) - Number(b.id || 0);
    }).forEach(ticket => {
      if (ticket.outcome === 'loss') {
        currentLosingStreak += 1;
        maxLosingStreak = Math.max(maxLosingStreak, currentLosingStreak);
      } else if (ticket.outcome === 'win') {
        currentLosingStreak = 0;
      }
    });

    const roi = pricesComplete ? netUnits / settled.length : null;
    return {
      tickets: accumulators,
      settledTickets: settled.length,
      pendingTickets: accumulators.filter(ticket => ticket.outcome === 'pending').length,
      singleTickets: (Array.isArray(tickets) ? tickets : []).filter(ticket => ticket.legs === 1).length,
      wins,
      losses,
      voids,
      decisive,
      winRate: decisive > 0 ? wins / decisive : null,
      pricedCount: pricedTickets.length,
      priceCoverage: settled.length > 0 ? pricedTickets.length / settled.length : null,
      averageCombinedOdds,
      netUnits,
      roi,
      yield: roi,
      maxLosingStreak
    };
  }

  function groupAccumulatorPerformance(tickets, limit = 6) {
    const groups = new Map();
    (Array.isArray(tickets) ? tickets : []).filter(ticket => ticket.legs >= 2 && OUTCOMES.includes(ticket.outcome)).forEach(ticket => {
      const dateKey = String(ticket.ticket_date || '').slice(0, 7);
      const key = /^\d{4}-\d{2}$/.test(dateKey) ? dateKey : 'Date not recorded';
      const group = groups.get(key) || [];
      group.push(ticket);
      groups.set(key, group);
    });
    const size = Math.max(0, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 6));
    return Array.from(groups, ([key, values]) => ({ key, ...calculateAccumulatorPerformance(values) }))
      .sort((a, b) => {
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
    buildAccumulatorTickets,
    calculateAccumulatorPerformance,
    groupAccumulatorPerformance,
    paymentStage
  });
});
