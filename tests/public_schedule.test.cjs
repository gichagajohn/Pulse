const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('public schedule wording matches the 07:00 EAT target without promising exact completion', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.equal((html.match(/Scheduled daily at 07:00 EAT/g) || []).length, 4);
  assert.match(html, /Publication is scheduled for 07:00 EAT/);
  assert.doesNotMatch(html, /Published daily at 07:00 EAT|08:00 EAT/);
});
