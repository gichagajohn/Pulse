const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const fixtureTime = require('../fixture-time.js');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'database', '20261108_public_kickoff_eat.sql'), 'utf8');
const source = fs.readFileSync(path.join(root, 'fixture-time.js'), 'utf8');

test('UTC kickoff is displayed at East Africa Time, three hours ahead', () => {
  assert.equal(fixtureTime.formatKickoffEAT('2026-11-09T17:05:00Z'), '9 Nov · 20:05 EAT');
  assert.equal(fixtureTime.formatKickoffEAT('2026-11-09T20:05:00+03:00'), '9 Nov · 20:05 EAT');
});

test('UTC conversion handles Nairobi date rollover rather than using the UTC date', () => {
  assert.equal(fixtureTime.formatKickoffEAT('2026-11-08T22:30:00Z'), '9 Nov · 01:30 EAT');
});

test('zone-less kickoff_utc values are interpreted as UTC, not device-local time', () => {
  assert.equal(fixtureTime.formatKickoffEAT('2026-11-09 17:05:00'), '9 Nov · 20:05 EAT');
  assert.equal(fixtureTime.kickoffISOString('2026-11-09 17:05:00'), '2026-11-09T17:05:00.000Z');
});

test('formatting is independent of the visitor device timezone', () => {
  const modulePath = path.join(root, 'fixture-time.js');
  const script = `const t = require(${JSON.stringify(modulePath)}); process.stdout.write(t.formatKickoffEAT('2026-11-09T17:05:00Z'));`;
  const output = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'America/Los_Angeles' },
    encoding: 'utf8'
  });
  assert.equal(output, '9 Nov · 20:05 EAT');
});

test('legacy, missing, date-only, malformed and non-string values have no fabricated time', () => {
  [null, undefined, '', '2026-11-08', 'not-a-time', 0, {}].forEach(value => {
    assert.equal(fixtureTime.formatKickoffEAT(value), '');
    assert.equal(fixtureTime.kickoffISOString(value), '');
  });
  assert.equal(fixtureTime.parseKickoffUtc('2026-11-09T17:05:00Z').toISOString(), '2026-11-09T17:05:00.000Z');
});

test('browser helper parses without HTML injection APIs', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
  assert.match(source, /timeZone: 'Africa\/Nairobi'/);
});

test('public cards use kickoff_utc with escaped labels, ISO datetime and legacy fallback', () => {
  assert.match(html, /<script src="\/fixture-time\.js"><\/script>/);
  assert.match(html, /FixtureTime\.formatKickoffEAT\(p\.kickoff_utc\)/);
  assert.match(html, /FixtureTime\.kickoffISOString\(p\.kickoff_utc\)/);
  assert.match(html, /kickoffLabel \? escapeHTML\(kickoffLabel\) : ticketDate/);
  assert.match(html, /escapeHTML\(kickoffDateTime \|\| p\.ticket_date\)/);
  assert.match(html, /\.card-header \.kickoff \{[^}]*white-space: nowrap/);
});

test('RPC migration adds only public kickoff while preserving the paywall and access grants', () => {
  assert.match(sql, /begin;/i);
  assert.match(sql, /drop function public\.get_daily_picks\(\);/i);
  assert.match(sql, /kickoff_utc timestamptz/i);
  assert.match(sql, /ts\.kickoff_utc,/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(sql, /subscription\.user_id = auth\.uid\(\)/i);
  assert.match(sql, /subscription\.status = 'active'/i);
  assert.match(sql, /case when caller_is_unlocked then ts\.market::text else null end/i);
  assert.match(sql, /case when caller_is_unlocked then ts\.odds::numeric else null end/i);
  assert.match(sql, /case when caller_is_unlocked then ts\.rationale::text else null end/i);
  assert.match(sql, /pt\.status = 'published'/i);
  assert.match(sql, /timezone\('Africa\/Nairobi', now\(\)\)/i);
  assert.match(sql, /revoke all on function public\.get_daily_picks\(\) from public/i);
  assert.match(sql, /grant execute on function public\.get_daily_picks\(\) to anon/i);
  assert.match(sql, /grant execute on function public\.get_daily_picks\(\) to authenticated/i);
});

test('kickoff migration does not rewrite tickets, expose private logs or broaden table access', () => {
  assert.doesNotMatch(sql, /\b(insert|update|delete)\s+(into\s+)?public\.(ticket_selections|prediction_tickets)/i);
  assert.doesNotMatch(sql, /model_prediction_logs|shadow_selected|robust_conservative/i);
  assert.doesNotMatch(sql, /create policy|grant select/i);
  assert.match(sql, /notify pgrst, 'reload schema';/i);
  assert.match(sql, /commit;/i);
});
