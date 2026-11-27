// Authenticated PayHero reconciliation and idempotent pass activation.
// `verify_jwt` may be disabled at the edge gateway for compatibility, so this
// function always validates the caller's bearer token against Supabase Auth.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PAYHERO_USERNAME = Deno.env.get("PAYHERO_API_USERNAME");
const PAYHERO_PASSWORD = Deno.env.get("PAYHERO_API_PASSWORD");

const PAYMENT_AMOUNTS = { daily: 100, weekly: 500 };
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function serviceHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  };
}

function restUrl(table, filters) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(filters).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

async function authenticateUser(req) {
  const authorization = req.headers.get("Authorization");
  if (!authorization) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user?.id === "string" ? user : null;
}

function mapPayheroStatus(raw) {
  const status = String(raw || "").toUpperCase();
  if (status === "SUCCESS" || status === "COMPLETED") return "success";
  if (status === "FAILED" || status === "CANCELLED" || status === "TIMEOUT") return "failed";
  return "pending";
}

function findLedgerPayment(transactions, pending) {
  return (Array.isArray(transactions) ? transactions : []).find(transaction =>
    String(transaction.transaction_type || "").toLowerCase() === "inbound_payment" &&
    transaction.external_reference === pending.external_reference &&
    Number(transaction.amount) === Number(pending.amount) &&
    Boolean(transaction.transaction_reference)
  ) || null;
}

