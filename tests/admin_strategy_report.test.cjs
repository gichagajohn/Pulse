const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const view = require('../admin-strategy.js');
const source = fs.readFileSync(path.join(root, 'admin-strategy.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'database', '20261108_admin_strategy_report.sql'), 'utf8');

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.textContent = '';
    this.className = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
}

const fakeDocument = { createElement: tag => new FakeElement(tag) };
function allText(node) {
  return [node.textContent || '', ...node.children.map(allText)].join(' ');
}

function emptyStrategy() {
  return {
    counts: { candidate_rows: 0, selected_rows: 0, pending_selected: 0, settled_selected: 0 },
    singles: { bets: 0, net_profit: 0, max_drawdown: 0, clv_bets: 0 },
    accumulator: { bets: 0, net_profit: 0, clv_bets: 0 },
    probability: {},
    segments: { market: [], league: [], odds_band: [] }
  };
}

test('strategy browser modules parse and never inject HTML or query private tables directly', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.doesNotThrow(() => new vm.Script(adminSource));
  [source, adminSource].forEach(code => {
    assert.doesNotMatch(code, /\.innerHTML\s*=/);
    assert.doesNotMatch(code, /insertAdjacentHTML/);
    assert.doesNotMatch(code, /sb\.from\s*\(/);
    assert.doesNotMatch(code, /SUPABASE_SERVICE_ROLE_KEY|service_role/i);
  });
  assert.match(adminSource, /sb\.rpc\('admin_strategy_report', \{ p_days: state\.strategy\.days \}\)/);
  assert.match(adminSource, /if \(!state\.isAdmin\) return;/);
});

test('Model lab markup and referenced IDs are present and unique', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  ['panel-strategy', 'strategyWindow', 'strategyReport'].forEach(id => assert.ok(ids.includes(id)));
  assert.match(html, /admin-strategy\.js/);
  assert.match(html, /Shadow only · Read only/);
  assert.match(html, /not necessarily the official ticket/i);
  assert.match(html, /No team-level shadow data/);
});

test('nullable formatting distinguishes unavailable, zero, positive, and negative metrics', () => {
  assert.equal(view.formatPercent(null), '—');
  assert.equal(view.formatPercent(0.125, true), '+12.5%');
  assert.equal(view.formatPercent(-0.125, true), '-12.5%');
  assert.equal(view.formatUnits(null, true), '—');
  assert.equal(view.formatUnits(1.234, true), '+1.23u');
  assert.equal(view.formatUnits(-1.234, true), '-1.23u');
  assert.equal(view.formatOdds(null), '—');
  assert.equal(view.formatOdds(2.345), '2.35');
  assert.equal(view.formatDecimal(0.123456), '0.1235');
  assert.equal(view.formatClv({ clv_bets: 0, average_clv: 0 }), 'No coverage');
  assert.equal(view.formatClv({ clv_bets: 2, average_clv: 0.025 }), '+2.5%');
  assert.equal(view.formatClvCoverage({ clv_bets: 2, bets: 4, clv_coverage: 0.5 }), '2/4 (50.0%)');
});

test('shadow probability diagnostics prefer the registered robust probability', () => {
  const probability = view.selectedProbability({ probability: {
    model_predictions: 4, model_brier_score: 0.3, model_log_loss: 0.9,
    robust_predictions: 4, robust_brier_score: 0.2, robust_log_loss: 0.7
  } }, true);
  assert.equal(probability.source, 'Robust probability');
  assert.equal(probability.brier_score, 0.2);
  assert.equal(probability.log_loss, 0.7);
  const production = view.selectedProbability({ probability: {
    model_predictions: 4, model_brier_score: 0.3,
    robust_predictions: 4, robust_brier_score: 0.2
  } }, false);
  assert.equal(production.source, 'Model probability');
  assert.equal(production.brier_score, 0.3);
});

