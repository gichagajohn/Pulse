const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'database', '20261110_public_access_hardening.sql'), 'utf8');
const docs = fs.readFileSync(path.join(root, 'database', 'ADMIN_DASHBOARD.md'), 'utf8');

test('public ticket views are explicitly read-only for browser roles', () => {
  assert.match(sql, /create or replace view public\.prediction_tickets_safe[\s\S]*?security_barrier = true/i);
  assert.match(sql, /select\s+pt\.id,\s*pt\.ticket_date,\s*pt\.status,\s*pt\.combined_odds,\s*pt\.selection_count,\s*pt\.final_confidence,\s*pt\.risk_level,\s*pt\.outcome,\s*pt\.created_at\s+from public\.prediction_tickets pt/i);
  for (const view of ['prediction_tickets_safe', 'ticket_selections_safe']) {
    assert.match(sql, new RegExp(`revoke all on table public\\.${view} from public, anon, authenticated`, 'i'));
    assert.match(sql, new RegExp(`grant select on table public\\.${view} to anon, authenticated`, 'i'));
  }
  assert.doesNotMatch(sql, /grant\s+(?:insert|update|delete|all)\s+on\s+table\s+public\.(?:prediction_tickets_safe|ticket_selections_safe)\s+to\s+(?:public|anon|authenticated)/i);
  assert.doesNotMatch(sql, /insert into public\.prediction_tickets|update public\.prediction_tickets|delete from public\.prediction_tickets/i);
});

test('browser roles cannot invoke the SECURITY DEFINER outcome mutators', () => {
  assert.match(sql, /revoke all on function public\.refresh_prediction_ticket_outcome\(bigint\)\s+from public, anon, authenticated/i);
  assert.match(sql, /revoke all on function public\.sync_prediction_ticket_outcome\(\)\s+from public, anon, authenticated/i);
  assert.match(docs, /read-only/i);
});