async function readPending(checkoutRequestId) {
  const response = await fetch(restUrl("pending_payments", {
    select: "*",
    checkout_request_id: `eq.${checkoutRequestId}`,
    limit: "1"
  }), { headers: serviceHeaders() });
  if (!response.ok) throw new Error(`Could not read pending payment (${response.status}).`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function readAttemptLockByCheckout(checkoutRequestId) {
  const response = await fetch(restUrl("payment_attempt_locks", {
    select: "user_id,external_reference,plan,amount,checkout_request_id,status,created_at",
    checkout_request_id: `eq.${checkoutRequestId}`,
    limit: "1"
  }), { headers: serviceHeaders() });
  if (!response.ok) throw new Error(`Could not read payment reservation (${response.status}).`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function persistPendingFromLock(lock) {
  const response = await fetch(restUrl("pending_payments", { on_conflict: "checkout_request_id" }), {
    method: "POST",
    headers: serviceHeaders({
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal"
    }),
    body: JSON.stringify({
      user_id: lock.user_id,
      plan: lock.plan,
      amount: Number(lock.amount),
      external_reference: lock.external_reference,
      checkout_request_id: lock.checkout_request_id,
      status: "pending",
      created_at: lock.created_at
    })
  });
  if (!response.ok) throw new Error(`Could not restore pending payment (${response.status}).`);
}

async function updateAttemptLock(pending) {
  const response = await fetch(restUrl("payment_attempt_locks", {
    user_id: `eq.${pending.user_id}`,
    external_reference: `eq.${pending.external_reference}`
  }), {
    method: "PATCH",
    headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify({ checkout_request_id: pending.checkout_request_id, status: "pending" })
  });
  if (!response.ok) throw new Error(`Could not update payment reservation (${response.status}).`);
}

async function releaseAttemptLock(pending) {
  const response = await fetch(restUrl("payment_attempt_locks", {
    user_id: `eq.${pending.user_id}`,
    external_reference: `eq.${pending.external_reference}`
  }), {
    method: "DELETE",
    headers: serviceHeaders({ Prefer: "return=minimal" })
  });
  if (!response.ok) throw new Error(`Could not release payment reservation (${response.status}).`);
}

async function updatePending(pending, status, reference) {
  const body = { status };
  if (reference) body.payhero_reference = reference;
  const response = await fetch(restUrl("pending_payments", {
    checkout_request_id: `eq.${pending.checkout_request_id}`,
    status: "eq.pending"
  }), {
    method: "PATCH",
    headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Could not update pending payment (${response.status}).`);
}

async function fetchProviderStatus(reference, authToken) {
  const response = await fetch(
    `https://backend.payhero.co.ke/api/v2/transaction-status?reference=${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Basic ${authToken}` } }
  );
  const body = await response.json().catch(() => ({}));
  return { httpStatus: response.status, body };
}

async function findLedgerReference(pending, authToken) {
  for (let page = 1; page <= 3; page += 1) {
    const response = await fetch(
      `https://backend.payhero.co.ke/api/v2/transactions?page=${page}&per_page=100`,
      { headers: { Authorization: `Basic ${authToken}` } }
    );
    if (!response.ok) throw new Error(`PayHero ledger failed (${response.status}).`);
    const data = await response.json();
    const match = findLedgerPayment(data?.transactions, pending);
    if (match) return match;
    const pages = Number(data?.pagination?.num_pages || page);
    if (page >= pages) break;
  }
  return null;
}

async function resolveProviderPayment(pending, authToken) {
  let reference = pending.payhero_reference || null;
  let ledger = null;
  let result = reference ? await fetchProviderStatus(reference, authToken) : null;

  if (!result || result.httpStatus === 404) {
    ledger = await findLedgerReference(pending, authToken);
    if (ledger?.transaction_reference) {
      reference = ledger.transaction_reference;
      result = await fetchProviderStatus(reference, authToken);
    }
  }

  if (!reference || !result || result.httpStatus === 404) return { state: "pending", reference };
  if (result.httpStatus < 200 || result.httpStatus >= 300) {
    throw new Error(`PayHero status failed (${result.httpStatus}).`);
  }

  const body = result.body || {};
  const state = mapPayheroStatus(body.status);
  if (state === "pending") return { state, reference };
  if (body.external_reference !== pending.external_reference || Number(body.amount) !== Number(pending.amount)) {
    throw new Error("PayHero reference or amount mismatch; activation blocked.");
  }

  return {
    state,
    reference,
    receipt: body.provider_reference || body.third_party_reference || ledger?.provider_reference || null,
    transactionDate: body.transaction_date || ledger?.created_at || null
  };
}

async function readSubscriptionByCheckout(checkoutRequestId) {
  const response = await fetch(restUrl("subscriptions", {
    select: "user_id,plan,amount,mpesa_checkout_request_id,started_at,expires_at",
    mpesa_checkout_request_id: `eq.${checkoutRequestId}`,
    limit: "1"
  }), { headers: serviceHeaders() });
  if (!response.ok) throw new Error(`Could not verify existing subscription (${response.status}).`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function latestPaidExpiry(userId, referenceDate) {
  const response = await fetch(restUrl("subscriptions", {
    select: "expires_at",
    user_id: `eq.${userId}`,
    status: "eq.active",
    expires_at: `gt.${referenceDate.toISOString()}`,
    order: "expires_at.desc",
    limit: "1"
  }), { headers: serviceHeaders() });
  if (!response.ok) throw new Error(`Could not check existing access (${response.status}).`);
  const rows = await response.json();
  const expiry = Array.isArray(rows) ? rows[0]?.expires_at : null;
  const timestamp = expiry ? new Date(expiry).getTime() : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

async function activateSubscription(pending, provider) {
  const expectedAmount = PAYMENT_AMOUNTS[pending.plan];
  if (!expectedAmount || Number(pending.amount) !== expectedAmount) {
    throw new Error("Payment plan or amount mismatch; activation blocked.");
  }

  // A repeated status check for the same checkout must not extend access again.
  const existing = await readSubscriptionByCheckout(pending.checkout_request_id);
  if (existing) {
    if (existing.user_id !== pending.user_id || existing.plan !== pending.plan || Number(existing.amount) !== expectedAmount) {
      throw new Error("Existing subscription does not match payment; activation blocked.");
    }
    return;
  }

  const parsedStart = new Date(provider.transactionDate || Date.now());
  const transactionStart = Number.isNaN(parsedStart.getTime()) ? new Date() : parsedStart;
  const duration = pending.plan === "daily"
    ? 24 * 60 * 60 * 1000
    : pending.plan === "weekly"
      ? 7 * 24 * 60 * 60 * 1000
      : null;
  if (!duration) throw new Error("Invalid plan; activation blocked.");

  // Purchases made during an active pass queue from its latest expiry instead
  // of consuming time that the customer has already paid for.
  const currentExpiry = await latestPaidExpiry(pending.user_id, transactionStart);
  const started = currentExpiry && currentExpiry > transactionStart ? currentExpiry : transactionStart;
  const subscription = {
    user_id: pending.user_id,
    plan: pending.plan,
    status: "active",
    amount: expectedAmount,
    mpesa_checkout_request_id: pending.checkout_request_id,
    mpesa_receipt_number: provider.receipt,
    started_at: started.toISOString(),
    expires_at: new Date(started.getTime() + duration).toISOString()
  };

  const response = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=mpesa_checkout_request_id`, {
    method: "POST",
    headers: serviceHeaders({
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal"
    }),
    body: JSON.stringify(subscription)
  });
  if (!response.ok) throw new Error(`Could not activate subscription (${response.status}).`);
}

async function getAccessStatus(userId) {
  const now = new Date();
  const response = await fetch(restUrl("subscriptions", {
    select: "plan,started_at,expires_at",
    user_id: `eq.${userId}`,
    status: "eq.active",
    expires_at: `gt.${now.toISOString()}`,
    order: "expires_at.desc",
    limit: "20"
  }), { headers: serviceHeaders() });
  if (!response.ok) throw new Error(`Could not read access status (${response.status}).`);
  const rows = await response.json();
  const validRows = (Array.isArray(rows) ? rows : []).filter(row => {
    const startsAt = new Date(row.started_at).getTime();
    const expiresAt = new Date(row.expires_at).getTime();
    return Number.isFinite(startsAt) && Number.isFinite(expiresAt) && expiresAt > now.getTime();
  });
  const activeNow = validRows.filter(row => new Date(row.started_at).getTime() <= now.getTime());
  const latest = validRows[0] || null;
  return {
    hasActivePass: activeNow.length > 0,
    expiresAt: latest?.expires_at || null,
    plan: latest?.plan || null
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const user = await authenticateUser(req);
    if (!user) return jsonResponse({ error: "Unauthorized." }, 401);

    const body = await req.json().catch(() => null);
    if (body?.action === "access") return jsonResponse(await getAccessStatus(user.id));

    const checkoutRequestId = body?.checkoutRequestId;
    if (typeof checkoutRequestId !== "string" || checkoutRequestId.length < 1 || checkoutRequestId.length > 200) {
      return jsonResponse({ error: "Missing or invalid checkoutRequestId." }, 400);
    }

    let pending = await readPending(checkoutRequestId);
    let recoveredLock = null;
    if (!pending) {
      // If PayHero accepted an STK but pending_payments persistence failed,
      // recover the attempt from the private reservation and recreate the
      // pending row before reconciling. Ownership is checked before any write.
      const lock = await readAttemptLockByCheckout(checkoutRequestId);
      if (!lock || lock.user_id !== user.id) return jsonResponse({ status: "unknown" }, 404);
      const lockAmount = PAYMENT_AMOUNTS[lock.plan];
      if (!lockAmount || Number(lock.amount) !== lockAmount || lock.checkout_request_id !== checkoutRequestId) {
        return jsonResponse({ error: "Payment record could not be verified." }, 409);
      }
      recoveredLock = lock;
      await persistPendingFromLock(lock);
      pending = await readPending(checkoutRequestId);
    }

    // Same response for missing and foreign IDs: don't expose another user's
    // payment state to a caller who happens to know a checkout ID.
    if (!pending || pending.user_id !== user.id) return jsonResponse({ status: "unknown" }, 404);
    if (recoveredLock && (pending.external_reference !== recoveredLock.external_reference ||
      pending.plan !== recoveredLock.plan || Number(pending.amount) !== Number(recoveredLock.amount))) {
      return jsonResponse({ error: "Payment record could not be verified." }, 409);
    }

    const expectedAmount = PAYMENT_AMOUNTS[pending.plan];
    if (!expectedAmount || Number(pending.amount) !== expectedAmount) {
      return jsonResponse({ error: "Payment record could not be verified." }, 409);
    }

    const authToken = btoa(`${PAYHERO_USERNAME}:${PAYHERO_PASSWORD}`);
    const provider = await resolveProviderPayment(pending, authToken);

    if (provider.state === "success") {
      await activateSubscription(pending, provider);
      await updatePending(pending, "success", provider.reference);
      await releaseAttemptLock(pending);
    } else if (provider.state === "failed") {
      await updatePending(pending, "failed", provider.reference);
      await releaseAttemptLock(pending);
    } else {
      if (provider.reference && provider.reference !== pending.payhero_reference) {
        await updatePending(pending, pending.status, provider.reference);
      }
      await updateAttemptLock(pending);
    }

    return jsonResponse({ status: provider.state });
  } catch (error) {
    console.error("check-status error", error?.message || error);
    return jsonResponse({ error: "Payment confirmation is temporarily unavailable." }, 500);
  }
});
