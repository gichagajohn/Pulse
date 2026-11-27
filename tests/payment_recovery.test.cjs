const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const stk = fs.readFileSync(path.join(root, 'supabase', 'functions', 'stk-push', 'index.ts'), 'utf8');
const status = fs.readFileSync(path.join(root, 'supabase', 'functions', 'check-status', 'index.ts'), 'utf8');

function jsonResponse(body, statusCode = 200) {
  return new Response(JSON.stringify(body), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
}

function emptyResponse(statusCode = 204) {
  return new Response(null, { status: statusCode });
}

function loadEdgeHandler(source, fetchImpl, env = {}) {
  let handler = null;
  const context = vm.createContext({
    Deno: {
      env: { get: key => env[key] },
      serve: callback => { handler = callback; }
    },
    fetch: fetchImpl,
    Response,
    URL,
    URLSearchParams,
    crypto: { randomUUID: () => 'test-random-id-1234' },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    console: { error() {} }
  });
  vm.runInContext(source, context);
  assert.equal(typeof handler, 'function');
  return handler;
}

function paymentRequest() {
  return new Request('https://edge.example/functions/v1/stk-push', {
    method: 'POST',
    headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '0712 345 678', plan: 'daily' })
  });
}

function createPaymentWorld({ providerFetch } = {}) {
  const env = {
    SUPABASE_URL: 'https://project.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    PAYHERO_API_USERNAME: 'username',
    PAYHERO_API_PASSWORD: 'password',
    PAYHERO_CHANNEL_ID: '123',
    PAYHERO_CALLBACK_URL: 'https://project.test/functions/v1/mpesa-callback'
  };
  const state = { pending: [], lock: null, calls: [], providerCalls: 0 };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const call = { url, method, body: init.body ? JSON.parse(init.body) : null };
    state.calls.push(call);

    if (url.pathname === '/auth/v1/user') return jsonResponse({ id: 'user-12345678' });
    if (url.pathname === '/rest/v1/payment_attempt_locks') {
      if (method === 'POST') {
        if (state.lock) return jsonResponse({ code: '23505' }, 409);
        state.lock = call.body;
        state.lock.created_at = '2026-11-04T10:00:00.000Z';
        return emptyResponse(201);
      }
      if (method === 'GET') return jsonResponse(state.lock ? [state.lock] : []);
      if (method === 'PATCH') {
        if (state.lock && url.searchParams.get('user_id') === `eq.${state.lock.user_id}` &&
            url.searchParams.get('external_reference') === `eq.${state.lock.external_reference}`) {
          Object.assign(state.lock, call.body);
        }
        return emptyResponse();
      }
      if (method === 'DELETE') {
        if (state.lock && url.searchParams.get('user_id') === `eq.${state.lock.user_id}` &&
            url.searchParams.get('external_reference') === `eq.${state.lock.external_reference}`) state.lock = null;
        return emptyResponse();
      }
    }
    if (url.pathname === '/rest/v1/pending_payments') {
      if (method === 'GET') {
        const userFilter = url.searchParams.get('user_id')?.replace(/^eq\./, '');
        const checkoutFilter = url.searchParams.get('checkout_request_id')?.replace(/^eq\./, '');
        const statusFilter = url.searchParams.get('status')?.replace(/^eq\./, '');
        const rows = state.pending.filter(row => (!userFilter || row.user_id === userFilter) &&
          (!checkoutFilter || row.checkout_request_id === checkoutFilter) && (!statusFilter || row.status === statusFilter));
        return jsonResponse(rows.slice(0, Number(url.searchParams.get('limit') || rows.length)));
      }
      if (method === 'POST') {
        if (!state.pending.some(row => row.checkout_request_id === call.body.checkout_request_id)) state.pending.push(call.body);
        return emptyResponse(201);
      }
    }
    if (url.hostname === 'backend.payhero.co.ke') {
      state.providerCalls += 1;
      return providerFetch ? providerFetch(call) : jsonResponse({ success: true, CheckoutRequestID: 'checkout-123', reference: 'payhero-ref' });
    }
    throw new Error(`Unexpected mocked request: ${method} ${url}`);
  };
  return { state, handler: loadEdgeHandler(stk, fetchImpl, env) };
}

