const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('public schedule wording matches the 07:00 EAT publishing target', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.equal((html.match(/07:00 EAT/g) || []).length, 2);
  assert.doesNotMatch(html, /08:00 EAT/);
});
