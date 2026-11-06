const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const utils = require('../admin.js');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'database', '20261106_admin_dashboard.sql'), 'utf8');

test('admin JavaScript parses and browser code uses safe DOM rendering', () => {
  assert.doesNotThrow(() => new vm.Script(js));
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
  assert.doesNotMatch(js, /insertAdjacentHTML/);
  assert.doesNotMatch(js, /sb\.from\(/, 'private tables must only be read through admin RPCs');
  assert.doesNotMatch(js, /SUPABASE_SERVICE_ROLE_KEY|service_role/i);
  assert.match(js, /makeElement\('span', 'cell-primary'/);
});

test('all statically referenced element IDs exist and HTML IDs are unique', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML IDs');
  const references = [...js.matchAll(/byId\('([^']+)'\)/g)].map(match => match[1]);
  const missing = [...new Set(references.filter(id => !ids.includes(id)))];
  assert.deepEqual(missing, []);
  ['overview', 'tickets', 'users', 'purchases'].forEach(tab => {
    assert.ok(ids.includes(`panel-${tab}`), `missing panel for ${tab}`);
  });
  assert.match(html, /noindex, nofollow, noarchive/);
});

test('currency, count, percentage, and confidence formatting are deterministic', () => {
  assert.equal(utils.formatCurrency(1000), 'KSh 1,000');
  assert.equal(utils.formatCurrency(10), 'KSh 10');
  assert.equal(utils.formatCurrency('12.50'), 'KSh 12.50');
  assert.equal(utils.formatCurrency('not-a-number'), 'KSh 0');
  assert.equal(utils.formatNumber(12345), '12,345');
  assert.equal(utils.formatPercent(68.12), '68.1%');
  assert.equal(utils.formatConfidence(0.341124), '34.1%');
  assert.equal(utils.formatConfidence(34.1), '34.1%');
});

test('pagination handles empty, first, middle, and final pages', () => {
  assert.deepEqual(utils.pagination(0, 0, 25), {
    start: 0, end: 0, total: 0, page: 1, totalPages: 1,
    hasPrevious: false, hasNext: false
  });
  assert.deepEqual(utils.pagination(101, 50, 25), {
    start: 51, end: 75, total: 101, page: 3, totalPages: 5,
    hasPrevious: true, hasNext: true
  });
  const last = utils.pagination(101, 100, 25);
  assert.equal(last.start, 101);
  assert.equal(last.end, 101);
  assert.equal(last.hasNext, false);
  assert.equal(last.hasPrevious, true);
});

test('CSV output preserves content and neutralises spreadsheet formulas', () => {
  assert.equal(utils.csvValue('ordinary'), '"ordinary"');
  assert.equal(utils.csvValue('a,b'), '"a,b"');
  assert.equal(utils.csvValue('say "hello"'), '"say ""hello"""');
  assert.equal(utils.csvValue('=1+1'), '"\'=1+1"');
  assert.equal(utils.csvValue('+SUM(A1:A2)'), '"\'+SUM(A1:A2)"');
  assert.equal(utils.csvValue(' @cmd'), '"\' @cmd"');
  assert.equal(utils.csvValue(-25), '"-25"', 'numeric negatives stay numeric text');
  const csv = utils.toCsv(['Name', 'Note'], [['A', 'line 1\nline 2'], ['B', '=formula']]);
  assert.equal(
    csv,
    '"Name","Note"\r\n"A","line 1\nline 2"\r\n"B","\'=formula"'
  );
});

test('status classes are constrained to known safe values', () => {
  assert.equal(utils.statusClass('success'), 'success');
  assert.equal(utils.statusClass('no_bet'), 'no_bet');
  assert.equal(utils.statusClass('bad\" onclick=\"alert(1)'), 'neutral');
  assert.equal(utils.titleCase('pending_payment'), 'Pending Payment');
  assert.equal(utils.formatDateTime('not-a-date'), '—');
});

test('every admin API is admin-gated with a fixed search path', () => {
  const functions = [
    'admin_dashboard_overview',
    'admin_list_users',
    'admin_list_purchases',
    'admin_list_tickets'
  ];
  functions.forEach(name => {
    const start = sql.indexOf(`create or replace function public.${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = sql.indexOf('create or replace function', start + 30);
    const body = sql.slice(start, end === -1 ? sql.length : end);
    assert.match(body, /security definer/i);
    assert.match(body, /set search_path = ''/i);
    assert.match(body, /if not public\.is_admin\(\)/i);
    assert.match(body, /errcode = '42501'/i);
  });
});

test('migration hardens anonymous access and never hardcodes an admin email', () => {
  assert.match(sql, /alter table public\.pending_payments enable row level security/i);
  assert.match(sql, /revoke all on table public\.pending_payments from anon/i);
  assert.match(sql, /revoke all on table public\.pending_payments from authenticated/i);
  assert.match(sql, /grant insert on table public\.pending_payments to authenticated/i);
  assert.match(sql, /for insert\s+to authenticated\s+with check/i);
  assert.match(sql, /\(select auth\.uid\(\)\) = user_id/i);
  assert.match(sql, /plan = 'daily' and amount = 1000/i);
  assert.match(sql, /plan = 'weekly' and amount = 5000/i);
  assert.doesNotMatch(sql, /grant select on table public\.pending_payments to authenticated/i);
  assert.match(sql, /revoke all on table public\.admin_users from anon/i);
  assert.match(sql, /revoke all on table public\.admin_users from authenticated/i);
  assert.doesNotMatch(sql, /kapumdagala|gmail\.com|@/i, 'no personal admin email is committed');
  assert.match(sql, /revoke all on function public\.admin_dashboard_overview\(\) from public/i);
  assert.match(sql, /grant execute on function public\.admin_dashboard_overview\(\) to authenticated/i);
});

test('revenue counts only paid subscription records and keeps provider attempts separate', () => {
  assert.match(sql, /s\.status in \('success', 'active', 'expired'\) as is_paid/i);
  assert.match(sql, /false as is_paid/i);
  assert.match(sql, /p\.source = 'subscription' and p\.is_paid/i);
  assert.match(sql, /p\.source = 'pending_payment' and p\.status = 'success'/i);
  assert.doesNotMatch(sql, /case\s+when\s+p\.status\s*=\s*'pending'.*is_paid/is);
});
