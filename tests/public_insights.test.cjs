const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const insights = require('../public-insights.js');

const rows = [
  { id: 5, outcome: 'win' },
  { id: 4, outcome: 'loss' },
  { id: 3, outcome: 'void' },
  { id: 2, outcome: 'pending' },
  { id: 1, outcome: 'win' }
];

test('result filters use actual outcomes and never mutate the public record', () => {
  const before = JSON.stringify(rows);
  assert.deepEqual(insights.filterSelections(rows, 'win').map(row => row.id), [5, 1]);
  assert.deepEqual(insights.filterSelections(rows, 'loss').map(row => row.id), [4]);
  assert.deepEqual(insights.filterSelections(rows, 'void').map(row => row.id), [3]);
  assert.equal(insights.filterSelections(rows, 'all').length, rows.length);
  assert.equal(insights.filterSelections(rows, 'unsupported').length, rows.length);
  assert.deepEqual(insights.filterSelections(null, 'win'), []);
  assert.equal(JSON.stringify(rows), before);
});

test('recent outcome strip is capped, keeps newest-first order and excludes pending rows', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ id: index, outcome: index % 3 === 0 ? 'void' : index % 2 ? 'win' : 'loss' }));
  many.splice(2, 0, { id: 99, outcome: 'pending' });
  const recent = insights.recentOutcomes(many);
  assert.equal(recent.length, 14);
  assert.equal(recent[0].id, 0);
  assert.ok(recent.every(row => row.outcome !== 'pending'));
  assert.deepEqual(insights.recentOutcomes(rows, 0), []);
  assert.equal(insights.recentOutcomes(rows, 100).length, 4);
});

test('outcome counts keep voids separate from wins and losses', () => {
  assert.deepEqual(insights.countOutcomes(rows), { win: 2, loss: 1, void: 1, total: 3 });
  assert.deepEqual(insights.countOutcomes(null), { win: 0, loss: 0, void: 0, total: 0 });
});

test('payment stages require checkout and provider confirmation before activation', () => {
  assert.deepEqual(insights.paymentStage('awaiting'), ['complete', 'complete', 'active', 'pending']);
  assert.deepEqual(insights.paymentStage('success'), ['complete', 'complete', 'complete', 'complete']);
  assert.deepEqual(insights.paymentStage('error'), ['error', 'pending', 'pending', 'pending']);
  assert.deepEqual(insights.paymentStage('failed'), ['complete', 'complete', 'error', 'pending']);
  const copy = insights.paymentStage('awaiting');
  copy[3] = 'complete';
  assert.equal(insights.paymentStage('awaiting')[3], 'pending');
  assert.deepEqual(insights.paymentStage('unknown'), insights.paymentStage('idle'));
});

test('static integration uses real-data containers and no fabricated demo metrics or unlock timer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<script src="\/public-insights\.js"><\/script>\s*<script>/);
  ['all', 'win', 'loss', 'void'].forEach(filter => {
    assert.match(html, new RegExp(`data-result-filter="${filter}"`));
  });
  ['outcome-strip', 'results-count', 'hero-outcomes', 'hero-ticket-state', 'hero-published', 'payment-summary-plan', 'payment-summary-amount'].forEach(id => {
    assert.match(html, new RegExp(`id="${id}"`));
  });
  assert.doesNotMatch(html, /68\.4%|1,428|\+18\.2%|6 Wins|setTimeout\([^)]*setIsVipUnlocked/);
});
