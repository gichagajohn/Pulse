const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const PublicInsights = require('../public-insights.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'database', '20261108_public_accumulator_performance.sql'), 'utf8');

const selections = [
  { id: 1, ticket_id: 100, ticket_date: '2026-01-01', outcome: 'win', odds: 1.5 },
  { id: 2, ticket_id: 100, ticket_date: '2026-01-01', outcome: 'win', odds: 1.6 },
  { id: 3, ticket_id: 100, ticket_date: '2026-01-01', outcome: 'loss', odds: 1.8 },
  { id: 4, ticket_id: 101, ticket_date: '2026-02-01', outcome: 'win', odds: 1.5 },
  { id: 5, ticket_id: 101, ticket_date: '2026-02-01', outcome: 'win', odds: 1.6 },
  { id: 6, ticket_id: 101, ticket_date: '2026-02-01', outcome: 'win', odds: 1.8 },
  { id: 7, ticket_id: 102, ticket_date: '2026-02-02', outcome: 'win', odds: 2 },
  { id: 8, ticket_id: 102, ticket_date: '2026-02-02', outcome: 'void', odds: 1.5 },
  { id: 9, ticket_id: 102, ticket_date: '2026-02-02', outcome: 'win', odds: 1.25 },
  { id: 10, ticket_id: 103, ticket_date: '2026-02-03', outcome: 'void', odds: 1.4 },
  { id: 11, ticket_id: 103, ticket_date: '2026-02-03', outcome: 'void', odds: 1.6 },
  { id: 12, ticket_id: 104, ticket_date: '2026-02-04', outcome: 'win', odds: 2 },
  { id: 13, ticket_id: 105, ticket_date: '2026-02-05', outcome: 'win', odds: 2 },
  { id: 14, ticket_id: 105, ticket_date: '2026-02-05', outcome: 'pending', odds: null }
];

test('accumulator settlement uses the original ticket ID and whole-ticket outcomes', () => {
  const tickets = PublicInsights.buildAccumulatorTickets(selections);
  const byId = new Map(tickets.map(ticket => [ticket.ticketId, ticket]));
  assert.equal(byId.get('100').outcome, 'loss');
  assert.equal(byId.get('100').netUnits, -1, 'one losing leg loses the accumulator despite two winning legs');
  assert.equal(byId.get('101').outcome, 'win');
  assert.ok(Math.abs(byId.get('101').postedOdds - 4.32) < 1e-12);
  assert.ok(Math.abs(byId.get('101').netUnits - 3.32) < 1e-12);
  assert.equal(byId.get('102').outcome, 'win');
  assert.ok(Math.abs(byId.get('102').postedOdds - 3.75) < 1e-12);
  assert.ok(Math.abs(byId.get('102').effectiveOdds - 2.5) < 1e-12);
  assert.ok(Math.abs(byId.get('102').netUnits - 1.5) < 1e-12);
  assert.equal(byId.get('103').outcome, 'void');
  assert.equal(byId.get('103').effectiveOdds, 1);
  assert.equal(byId.get('103').netUnits, 0);
  assert.equal(byId.get('104').legs, 1);
  assert.equal(byId.get('105').outcome, 'pending');
  assert.equal(byId.get('105').netUnits, null);
});

test('one-unit accumulator economics exclude singles and pending tickets but include settled void stake', () => {
  const tickets = PublicInsights.buildAccumulatorTickets(selections);
  const result = PublicInsights.calculateAccumulatorPerformance(tickets);
  assert.equal(result.settledTickets, 4);
  assert.equal(result.pendingTickets, 1);
  assert.equal(result.singleTickets, 1);
  assert.equal(result.wins, 2);
  assert.equal(result.losses, 1);
  assert.equal(result.voids, 1);
  assert.equal(result.winRate, 2 / 3);
  assert.equal(result.pricedCount, 4);
  assert.ok(Math.abs(result.averageCombinedOdds - 3.6575) < 1e-12);
  assert.ok(Math.abs(result.netUnits - 3.82) < 1e-12);
  assert.ok(Math.abs(result.roi - 0.955) < 1e-12);
  assert.equal(result.yield, result.roi);
  assert.equal(result.maxLosingStreak, 1);
});

test('a missing original price suppresses aggregate ROI rather than dropping the ticket silently', () => {
  const tickets = PublicInsights.buildAccumulatorTickets(selections.concat([
    { id: 15, ticket_id: 106, ticket_date: '2026-02-06', outcome: 'win', odds: 2 },
    { id: 16, ticket_id: 106, ticket_date: '2026-02-06', outcome: 'loss', odds: null }
  ]));
  const result = PublicInsights.calculateAccumulatorPerformance(tickets);
  assert.equal(result.settledTickets, 5);
  assert.equal(result.pricedCount, 4);
  assert.equal(result.priceCoverage, 4 / 5);
  assert.equal(result.netUnits, null);
  assert.equal(result.roi, null);
  assert.equal(result.losses, 2);
});

test('accumulator losing streaks are chronological and voids do not reset them', () => {
  const rows = [];
  [200, 201, 202, 203, 204].forEach((ticketId, index) => {
    const outcome = index === 4 ? 'win' : index === 2 ? 'void' : 'loss';
    rows.push({ id: index * 2 + 100, ticket_id: ticketId, ticket_date: `2026-03-0${index + 1}`, outcome, odds: 1.8 });
    rows.push({ id: index * 2 + 101, ticket_id: ticketId, ticket_date: `2026-03-0${index + 1}`, outcome, odds: 1.7 });
  });
  const result = PublicInsights.calculateAccumulatorPerformance(PublicInsights.buildAccumulatorTickets(rows));
  assert.equal(result.maxLosingStreak, 3);
});

test('duplicate selection payloads cannot multiply legs and unidentified rows never form a ticket', () => {
  const duplicated = selections.slice(0, 3).concat(selections[0], [{ id: 99, ticket_id: null, ticket_date: '2026-01-01', outcome: 'win', odds: 2 }]);
  const tickets = PublicInsights.buildAccumulatorTickets(duplicated);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].legs, 3);
  assert.ok(Math.abs(tickets[0].postedOdds - 4.32) < 1e-12);
});