test('payment flow resumes a saved request and uses one sequential timeout loop', () => {
  assert.match(html, /sessionStorage\.setItem\(paymentStorageKey\(currentSession\.user\.id\)/);
  assert.match(html, /sessionStorage\.getItem\(paymentStorageKey\(userId\)\)/);
  assert.match(html, /restorePendingPayment\(nextUserId\)/);
  assert.match(html, /paymentPollTimer = setTimeout\(checkOnce/);
  assert.doesNotMatch(html, /setInterval\(async\s*\(\)\s*=>\s*\{[\s\S]*?check-status/);
  assert.match(html, /Do not pay again while this request is pending/);
  assert.match(html, /Check status again/);
  assert.doesNotMatch(html, /textContent = 'Try Again'/);
});

test('function error bodies are parsed defensively and only allowlisted messages are shown', () => {
  assert.match(html, /error\?\.context && typeof error\.context\.json === 'function'/);
  assert.match(html, /SAFE_PAYMENT_MESSAGES\.has\(candidate\)/);
  assert.match(stk, /Payment service is temporarily unavailable/);
  assert.doesNotMatch(stk, /return jsonResponse\(\{\s*error: error\.message\s*\}, 500\)/);
});

test('Kenyan mobile validation is strict on both client and server', () => {
  const phone = require('../phone-number.js');
  for (const [input, expected] of [
    ['0712 345 678', '254712345678'],
    ['0112 345 678', '254112345678'],
    ['712345678', '254712345678'],
    ['+254 112 345 678', '254112345678'],
    ['254712345678', '254712345678']
  ]) assert.equal(phone.normalizeKenyanMobile(input), expected);
  for (const input of ['0712 34567', '254912345678', '254999999999', 'hello0712345678', '+254 712 345 67a', '']) {
    assert.equal(phone.normalizeKenyanMobile(input), null, input);
  }
  assert.equal(phone.maskKenyanMobile('254712345678'), '2547•• ••• 678');
  assert.match(stk, /function normalizeKenyanMobile\(raw\)/);
  assert.match(stk, /254\[17\]\\d\{8\}/);
  assert.match(html, /window\.PulsePhone\?\.normalizeKenyanMobile\(rawPhone\)/);
});

test('stk-push atomically reserves one per-user attempt before sending an STK prompt', () => {
  const existingPending = stk.indexOf('const existingPending = await findExistingPendingPayment(userId)');
  const reserve = stk.indexOf('await reserveAttemptLock(userId, plan, amount, externalReference)');
  const provider = stk.indexOf('https://backend.payhero.co.ke/api/v2/payments');
  assert.ok(existingPending >= 0 && reserve > existingPending && provider > reserve);
  assert.match(stk, /payment_attempt_locks/);
  assert.match(stk, /checkoutRequestId,\s*plan: attempt\.plan/);
  assert.match(stk, /A payment is already awaiting confirmation/);
  assert.match(stk, /A payment attempt is already being processed or needs support/);
  assert.match(stk, /safeToRetry: true/);
  assert.match(stk, /supportReference: externalReference/);
  assert.match(stk, /resolution=ignore-duplicates,return=minimal/);
});

test('payment lock migration is service-role-only and reserves one attempt per user', () => {
  const migration = fs.readFileSync(path.join(root, 'database', '20261104_payment_attempt_locks.sql'), 'utf8');
  assert.match(migration, /user_id uuid primary key references auth\.users\(id\) on delete cascade/i);
  assert.match(migration, /external_reference text not null unique/i);
  assert.match(migration, /checkout_request_id text unique/i);
  assert.match(migration, /alter table public\.payment_attempt_locks enable row level security/i);
  assert.match(migration, /revoke all on table public\.payment_attempt_locks from public, anon, authenticated/i);
  assert.match(migration, /grant all on table public\.payment_attempt_locks to service_role/i);
  assert.match(migration, /status in \('initiating', 'pending'\)/i);
});

test('STK requests take the lock first, persist the provider ID, and never save the phone number', async () => {
  const { handler, state } = createPaymentWorld();
  const response = await handler(paymentRequest());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.checkoutRequestId, 'checkout-123');
  assert.equal(state.providerCalls, 1);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].user_id, 'user-12345678');
  assert.equal(state.pending[0].amount, 100);
  assert.equal(state.pending[0].phone_number, undefined);
  assert.equal(state.lock.checkout_request_id, 'checkout-123');
  assert.equal(state.lock.status, 'pending');
  const reservationIndex = state.calls.findIndex(call => call.url.pathname === '/rest/v1/payment_attempt_locks' && call.method === 'POST');
  const providerIndex = state.calls.findIndex(call => call.url.hostname === 'backend.payhero.co.ke');
  assert.ok(reservationIndex >= 0 && providerIndex > reservationIndex);
  const providerBody = state.calls[providerIndex].body;
  assert.equal(providerBody.phone_number, '254712345678');
  assert.equal(providerBody.amount, 100);
});

test('parallel STK submissions create at most one provider request', async () => {
  const { handler, state } = createPaymentWorld();
  const [first, second] = await Promise.all([handler(paymentRequest()), handler(paymentRequest())]);
  assert.equal(state.providerCalls, 1);
  assert.ok([first.status, second.status].includes(200));
  assert.ok([first.status, second.status].includes(409));
  const followUp = await handler(paymentRequest());
  const body = await followUp.json();
  assert.equal(followUp.status, 409);
  assert.equal(body.checkoutRequestId, 'checkout-123');
  assert.equal(state.providerCalls, 1);
});

test('ambiguous provider timeouts keep the user lock and block another STK request', async () => {
  const { handler, state } = createPaymentWorld({ providerFetch: async () => { throw new Error('network reset'); } });
  const first = await handler(paymentRequest());
  const firstBody = await first.json();
  assert.equal(first.status, 500);
  assert.equal(firstBody.safeToRetry, undefined);
  assert.match(firstBody.supportReference, /^FP-user-123-?/);
  assert.ok(state.lock);
  const second = await handler(paymentRequest());
  const secondBody = await second.json();
  assert.equal(second.status, 409);
  assert.ok(secondBody.supportReference);
  assert.equal(state.providerCalls, 1);
});

test('only an explicit provider rejection releases the lock for a safe retry', async () => {
  const { handler, state } = createPaymentWorld({
    providerFetch: async () => jsonResponse({ success: false, error_code: 'REJECTED' })
  });
  const response = await handler(paymentRequest());
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.safeToRetry, true);
  assert.equal(state.lock, null);
});

