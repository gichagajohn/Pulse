const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const PublicInsights = require('../public-insights.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const mainScript = scripts.find(source => source.includes('const SUPABASE_URL'));
const resultsSource = mainScript.slice(
  mainScript.indexOf('  let settledResultsCache = [];'),
  mainScript.indexOf('  async function renderResults(){')
);
const paymentSource = mainScript.slice(
  mainScript.indexOf('  const PLAN_LABELS ='),
  mainScript.indexOf('  function payWithMpesa(plan){')
);

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.classList = new FakeClassList();
    this.attributes = {};
    this.dataset = {};
    this.innerHTML = '';
    this.textContent = '';
    this.label = null;
    this.listeners = {};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector(selector) { return selector === 'span:last-child' ? this.label : null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function createHarness() {
  const document = { elements: {}, filters: [] };
  const ids = ['results-list', 'results-count', 'outcome-strip', 'ticket-results', 'payment-step-request', 'payment-step-prompt', 'payment-step-confirm', 'payment-step-access'];
  ids.forEach(id => { document.elements[id] = new FakeElement(id); });
  document.elements['results-list'].setAttribute('aria-busy', 'false');
  const labels = ['Request STK push', 'STK prompt sent', 'Provider confirmation', 'Access activated'];
  ids.filter(id => id.startsWith('payment-step-')).forEach((id, index) => { document.elements[id].label = { textContent: labels[index] }; });
  ['all', 'win', 'loss', 'void'].forEach(filter => {
    const button = new FakeElement(`filter-${filter}`);
    button.dataset.resultFilter = filter;
    button.setAttribute('aria-pressed', String(filter === 'all'));
    document.filters.push(button);
  });
  document.getElementById = function (id) { return this.elements[id]; };
  document.querySelectorAll = function (selector) { return selector === '[data-result-filter]' ? this.filters : []; };
  const context = vm.createContext({
    document,
    PublicInsights,
    escapeHTML,
    formatDisplayDate: date => date,
    formatPerformanceUnits: value => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)} u`,
    console
  });
  vm.runInContext(resultsSource, context);
  vm.runInContext(paymentSource, context);
  return { context, document };
}

const fixtures = [
  { id: 3, fixture_id: 3, ticket_date: '2026-11-08', home_team: 'Gamma', away_team: 'Gamma Away', league: 'League C', market: 'Under 3.5', outcome: 'void', home_score: 1, away_score: 1 },
  { id: 2, fixture_id: 2, ticket_date: '2026-11-07', home_team: 'Beta', away_team: 'Beta Away', league: 'League B', market: 'BTTS', outcome: 'loss', home_score: 0, away_score: 1 },
  { id: 1, fixture_id: 1, ticket_date: '2026-11-06', home_team: 'Alpha', away_team: 'Alpha Away', league: 'League A', market: 'Over 1.5', outcome: 'win', home_score: 2, away_score: 0 }
];

test('rendered result filters show only real matching rows and update accessible pressed states', () => {
  const { context, document } = createHarness();
  context.__fixtures = fixtures;
  vm.runInContext('settledResultsCache = __fixtures;', context);
  context.renderOutcomeStrip();
  const originalStrip = document.elements['outcome-strip'].innerHTML;
  context.setResultFilter('loss');
  const rendered = document.elements['results-list'].innerHTML;
  assert.match(rendered, /Beta/);
  assert.doesNotMatch(rendered, /Alpha|Gamma/);
  assert.equal(document.elements['results-count'].textContent, '1 shown · Latest 3 settled selections');
  assert.equal(document.filters.find(button => button.dataset.resultFilter === 'loss').getAttribute('aria-pressed'), 'true');
  assert.equal(document.filters.find(button => button.dataset.resultFilter === 'all').getAttribute('aria-pressed'), 'false');
  assert.equal(document.elements['outcome-strip'].innerHTML, originalStrip, 'filtering must not hide recent losses/wins from the strip');
});

test('recent outcome strip uses W/L/V text and accessible fixture labels rather than color alone', () => {
  const { context, document } = createHarness();
  context.__fixtures = fixtures;
  vm.runInContext('settledResultsCache = __fixtures;', context);
  context.renderOutcomeStrip();
  const strip = document.elements['outcome-strip'].innerHTML;
  ['outcome-item void', 'outcome-item loss', 'outcome-item win'].forEach(className => assert.match(strip, new RegExp(className)));
  ['Gamma versus Gamma Away — void', 'Beta versus Beta Away — loss', 'Alpha versus Alpha Away — win'].forEach(label => assert.match(strip, new RegExp(label)));
  assert.ok(strip.indexOf('Gamma') < strip.indexOf('Beta') && strip.indexOf('Beta') < strip.indexOf('Alpha'));
});

test('recent ticket table shows whole-accumulator outcomes and excludes single-leg tickets', () => {
  const { context, document } = createHarness();
  context.__ticketRows = [
    { id: 1, ticket_id: 20, ticket_date: '2026-11-07', outcome: 'win', odds: 1.5 },
    { id: 2, ticket_id: 20, ticket_date: '2026-11-07', outcome: 'win', odds: 2 },
    { id: 3, ticket_id: 21, ticket_date: '2026-11-08', outcome: 'win', odds: 1.5 },
    { id: 4, ticket_id: 21, ticket_date: '2026-11-08', outcome: 'loss', odds: 2 },
    { id: 5, ticket_id: 22, ticket_date: '2026-11-08', outcome: 'win', odds: 2 },
    { id: 6, ticket_id: 23, ticket_date: '2026-11-09', outcome: 'win', odds: 2 },
    { id: 7, ticket_id: 23, ticket_date: '2026-11-09', outcome: 'pending', odds: null }
  ];
  context.renderTicketResults(context.__ticketRows);
  const rendered = document.elements['ticket-results'].innerHTML;
  assert.match(rendered, /#20[\s\S]*?3\.00[\s\S]*?tag win[\s\S]*?\+2\.00 u/);
  assert.match(rendered, /#21[\s\S]*?tag loss[\s\S]*?-1\.00 u/);
  assert.match(rendered, /#23[\s\S]*?tag pending/);
  assert.doesNotMatch(rendered, /#22/);
  assert.ok(rendered.indexOf('#23') < rendered.indexOf('#21') && rendered.indexOf('#21') < rendered.indexOf('#20'));
});

test('payment stepper never activates access before provider success', () => {
  const { context, document } = createHarness();
  const steps = ['payment-step-request', 'payment-step-prompt', 'payment-step-confirm', 'payment-step-access'].map(id => document.elements[id]);
  context.setPaymentStage('awaiting');
  assert.ok(steps[0].classList.contains('is-complete'));
  assert.ok(steps[1].classList.contains('is-complete'));
  assert.ok(steps[2].classList.contains('is-active'));
  assert.equal(steps[2].getAttribute('aria-current'), 'step');
  assert.equal(steps[3].getAttribute('aria-label'), 'Access activated: pending');
  assert.equal(steps[3].classList.contains('is-complete'), false);

  context.setPaymentStage('failed');
  assert.ok(steps[2].classList.contains('is-error'));
  assert.equal(steps[3].classList.contains('is-complete'), false);

  context.setPaymentStage('error');
  assert.ok(steps[0].classList.contains('is-error'));
  assert.equal(steps[3].classList.contains('is-complete'), false);

  context.setPaymentStage('success');
  steps.forEach(step => assert.ok(step.classList.contains('is-complete')));
  assert.equal(steps[3].getAttribute('aria-label'), 'Access activated: complete');
});
