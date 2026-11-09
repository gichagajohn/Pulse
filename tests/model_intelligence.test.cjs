const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const validation = require('../model-validation.js');
const view = require('../admin-strategy.js');

const validationSource = fs.readFileSync(path.join(root, 'model-validation.js'), 'utf8');
const viewSource = fs.readFileSync(path.join(root, 'admin-strategy.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'database', '20261109_model_intelligence_diagnostics.sql'), 'utf8');

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

const cleanCandidate = {
  created_at: '2026-11-10T10:00:00Z',
  kickoff_utc: '2026-11-10T18:30:00Z',
  price_updated_at: '2026-11-10T09:55:00Z',
  bookmaker_odds: 2.05,
  model_prob: 0.55,
  market_implied_prob: 0.48
};

test('validation module is parseable and free of browser/DOM dependencies', () => {
  assert.doesNotThrow(() => new vm.Script(validationSource));
  assert.doesNotMatch(validationSource, /\.innerHTML\s*=/);
  assert.doesNotMatch(validationSource, /document\.|window\.|supabase/i);
});

test('validateCandidate accepts a complete, internally consistent pre-match candidate', () => {
  const result = validation.validateCandidate(cleanCandidate);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.checked.kickoff_utc, '2026-11-10T18:30:00.000Z');
});

test('validateCandidate blocks every unsafe provenance failure mode', () => {
  const expectIssues = (patch, issues) => {
    const result = validation.validateCandidate({ ...cleanCandidate, ...patch });
    assert.equal(result.ok, false);
    issues.forEach(issue => assert.ok(result.issues.includes(issue), `expected ${issue} in ${result.issues}`));
  };
  expectIssues({ kickoff_utc: null }, ['kickoff_missing']);
  expectIssues({ kickoff_utc: 'not-a-date' }, ['kickoff_invalid']);
  expectIssues({ created_at: null }, ['created_at_missing']);
  expectIssues({ created_at: '2026-11-10T19:00:00Z' }, ['prediction_not_before_kickoff']);
  expectIssues({ price_updated_at: null }, ['price_updated_at_missing']);
  expectIssues({ price_updated_at: '2026-11-11T09:55:00Z' }, ['price_updated_after_prediction', 'price_updated_after_kickoff']);
  expectIssues({ price_updated_at: '2026-11-10T10:02:01Z' }, ['price_updated_after_prediction']);
  expectIssues({ bookmaker_odds: 1.0 }, ['bookmaker_odds_invalid']);
  expectIssues({ bookmaker_odds: '2.05' }, ['bookmaker_odds_invalid']);
  expectIssues({ model_prob: 0 }, ['model_prob_invalid']);
  expectIssues({ model_prob: 1 }, ['model_prob_invalid']);
  expectIssues({ market_implied_prob: undefined }, ['market_implied_prob_invalid']);
});

test('validateCandidate tolerates a small provider clock skew but never a missing kickoff', () => {
  const slightlyFast = validation.validateCandidate({ ...cleanCandidate, price_updated_at: '2026-11-10T10:01:59Z' });
  assert.equal(slightlyFast.ok, true);
  const strict = validation.validateCandidate({ ...cleanCandidate, price_updated_at: '2026-11-10T10:00:01Z' }, { maxFuturePriceSkewSeconds: 0 });
  assert.equal(strict.ok, false);
});

test('noVigProbability normalises margins and rejects invalid input', () => {
  const normalised = validation.noVigProbability([0.5, 0.3, 0.4]);
  assert.ok(Math.abs(normalised.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(normalised[0] - 0.5 / 1.2) < 1e-12);
  assert.equal(validation.noVigProbability([]), null);
  assert.equal(validation.noVigProbability([0.5, -0.1]), null);
  assert.equal(validation.noVigProbability([0.5, 0]), null);
  assert.equal(validation.noVigProbability(null), null);
});

test('Wilson bounds behave and reject degenerate input', () => {
  const interval = validation.wilsonInterval(1, 14);
  assert.ok(interval.lower > 0 && interval.lower < interval.upper && interval.upper < 0.5);
  assert.equal(validation.wilsonInterval(0, 0), null);
  assert.equal(validation.wilsonInterval(15, 14), null);
  const lower = validation.wilsonLowerBound(0.7165, 14);
  assert.ok(lower > 0.4 && lower < 0.7165);
  assert.equal(validation.wilsonLowerBound(1.2, 10), null);
  assert.equal(validation.wilsonLowerBound(0.5, 0), null);
});

test('expected value and conservative value are computed exactly', () => {
  assert.ok(Math.abs(validation.expectedValue(0.5, 2.1) - 0.05) < 1e-12);
  assert.equal(validation.expectedValue(0, 2.1), null);
  const conservative = validation.conservativeExpectedValue(0.6, 2.2, 500);
  assert.ok(conservative.probability_lower < 0.6);
  assert.ok(Math.abs(conservative.expected_value - (conservative.probability_lower * 2.2 - 1)) < 1e-12);
});

test('joint ticket math multiplies odds and probabilities and fails closed', () => {
  assert.equal(validation.combinedOdds([2, 1.8]), 3.6);
  assert.equal(validation.combinedOdds([2, 1]), null);
  assert.ok(Math.abs(validation.jointProbability([0.5, 0.8]) - 0.4) < 1e-12);
  assert.equal(validation.jointProbability([0.5, 1]), null);
  const ticket = validation.summarizeTicket([
    { prob: 0.6, odds: 2.0, effective_n: 300 },
    { prob: 0.7, odds: 1.6, effective_n: 300 }
  ]);
  assert.ok(Math.abs(ticket.combined_odds - 3.2) < 1e-12);
  assert.ok(Math.abs(ticket.joint_probability - 0.42) < 1e-12);
  assert.ok(Math.abs(ticket.model_expected_value - (0.42 * 3.2 - 1)) < 1e-12);
  assert.ok(ticket.conservative_expected_value < ticket.model_expected_value);
  assert.equal(validation.summarizeTicket([{ prob: 0.6, odds: 2.0 }]).conservative_expected_value, null);
  assert.equal(validation.summarizeTicket([{ prob: 0.6, odds: 0.5, effective_n: 100 }]), null);
});

test('calibration readiness mirrors the guarded activation rule', () => {
  const cold = validation.calibrationReadiness({ wins: 3, losses: 4 });
  assert.equal(cold.active, false);
  assert.match(cold.reason, /Need at least 200 settled outputs/);
  const oneClassShort = validation.calibrationReadiness({ wins: 199, losses: 1 });
  assert.equal(oneClassShort.active, false);
  const ready = validation.calibrationReadiness({ wins: 120, losses: 110 });
  assert.equal(ready.active, true);
  assert.equal(ready.reason, null);
});

test('diagnostics migration is aggregate-only, admin-gated, and activates nothing', () => {
  assert.match(sql, /is_admin\(\)/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = ''/);
  assert.match(sql, /begin;/);
  assert.match(sql, /commit;/);
  assert.match(sql, /revoke all on function public\.admin_model_intelligence_report\(integer\) from public;/);
  assert.match(sql, /revoke all on function public\.admin_model_intelligence_report\(integer\) from anon;/);
  assert.match(sql, /grant execute on function public\.admin_model_intelligence_report\(integer\) to authenticated;/);
  assert.match(sql, /grant execute on function public\.admin_model_intelligence_report\(integer\) to service_role;/);
  assert.match(sql, /admin_model_intelligence_report/);
  assert.doesNotMatch(sql, /home_team|away_team|rationale|ticket_text|home_score|away_score|home_advantage/i);
  assert.doesNotMatch(sql, /insert into|update public\.|delete from|drop table|truncate/i);
  assert.doesNotMatch(sql, /robust_conservative_v1[^']*activat/i);
});

test('Model lab wires the health panel without injecting HTML or querying private tables', () => {
  [viewSource, adminSource].forEach(code => {
    assert.doesNotMatch(code, /\.innerHTML\s*=/);
    assert.doesNotMatch(code, /insertAdjacentHTML/);
    assert.doesNotMatch(code, /sb\.from\s*\(/);
    assert.doesNotMatch(code, /SUPABASE_SERVICE_ROLE_KEY|service_role/i);
  });
  assert.match(adminSource, /sb\.rpc\('admin_model_intelligence_report', \{ p_days: state\.strategy\.days \}\)/);
  assert.match(adminSource, /sb\.rpc\('admin_strategy_report', \{ p_days: state\.strategy\.days \}\)/);
  assert.match(html, /id="modelHealthReport"/);
  assert.match(html, /id="strategyReport"/);
  assert.match(html, /Model health (?:&amp;|and) provenance/i);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(typeof view.renderModelHealth, 'function');
  assert.equal(typeof view.renderHealthLoading, 'function');
  assert.equal(typeof view.renderHealthError, 'function');
});

const fixtureReport = () => ({
  provenance: {
    candidate_rows: 324,
    settled_candidate_rows: 204,
    missing_kickoff: 324,
    price_after_prediction: 162,
    missing_price: 36,
    missing_market_prob: 0,
    max_future_price_skew_seconds: 5248800,
    eligible_rows: 94,
    eligible_unverifiable: 40,
    distinct_settled_fixtures: 27,
    settled_dates: 3
  },
  calibration: { active_rows: 0, inactive_rows: 324, max_observed_samples: 7 },
  scoring: {
    n: 204, market_n: 204,
    model_brier_score: 0.18439, market_brier_score: 0.16109,
    model_log_loss: 0.54349, market_log_loss: 0.48636,
    timestamp_consistent: { n: 68, model_brier_score: 0.18691, market_brier_score: 0.16253, model_log_loss: 0.54904, market_log_loss: 0.4916 }
  },
  selection_bias: {
    selected: { n: 14, wins: 4, losses: 10, mean_claimed_ev: 0.2102, mean_model_prob: 0.7165, mean_market_prob: 0.629, observed_win_rate: 0.2857, flat_roi: -0.6405, wilson_low: 0.1172, wilson_high: 0.5465 },
    eligible_unselected: { n: 53, wins: 39, losses: 14, mean_claimed_ev: 0.0726, mean_model_prob: 0.7665, mean_market_prob: 0.7411, observed_win_rate: 0.7358, flat_roi: 0.0182, wilson_low: 0.6, wilson_high: 0.84 },
    ineligible: { n: 137, wins: 54, losses: 83, mean_claimed_ev: -0.0432, mean_model_prob: 0.3312, mean_market_prob: 0.3833, observed_win_rate: 0.3942, flat_roi: -0.1135, wilson_low: 0.31, wilson_high: 0.48 }
  },
  high_ev_10_plus: { n: 43, mean_claimed_ev: 0.2326, mean_model_prob: 0.5157, mean_market_prob: 0.4203, observed_win_rate: 0.2326, flat_roi: -0.7837, selected_rows: 11 },
  challenger: { robust_probability_rows: 0, shadow_selected_rows: 0, closing_price_rows: 0, closing_price_coverage: null },
  version_integrity: { versions: 4, legacy_unverified: 4 }
});

test('renderModelHealth surfaces provenance failures, selection bias and missing coverage honestly', () => {
  const container = new FakeElement('div');
  view.renderModelHealth(container, fixtureReport(), fakeDocument);
  const rendered = allText(container);
  assert.match(rendered, /kickoff_utc is missing on 324 candidate rows/);
  assert.match(rendered, /Provider prices updated after prediction on 162 rows/);
  assert.match(rendered, /40 optimizer-eligible rows fail provenance verification/);
  assert.match(rendered, /calibration is inactive on 324 rows/i);
  assert.match(rendered, /Only 204 settled, scored outputs across 3 settled dates and 27 fixtures/);
  assert.match(rendered, /Optimizer selected/);
  assert.match(rendered, /Eligible, not selected/);
  assert.match(rendered, /Wilson interval \(selected\)/);
  assert.match(rendered, /Insufficient shadow\/closing evidence/);
  assert.match(rendered, /EV ≥ 10% candidates/);
  assert.match(rendered, /never activate a model or publish a selection/);
  assert.doesNotMatch(rendered, /\+0\.00u|Infinity/);
});

test('renderModelHealth tolerates missing sections and renders an honest fallback', () => {
  const empty = new FakeElement('div');
  view.renderModelHealth(empty, {}, fakeDocument);
  const emptyText = allText(empty);
  assert.match(emptyText, /Provenance and calibration gate status/);
  assert.match(emptyText, /Insufficient shadow\/closing evidence/);

  const garbage = new FakeElement('div');
  view.renderModelHealth(garbage, null, fakeDocument);
  assert.match(allText(garbage), /Model health diagnostics are unavailable\./);
});
