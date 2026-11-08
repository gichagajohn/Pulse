const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const PublicInsights = require('../public-insights.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const mainScript = scripts.find(source => source.includes('const SUPABASE_URL'));

const rows = [
  { id: 1, fixture_id: 1, ticket_date: '2026-01-01', league: 'League A', outcome: 'win', odds: 2.0 },
  { id: 2, fixture_id: 2, ticket_date: '2026-01-02', league: 'League A', outcome: 'loss', odds: 1.5 },
  { id: 3, fixture_id: 3, ticket_date: '2026-01-03', league: 'League B', outcome: 'loss', odds: 1.8 },
  { id: 4, fixture_id: 4, ticket_date: '2026-01-04', league: 'League B', outcome: 'void', odds: 1.4 },
  { id: 5, fixture_id: 5, ticket_date: '2026-02-01', league: 'League A', outcome: 'loss', odds: 1.7 },
  { id: 6, fixture_id: 6, ticket_date: '2026-02-02', league: 'League A', outcome: 'win', odds: 2.5 }
];

test('flat-stake economics include void stake, preserve losses, and keep ROI and yield equivalent', () => {
  const result = PublicInsights.calculatePerformance(rows);
  assert.equal(result.selections, 6);
  assert.equal(result.wins, 2);
  assert.equal(result.losses, 3);
  assert.equal(result.voids, 1);
  assert.equal(result.decisive, 5);
  assert.equal(result.winRate, 0.4);
  assert.equal(result.pricedCount, 6);
  assert.equal(result.priceCoverage, 1);
  assert.ok(Math.abs(result.averageOdds - (10.9 / 6)) < 1e-12);
  assert.ok(Math.abs(result.netUnits - (-0.5)) < 1e-12);
  assert.ok(Math.abs(result.roi - (-0.5 / 6)) < 1e-12);
  assert.equal(result.yield, result.roi);
  assert.equal(result.maxLosingStreak, 3, 'the void neither extends nor resets the three-loss sequence');
});

test('missing or invalid prices suppress economics rather than silently changing the sample', () => {
  const result = PublicInsights.calculatePerformance([
    { id: 1, ticket_date: '2026-01-01', outcome: 'win', odds: 2 },
    { id: 2, ticket_date: '2026-01-02', outcome: 'loss', odds: null },
    { id: 3, ticket_date: '2026-01-03', outcome: 'void', odds: 1 }
  ]);
  assert.equal(result.pricedCount, 1);
  assert.equal(result.priceCoverage, 1 / 3);
  assert.equal(result.averageOdds, 2);
  assert.equal(result.netUnits, null);
  assert.equal(result.roi, null);
  assert.equal(result.yield, null);
  assert.equal(PublicInsights.calculatePerformance([]).roi, null);
  assert.equal(PublicInsights.calculatePerformance([]).maxLosingStreak, 0);
});

test('price-implied probability uses decimal odds and never invents a value for bad prices', () => {
  assert.equal(PublicInsights.priceImpliedProbability(2), 0.5);
  assert.equal(PublicInsights.priceImpliedProbability('1.25'), 0.8);
  assert.equal(PublicInsights.priceImpliedProbability(1), null);
  assert.equal(PublicInsights.priceImpliedProbability(null), null);
  assert.equal(PublicInsights.priceImpliedProbability('not-a-price'), null);
});

test('monthly and league groups retain actual samples and deterministic ordering', () => {
  const monthly = PublicInsights.groupPerformance(rows, 'month', 6);
  assert.deepEqual(Array.from(monthly, group => group.key), ['2026-02', '2026-01']);
  assert.equal(monthly[0].selections, 2);
  assert.equal(monthly[1].selections, 4);
  const leagues = PublicInsights.groupPerformance(rows, 'league', 6);
  assert.deepEqual(Array.from(leagues, group => group.key), ['League A', 'League B']);
  assert.equal(leagues[0].selections, 4);
  assert.equal(leagues[1].selections, 2);
  assert.equal(PublicInsights.groupPerformance(rows, 'league', 1).length, 1);
});

test('performance tables render real grouped rows with escaped labels', () => {
  const elements = { 'performance-monthly': { innerHTML: '' }, 'performance-leagues': { innerHTML: '' } };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    PublicInsights,
    escapeHTML: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
  });
  const source = mainScript.slice(mainScript.indexOf('  function formatPerformancePercent'), mainScript.indexOf('  async function renderPerformance(){'));
  vm.runInContext(source, context);
  context.renderPerformanceBreakdowns(rows.concat([{ id: 7, ticket_date: '2026-02-03', league: '<img src=x>', outcome: 'loss', odds: 2 }]));
  assert.match(elements['performance-monthly'].innerHTML, /Feb 2026/);
  assert.match(elements['performance-monthly'].innerHTML, /Jan 2026/);
  assert.match(elements['performance-leagues'].innerHTML, /League A/);
  assert.match(elements['performance-leagues'].innerHTML, /&lt;img src=x&gt;/);
  assert.doesNotMatch(elements['performance-leagues'].innerHTML, /<img src=x>/);
  assert.match(elements['performance-monthly'].innerHTML, /Net|u|<td>/);
});

test('public integration exposes economics without weakening the paywall or inventing premium analytics', () => {
  ['acca-total', 'acca-rate', 'acca-roi', 'acca-net-units', 'acca-average-odds', 'acca-streak', 'performance-acca-monthly', 'perf-roi', 'perf-net-units', 'perf-average-odds', 'perf-streak', 'performance-monthly', 'performance-leagues', 'hero-win-rate'].forEach(id => {
    assert.match(html, new RegExp(`id="${id}"`));
  });
  assert.match(html, /select\('ticket_id, id, fixture_id, ticket_date, outcome, odds, league'\)/);
  assert.match(html, /catch \(networkError\)/);
  assert.match(html, /PublicInsights\.buildAccumulatorTickets\(data \|\| \[\]\)/);
  assert.match(html, /PublicInsights\.calculateAccumulatorPerformance\(accumulatorTickets\)/);
  assert.match(html, /PublicInsights\.calculatePerformance\(selections\)/);
  assert.match(html, /PublicInsights\.priceImpliedProbability\(p\.odds\)/);
  assert.match(html, /Model rating \(ticket\)/);
  assert.match(html, /Selection diagnostics — flat-stake singles/);
  assert.match(html, /<span class="hero-trust-label">Selection win rate<\/span>/);
  assert.match(html, /Price-implied probability/);
  assert.doesNotMatch(html, /expectedValue\s*=|oddsMovement\s*=/);
  assert.match(html, /sb\.rpc\('get_daily_picks'\)/);
  assert.doesNotMatch(html, /prediction_logs/);
});

test('plan comparison, methodology and paid-access recovery are visible without a monthly plan or compliance claim', () => {
  assert.match(html, /id="page-about"/);
  assert.match(html, /Dixon–Coles-adjusted Poisson/);
  assert.match(html, /not a bookmaker/i);
  assert.match(html, /Do not pay again/);
  assert.match(html, /Football%20Pulse%20Paid%20Access%20Support/);
  assert.match(html, /id="plan-comparison-title"/);
  assert.match(html, /<th scope="col">Feature<\/th><th scope="col">Free<\/th><th scope="col">Daily<\/th><th scope="col">Weekly<\/th>/);
  assert.match(html, /class="comparison-price"/);
  assert.match(html, /about: 'About & Methodology — Football Pulse'/);
  assert.doesNotMatch(html, /payWithMpesa\('monthly'\)|monthly:\s*\{\s*title:/i);
  assert.doesNotMatch(html, /legally compliant|fully compliant|regulatory approval/i);
});
