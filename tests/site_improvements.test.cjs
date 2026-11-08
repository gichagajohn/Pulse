const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const pricingSql = fs.readFileSync(path.join(root, 'database', '20261108_access_pricing_100_500.sql'), 'utf8');
const originalAdminSql = fs.readFileSync(path.join(root, 'database', '20261106_admin_dashboard.sql'), 'utf8');
const edgeSource = fs.readFileSync(path.join(root, 'supabase', 'functions', 'stk-push', 'index.ts'), 'utf8');

test('Daily and Weekly prices are KSh 100/500 in display, payment labels, edge function and RLS', () => {
  assert.match(html, /<div class="price-amount">KSh 100<\/div>/);
  assert.match(html, /<div class="price-amount">KSh 500<\/div>/);
  assert.match(html, /daily: 'Daily Pass, KSh 100', weekly: 'Weekly Pass, KSh 500'/);
  assert.match(html, /daily: \{ title: 'Daily Pass', duration: '24 hours', amount: 100 \}/);
  assert.match(html, /weekly: \{ title: 'Weekly Pass', duration: '7 days', amount: 500 \}/);
  assert.doesNotMatch(html, /KSh 1,000|KSh 5,000|KSh 1000|KSh 5000/);
  assert.match(edgeSource, /daily:\s*100/);
  assert.match(edgeSource, /weekly:\s*500/);
  assert.doesNotMatch(edgeSource, /daily:\s*1000|weekly:\s*5000/);
  assert.match(pricingSql, /plan = 'daily' and amount = 100/i);
  assert.match(pricingSql, /plan = 'weekly' and amount = 500/i);
  assert.doesNotMatch(pricingSql, /amount = 1000|amount = 5000/i);
});

test('STK initiation has no fragile remote import and preserves authenticated server-side pricing', () => {
  assert.doesNotMatch(edgeSource, /^\s*import\s/m);
  assert.match(edgeSource, /\/auth\/v1\/user/);
  assert.match(edgeSource, /\/rest\/v1\/pending_payments/);
  assert.match(edgeSource, /if \(!authHeader\) return jsonResponse\(\{ error: "Not signed in\." \}, 401\)/);
  assert.match(edgeSource, /if \(!pendingResponse\.ok\)/);
  assert.match(edgeSource, /Contact support before retrying/);
});

test('failed STK requests clear the requesting state without claiming a push was confirmed', () => {
  assert.equal((html.match(/Request failed\. No STK push was confirmed; check your phone before retrying\./g) || []).length, 2);
  assert.match(html, /statusEl\.textContent = '';\s*statusEl\.style\.color = '';/);
});

test('pricing migration changes only the future insert policy and preserves historical amounts', () => {
  assert.match(pricingSql, /drop policy if exists "Users can create own pending payments"/i);
  assert.match(pricingSql, /for insert\s+to authenticated\s+with check/i);
  assert.match(pricingSql, /\(select auth\.uid\(\)\) = user_id/i);
  assert.match(pricingSql, /status = 'pending'/i);
  assert.doesNotMatch(pricingSql, /\bupdate\s+public\.(subscriptions|pending_payments)/i);
  assert.doesNotMatch(pricingSql, /\bdelete\s+from\s+public\.(subscriptions|pending_payments)/i);
  assert.doesNotMatch(pricingSql, /\binsert\s+into\s+public\.(subscriptions|pending_payments)/i);
  assert.doesNotMatch(pricingSql, /grant select|for\s+select\b/i);
  assert.match(originalAdminSql, /plan = 'daily' and amount = 1000/i);
  assert.match(originalAdminSql, /plan = 'weekly' and amount = 5000/i);
});