test('segment merging retains production-only and shadow-only groups deterministically', () => {
  const merged = view.mergeSegments(
    [{ key: 'home_win', bets: 2, roi: 0.1 }, { key: 'over_25', bets: 5, roi: -0.1 }],
    [{ key: 'home_win', bets: 1, roi: 0 }, { key: 'draw_no_bet', bets: 3, roi: 0.2 }],
    'market'
  );
  assert.deepEqual(merged.map(row => row.key), ['over_25', 'draw_no_bet', 'home_win']);
  assert.equal(merged.find(row => row.key === 'over_25').shadow, null);
  assert.equal(merged.find(row => row.key === 'draw_no_bet').production, null);
  const bands = view.mergeSegments(
    [{ key: '5.00+', bets: 1 }, { key: '1.50-1.99', bets: 1 }], [], 'odds_band'
  );
  assert.deepEqual(bands.map(row => row.key), ['1.50-1.99', '5.00+']);
});

test('empty production and shadow data renders an honest empty state without fake zero profit', () => {
  const container = new FakeElement('div');
  view.render(container, {
    strategies: { production: emptyStrategy(), robust_conservative_v1: emptyStrategy() }
  }, fakeDocument);
  const rendered = allText(container);
  assert.match(rendered, /No settled optimizer selections/);
  assert.match(rendered, /Metrics remain unavailable rather than zero-performance claims/);
  assert.doesNotMatch(rendered, /\+0\.00u|0\.00u/);
});

test('production data and missing shadow data remain clearly distinguished', () => {
  const production = emptyStrategy();
  production.counts = { candidate_rows: 100, selected_rows: 4, pending_selected: 1, settled_selected: 3 };
  production.singles = { bets: 3, wins: 2, losses: 1, hit_rate: 2 / 3, roi: 0.125, net_profit: 0.375, max_drawdown: 1, clv_bets: 0 };
  production.accumulator = { bets: 1, roi: 0.5, net_profit: 0.5, clv_bets: 0 };
  production.probability = { model_predictions: 3, model_brier_score: 0.2, model_log_loss: 0.6 };
  production.segments.market = [{ key: 'home_win', bets: 3, hit_rate: 2 / 3, roi: 0.125 }];
  const container = new FakeElement('div');
  view.render(container, {
    strategies: { production, robust_conservative_v1: emptyStrategy() }
  }, fakeDocument);
  const rendered = allText(container);
  assert.match(rendered, /\+12\.5%/);
  assert.match(rendered, /No settled shadow selections yet/);
  assert.match(rendered, /Small or missing samples/);
  assert.match(rendered, /not evidence|cannot activate/i);
});

test('aggregate RPC and helper are admin-gated, locked down, and do not grant log-table reads', () => {
  const start = sql.indexOf('create or replace function public.admin_strategy_report(');
  assert.ok(start >= 0);
  const body = sql.slice(start);
  assert.match(body, /security definer/i);
  assert.match(body, /set search_path = ''/i);
  assert.match(body, /if not public\.is_admin\(\)/i);
  assert.match(body, /errcode = '42501'/i);
  assert.match(body, /public\._admin_strategy_one\('production', start_date\)/);
  assert.match(body, /public\._admin_strategy_one\('robust_conservative_v1', start_date\)/);
  assert.match(sql, /revoke all on function public\.admin_strategy_report\(integer\) from public/i);
  assert.match(sql, /revoke all on function public\.admin_strategy_report\(integer\) from anon/i);
  assert.match(sql, /grant execute on function public\.admin_strategy_report\(integer\) to authenticated/i);
  assert.match(sql, /revoke all on function public\._admin_strategy_one\(text, date\) from authenticated/i);
  assert.doesNotMatch(sql, /grant select on (table )?public\.model_prediction_logs/i);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /home_team|away_team|features_json|fixture_id'\s*,/i);
});

test('SQL implements DNB pushes, complete accumulators, probability scoring, drawdown, and CLV', () => {
  assert.match(sql, /when 'void' then 1\.0/);
  assert.match(sql, /filter \(where s\.outcome <> 'void'\)/);
  assert.match(sql, /when bool_and\(s\.outcome = 'void'\) then 'void'/);
  assert.match(sql, /having bool_and\(s\.outcome in \('win', 'loss', 'void'\)\)/);
  assert.match(sql, /model_brier_score/);
  assert.match(sql, /robust_log_loss/);
  assert.match(sql, /max_drawdown/);
  assert.match(sql, /bookmaker_odds \/ s\.closing_bookmaker_odds - 1\.0/);
  assert.match(sql, /clv_coverage/);
  assert.match(sql, /Descriptive diagnostics only; no automatic strategy activation/);
});