test('check-status authenticates and owner-checks before querying PayHero', () => {
  assert.match(status, /async function authenticateUser\(req\)/);
  assert.match(status, /if \(!user\) return jsonResponse\(\{ error: "Unauthorized\." \}, 401\)/);
  const ownerCheck = status.indexOf('pending.user_id !== user.id');
  const providerLookup = status.indexOf('const provider = await resolveProviderPayment(pending, authToken)');
  assert.ok(ownerCheck >= 0 && providerLookup > ownerCheck);
  assert.match(status, /Same response for missing and foreign IDs/);
  assert.match(status, /body\?\.action === "access"/);
});

test('check-status recovers a lost pending-row write from the owned lock and releases terminal attempts', () => {
  assert.match(status, /readAttemptLockByCheckout\(checkoutRequestId\)/);
  assert.match(status, /if \(!lock \|\| lock\.user_id !== user\.id\)/);
  assert.match(status, /persistPendingFromLock\(lock\)/);
  assert.match(status, /await releaseAttemptLock\(pending\)/);
  assert.match(status, /await updateAttemptLock\(pending\)/);
});

test('check-status returns the same unknown response for a foreign checkout and never calls PayHero', async () => {
  let providerCalls = 0;
  const env = {
    SUPABASE_URL: 'https://project.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    PAYHERO_API_USERNAME: 'username',
    PAYHERO_API_PASSWORD: 'password'
  };
  const handler = loadEdgeHandler(status, async input => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/auth/v1/user') return jsonResponse({ id: 'owner-a' });
    if (url.pathname === '/rest/v1/pending_payments') {
      return jsonResponse([{ user_id: 'owner-b', checkout_request_id: 'foreign-checkout', plan: 'daily', amount: 100 }]);
    }
    if (url.hostname === 'backend.payhero.co.ke') providerCalls += 1;
    throw new Error(`Unexpected mocked request: ${url}`);
  }, env);
  const response = await handler(new Request('https://edge.example/functions/v1/check-status', {
    method: 'POST',
    headers: { Authorization: 'Bearer owner-a-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkoutRequestId: 'foreign-checkout' })
  }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { status: 'unknown' });
  assert.equal(providerCalls, 0);
});

test('check-status restores a missing pending row from its owned lock and activates only verified success', async () => {
  const externalReference = 'FP-owner-a-unique';
  const checkoutRequestId = 'checkout-recovery';
  const state = {
    lock: {
      user_id: 'owner-a', external_reference: externalReference, plan: 'daily', amount: 100,
      checkout_request_id: checkoutRequestId, status: 'pending', created_at: '2026-11-04T10:00:00.000Z'
    },
    pending: [],
    subscriptions: []
  };
  const env = {
    SUPABASE_URL: 'https://project.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    PAYHERO_API_USERNAME: 'username',
    PAYHERO_API_PASSWORD: 'password'
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.pathname === '/auth/v1/user') return jsonResponse({ id: 'owner-a' });
    if (url.pathname === '/rest/v1/payment_attempt_locks') {
      if (method === 'GET') return jsonResponse(state.lock && state.lock.checkout_request_id === 'checkout-recovery' ? [state.lock] : []);
      if (method === 'DELETE') { state.lock = null; return emptyResponse(); }
      if (method === 'PATCH') { Object.assign(state.lock || {}, body); return emptyResponse(); }
    }
    if (url.pathname === '/rest/v1/pending_payments') {
      if (method === 'GET') {
        const id = url.searchParams.get('checkout_request_id')?.replace(/^eq\./, '');
        return jsonResponse(state.pending.filter(row => row.checkout_request_id === id));
      }
      if (method === 'POST') {
        if (!state.pending.some(row => row.checkout_request_id === body.checkout_request_id)) state.pending.push(body);
        return emptyResponse(201);
      }
      if (method === 'PATCH') {
        const id = url.searchParams.get('checkout_request_id')?.replace(/^eq\./, '');
        const row = state.pending.find(candidate => candidate.checkout_request_id === id && candidate.status === 'pending');
        if (row) Object.assign(row, body);
        return emptyResponse();
      }
    }
    if (url.pathname === '/rest/v1/subscriptions') {
      if (method === 'GET') {
        const checkoutId = url.searchParams.get('mpesa_checkout_request_id')?.replace(/^eq\./, '');
        return jsonResponse(checkoutId
          ? state.subscriptions.filter(row => row.mpesa_checkout_request_id === checkoutId)
          : []);
      }
      if (method === 'POST') {
        if (!state.subscriptions.some(row => row.mpesa_checkout_request_id === body.mpesa_checkout_request_id)) state.subscriptions.push(body);
        return emptyResponse(201);
      }
    }
    if (url.hostname === 'backend.payhero.co.ke' && url.pathname === '/api/v2/transactions') {
      return jsonResponse({
        transactions: [{ transaction_type: 'inbound_payment', external_reference: externalReference,
          amount: 100, transaction_reference: 'provider-ref', provider_reference: 'MPSA123', created_at: '2026-11-04T10:02:00.000Z' }],
        pagination: { num_pages: 1 }
      });
    }
    if (url.hostname === 'backend.payhero.co.ke' && url.pathname === '/api/v2/transaction-status') {
      return jsonResponse({ status: 'SUCCESS', external_reference: externalReference, amount: 100,
        provider_reference: 'MPSA123', transaction_date: '2026-11-04T10:02:00.000Z' });
    }
    throw new Error(`Unexpected mocked request: ${method} ${url}`);
  };
  const handler = loadEdgeHandler(status, fetchImpl, env);
  const response = await handler(new Request('https://edge.example/functions/v1/check-status', {
    method: 'POST',
    headers: { Authorization: 'Bearer owner-a-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkoutRequestId })
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'success' });
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].status, 'success');
  assert.equal(state.subscriptions.length, 1);
  assert.equal(state.subscriptions[0].user_id, 'owner-a');
  assert.equal(state.subscriptions[0].amount, 100);
  assert.equal(state.subscriptions[0].mpesa_checkout_request_id, checkoutRequestId);
  assert.equal(state.lock, null);
});