test('social sharing, canonical and crawler metadata are complete for the static site', () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/pulse-iota-teal\.vercel\.app\/">/);
  ['og:type', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:width', 'og:image:height'].forEach(property => {
    assert.match(html, new RegExp(`property="${property}"`));
  });
  assert.match(html, /og:image" content="https:\/\/pulse-iota-teal\.vercel\.app\/og-image\.png"/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.match(html, /"@type":"WebSite"/);
  const png = fs.readFileSync(path.join(root, 'og-image.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
  assert.match(robots, /Disallow: \/admin\.html/);
  assert.match(robots, /Sitemap: https:\/\/pulse-iota-teal\.vercel\.app\/sitemap\.xml/);
  const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/pulse-iota-teal\.vercel\.app\/<\/loc>/);
  assert.doesNotMatch(sitemap, /admin\.html/);
});

test('public pages are genuinely public while protected analysis stays server-locked', () => {
  assert.match(html, /const AUTH_REQUIRED_PAGES = \[\];/);
  assert.match(html, /Exact markets, odds, and rationales remain locked server-side/);
  assert.match(html, /sb\.rpc\('get_daily_picks'\)/);
  assert.doesNotMatch(html, /AUTH_REQUIRED_PAGES = \['picks', 'performance'\]/);
});

test('free and paid benefits are accessible and unsupported Weekly claims are removed', () => {
  assert.equal((html.match(/<span class="sr-only">Not included: <\/span>/g) || []).length, 2);
  assert.doesNotMatch(html, /Priority access to early published picks|Historical match analysis archive/);
  assert.match(html, /Every published matchday during your pass/);
  assert.match(html, /One payment for continuous access/);
});

test('checkout uses accurate M-Pesa and responsible-gambling wording', () => {
  assert.match(html, /Secure M-Pesa STK Push · No card required · Access activates after payment confirmation\./);
  assert.match(html, /<strong>18\+ only\.<\/strong> Probabilistic analysis, not guaranteed outcomes\./);
  assert.match(html, /Access is granted after payment confirmation\./);
  assert.doesNotMatch(html, /access is granted immediately upon payment/i);
  assert.doesNotMatch(html, /Instant STK Push/);
});

test('schedule, provider coverage and performance copy do not overclaim', () => {
  assert.equal((html.match(/Scheduled daily at 07:00 EAT/g) || []).length, 5);
  assert.doesNotMatch(html, /Published daily at 07:00 EAT/);
  assert.match(html, /Injuries and weather are included only when available from our providers/);
  assert.match(html, /major leagues and selected competitions/i);
  assert.doesNotMatch(html, /Europe’s top five leagues|Top five European leagues/);
  assert.match(html, /Hit rate alone does not establish profitability/);
  assert.doesNotMatch(html, /64% Win Rate|65\.3% Win Rate|guaranteed winnings/i);
  assert.match(html, /id="hero-settled-count">Loading…/);
  assert.match(html, /hero-settled-count'\)\.textContent = `\$\{selections\.length\}`/);
  assert.match(html, /hero-outcomes'\)\.textContent = `\$\{won\}W · \$\{lost\}L · \$\{outcomeCounts\.void\}V`/);
});

test('ticket publication time, empty states, retries and no-JavaScript fallback are present', () => {
  assert.match(html, /final_confidence, risk_level, created_at/);
  assert.match(html, /FixtureTime\.formatKickoffEAT\(data\.created_at\)/);
  assert.match(html, / · Published \$\{publishedLabel\}/);
  assert.match(html, /No published selections for today/);
  assert.match(html, /“No Bet” is preferable to a weak selection/);
  assert.match(html, /onclick="renderPicks\(\)">Retry loading picks/);
  assert.match(html, /onclick="renderPerformance\(\)">Retry loading performance/);
  assert.match(html, /<noscript><div class="noscript-banner">/);
});

test('support link works without Cloudflare email decoding', () => {
  assert.match(html, /href="mailto:jp925196@gmail\.com\?subject=Football%20Pulse%20Support"/);
  assert.doesNotMatch(html, /\/cdn-cgi\/l\/email-protection|email-decode\.min\.js/);
});