test('monthly accumulator groups keep ticket-level samples and newest-first ordering', () => {
  const monthly = PublicInsights.groupAccumulatorPerformance(PublicInsights.buildAccumulatorTickets(selections), 6);
  assert.deepEqual(Array.from(monthly, group => group.key), ['2026-02', '2026-01']);
  assert.equal(monthly[0].settledTickets, 3);
  assert.equal(monthly[1].settledTickets, 1);
  assert.equal(PublicInsights.groupAccumulatorPerformance([], 6).length, 0);
});

test('safe-view migration adds only the original ticket ID without changing privileges or records', () => {
  assert.match(migration, /create or replace view public\.ticket_selections_safe/i);
  assert.match(migration, /with \(security_barrier = true\)/i);
  assert.match(migration, /ts\.ticket_id/i);
  assert.doesNotMatch(migration, /\b(grant|revoke|insert|update|delete)\b/i);
  assert.doesNotMatch(migration, /ticket_text|prediction_logs|pending_payments|subscriptions/i);
  assert.doesNotMatch(migration, /drop\s+(view|table|policy)/i);
});

test('public integration keeps pending legs for completeness and separates both accounting models', () => {
  const performanceSource = html.slice(html.indexOf('  async function renderPerformance(){'), html.indexOf('  /* =================== END STEP 4 ADDITION'));
  assert.match(performanceSource, /select\('ticket_id, id, fixture_id, ticket_date, outcome, odds, league'\)/);
  assert.doesNotMatch(performanceSource, /\.in\('outcome'/);
  assert.match(performanceSource, /buildAccumulatorTickets\(data \|\| \[\]\)/);
  assert.match(performanceSource, /calculateAccumulatorPerformance\(accumulatorTickets\)/);
  assert.match(performanceSource, /calculatePerformance\(selections\)/);
  assert.match(html, /id="ticket-results"/);
  assert.match(html, /select\('ticket_id, id, fixture_id, ticket_date, home_team, away_team, league, market, odds, outcome, home_score, away_score'\)/);
  assert.match(html, /function renderTicketResults\(rows\)/);
  assert.match(html, /Accumulator accounting:/);
  assert.match(html, /must not be described as accumulator profitability/);
  assert.match(html, /sb\.rpc\('get_daily_picks'\)/);
});