test('pass extensions are queued from the existing expiry and same-checkout retries are idempotent', () => {
  assert.match(status, /readSubscriptionByCheckout\(pending\.checkout_request_id\)/);
  assert.match(status, /if \(existing\) \{/);
  assert.match(status, /latestPaidExpiry\(pending\.user_id, transactionStart\)/);
  assert.match(status, /resolution=ignore-duplicates/);
  assert.match(status, /A repeated status check for the same checkout must not extend access again/);
});

test('routing ignores Supabase recovery hashes, supports history, and moves focus to the new page', () => {
  assert.match(html, /function pageFromLocationHash\(\)/);
  assert.match(html, /params\.getAll\('page'\)\.length !== 1/);
  assert.match(html, /if \(hasRecoveryHash\(\)\) return;/);
  assert.match(html, /window\.history\.pushState\(\{ pageId \}/);
  assert.match(html, /window\.addEventListener\('popstate', syncPageFromLocation\)/);
  assert.match(html, /targetPage\.focus\(\{ preventScroll: true \}\)/);
  assert.match(html, /behavior: reducedMotion \? 'auto' : 'smooth'/);
  assert.doesNotMatch(html, /mobileNavSelect/);
});

test('mobile access CTA only appears for locked picks; help and price are visible in the purchase flow', () => {
  assert.match(html, /picksAccessState === 'locked'/);
  assert.match(html, /id="mobilePurchaseBar"/);
  assert.match(html, /View passes · from KSh 100/);
  assert.match(html, /id="payment-help-title"|Paid but no access\?/);
  assert.match(html, /id="payment-modal-help"|Contact paid-access support/);
});

test('PWA shell caches only same-origin static assets and never API responses', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /serviceWorker\.register\('\/sw\.js'\)/);
  assert.match(sw, /if \(url\.origin !== self\.location\.origin\) return/);
  assert.match(sw, /CACHEABLE_PATHS\.has\(url\.pathname\)/);
  assert.match(sw, /API requests are deliberately left to the network and never cached here/);
});
