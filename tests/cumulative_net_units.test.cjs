const assert = require('node:assert/strict');
const test = require('node:test');
const insights = require('../public-insights.js');

test('cumulative singles units are chronological and honor wins, losses, and voids', () => {
  const rows = [
    { ticket_date: '2026-05-03', outcome: 'void', odds: 2.5 },
    { ticket_date: '2026-05-02', outcome: 'loss', odds: 1.8 },
    { ticket_date: '2026-05-01', outcome: 'win', odds: 2.2 }
  ];
  const result = insights.cumulativeNetUnits(rows);
  assert.equal(result.complete, true);
  assert.equal(result.samples, 3);
  assert.deepEqual(result.points.map(point => point.ticket_date), ['2026-05-01', '2026-05-02', '2026-05-03']);
  assert.deepEqual(result.points.map(point => point.netUnits), [1.2, 0.2, 0.2]);
  assert.equal(result.finalUnits, 0.2);
});

test('cumulative trend fails closed if any settled price is missing or invalid', () => {
  const result = insights.cumulativeNetUnits([
    { ticket_date: '2026-05-01', outcome: 'win', odds: 2 },
    { ticket_date: '2026-05-02', outcome: 'loss', odds: null }
  ]);
  assert.deepEqual(result, { complete: false, samples: 2, missingPrices: 1, points: [], finalUnits: null });
  assert.deepEqual(insights.cumulativeNetUnits([]), { complete: false, samples: 0, missingPrices: 0, points: [], finalUnits: null });
});
