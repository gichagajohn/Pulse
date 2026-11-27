// Dependency-free, authenticated M-Pesa STK initiation via PayHero and Supabase REST/Auth.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PAYHERO_USERNAME = Deno.env.get("PAYHERO_API_USERNAME");
const PAYHERO_PASSWORD = Deno.env.get("PAYHERO_API_PASSWORD");
const PAYHERO_CHANNEL_ID = Deno.env.get("PAYHERO_CHANNEL_ID");
const PAYHERO_CALLBACK_URL = Deno.env.get("PAYHERO_CALLBACK_URL");

const PLAN_AMOUNTS = { daily: 100, weekly: 500 };
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

function restUrl(table, filters = {}) {
  const base = String(SUPABASE_URL || "").replace(/\/+$/, "");
  const url = new URL(`${base}/rest/v1/${table}`);
  Object.entries(filters).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function normalizeKenyanMobile(raw) {
  if (typeof raw !== "string") return null;
  const compact = raw.trim().replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  let digits = compact.startsWith("+") ? compact.slice(1) : compact;

  if (/^0[17]\d{8}$/.test(digits)) digits = `254${digits.slice(1)}`;
  else if (/^[17]\d{8}$/.test(digits)) digits = `254${digits}`;

  return /^254[17]\d{8}$/.test(digits) ? digits : null;
}

function serviceHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  };
}

async function findExistingPendingPayment(userId) {
  const response = await fetch(restUrl("pending_payments", {
    select: "user_id,checkout_request_id,external_reference,plan,amount,created_at",
    user_id: `eq.${userId}`,
    status: "eq.pending",
    order: "created_at.desc",
    limit: "1"
  }), { headers: serviceHeaders() });
  if (!response.ok) throw new Error(`Could not check for an existing payment (${response.status}).`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function readAttemptLock(userId) {
  const response = await fetch(restUrl("payment_attempt_locks", {
    select: "user_id,external_reference,plan,amount,checkout_request_id,status,created_at",
    user_id: `eq.${userId}`,
    limit: "1"
  }), { headers: serviceHeaders() });
  if (!response.ok) throw new Error(`Could not check the payment reservation (${response.status}).`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function reserveAttemptLock(userId, plan, amount, externalReference) {
  const response = await fetch(restUrl("payment_attempt_locks"), {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify({
      user_id: userId,
      external_reference: externalReference,
      plan,
      amount,
      status: "initiating"
    })
  });
  if (response.ok) return { created: true, existing: null };
  if (response.status === 409) return { created: false, existing: await readAttemptLock(userId) };
  throw new Error(`Could not reserve a payment attempt (${response.status}).`);
}

async function updateAttemptLock(userId, externalReference, checkoutRequestId) {
  const response = await fetch(restUrl("payment_attempt_locks", {
    user_id: `eq.${userId}`,
    external_reference: `eq.${externalReference}`
  }), {
    method: "PATCH",
    headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify({ checkout_request_id: checkoutRequestId, status: "pending" })
  });
  if (!response.ok) throw new Error(`Could not update the payment reservation (${response.status}).`);
}

async function releaseAttemptLock(userId, externalReference) {
  const response = await fetch(restUrl("payment_attempt_locks", {
    user_id: `eq.${userId}`,
    external_reference: `eq.${externalReference}`
  }), {
    method: "DELETE",
    headers: serviceHeaders({ Prefer: "return=minimal" })
  });
  return response.ok;
}

async function findPendingByCheckoutId(checkoutRequestId) {
  const response = await fetch(restUrl("pending_payments", {
    select: "user_id,checkout_request_id,external_reference,plan,amount,status,created_at",
    checkout_request_id: `eq.${checkoutRequestId}`,
    limit: "1"
  }), { headers: serviceHeaders() });
  if (!response.ok) throw new Error(`Could not verify the saved payment (${response.status}).`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

function existingAttemptResponse(attempt) {
  const planIsValid = Object.prototype.hasOwnProperty.call(PLAN_AMOUNTS, attempt?.plan) &&
    Number(attempt?.amount) === PLAN_AMOUNTS[attempt.plan];
  const checkoutRequestId = typeof attempt?.checkout_request_id === "string"
    ? attempt.checkout_request_id
    : null;
  if (planIsValid && checkoutRequestId && checkoutRequestId.length <= 200) {
    return jsonResponse({
      error: "A payment is already awaiting confirmation. Check its status before starting another request.",
      status: "pending",
      checkoutRequestId,
      plan: attempt.plan,
      createdAt: attempt.created_at
    }, 409);
  }
  return jsonResponse({
    error: "A payment attempt is already being processed or needs support. Do not pay again; contact paid-access support.",
    status: "pending",
    ...(attempt?.external_reference ? { supportReference: attempt.external_reference } : {})
  }, 409);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed.", safeToRetry: true }, 405);

  let userId = null;
  let externalReference = null;
  let reservationCreated = false;
  let providerCallStarted = false;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization.", safeToRetry: true }, 401);

    const userResponse = await fetch(`${String(SUPABASE_URL || "").replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: SUPABASE_SERVICE_ROLE_KEY }
    });
    if (!userResponse.ok) return jsonResponse({ error: "Unauthorized.", safeToRetry: true }, 401);
    const user = await userResponse.json();
    if (typeof user?.id !== "string") return jsonResponse({ error: "Unauthorized.", safeToRetry: true }, 401);
    userId = user.id;

    const body = await req.json().catch(() => null);
    const plan = body?.plan;
    if (!Object.prototype.hasOwnProperty.call(PLAN_AMOUNTS, plan)) {
      return jsonResponse({ error: "Invalid plan.", safeToRetry: true }, 400);
    }
    const formattedPhone = normalizeKenyanMobile(body?.phone);
    if (!formattedPhone) {
      return jsonResponse({ error: "Enter a valid Kenyan mobile number (07xx, 01xx, or +254).", safeToRetry: true }, 400);
    }

    const channelId = Number(PAYHERO_CHANNEL_ID);
    let callbackUrl;
    try { callbackUrl = new URL(PAYHERO_CALLBACK_URL); } catch { callbackUrl = null; }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !PAYHERO_USERNAME || !PAYHERO_PASSWORD ||
      !Number.isSafeInteger(channelId) || channelId <= 0 || callbackUrl?.protocol !== "https:") {
      return jsonResponse({ error: "Payment service is temporarily unavailable. Please try again later.", safeToRetry: true }, 503);
    }

    // Legacy pending attempts remain authoritative. A user may have started a
    // payment before this lock table existed; never issue a second STK prompt.
    const existingPending = await findExistingPendingPayment(userId);
    if (existingPending) return existingAttemptResponse(existingPending);

    const amount = PLAN_AMOUNTS[plan];
    externalReference = `FP-${userId.slice(0, 8)}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const reservation = await reserveAttemptLock(userId, plan, amount, externalReference);
    reservationCreated = reservation.created;
    if (!reservation.created) {
      const racedPending = await findExistingPendingPayment(userId);
      if (racedPending) return existingAttemptResponse(racedPending);
      if (reservation.existing) return existingAttemptResponse(reservation.existing);
      return jsonResponse({
        error: "A payment attempt is already being processed or needs support. Do not pay again; contact paid-access support.",
        status: "pending"
      }, 409);
    }

    const authToken = btoa(`${PAYHERO_USERNAME}:${PAYHERO_PASSWORD}`);
    providerCallStarted = true;
    const stkResponse = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${authToken}` },
      body: JSON.stringify({
        amount,
        phone_number: formattedPhone,
        channel_id: channelId,
        external_reference: externalReference,
        callback_url: PAYHERO_CALLBACK_URL,
        provider: "m-pesa"
      })
    });

    const stkText = await stkResponse.text();
    let phData;
    try {
      phData = JSON.parse(stkText);
    } catch {
      console.error("PayHero returned a non-JSON STK response", stkResponse.status, externalReference);
      return jsonResponse({
        error: "Payment provider returned an invalid response. Do not pay again; contact support.",
        supportReference: externalReference
      }, 502);
    }

    if (!stkResponse.ok || phData?.success !== true || phData.error_code) {
      console.error("PayHero did not confirm STK initiation", stkResponse.status, phData?.error_code || "No explicit error code", externalReference);
      // Only an explicit provider rejection is safe to retry. Network errors,
      // malformed responses, and non-rejection responses keep the lock.
      const explicitRejection = phData?.success === false || Boolean(phData?.error_code);
      const safeToRetry = explicitRejection ? await releaseAttemptLock(userId, externalReference) : false;
      if (safeToRetry) {
        return jsonResponse({
          error: "Could not initiate M-Pesa payment. Please check your number and try again.",
          safeToRetry: true
        }, 400);
      }
      return jsonResponse({
        error: "Payment may have been initiated. Do not pay again; contact support.",
        supportReference: externalReference
      }, 502);
    }

    const checkoutRequestId = phData.CheckoutRequestID;
    if (typeof checkoutRequestId !== "string" || checkoutRequestId.length < 1 || checkoutRequestId.length > 200) {
      console.error("PayHero accepted STK without a usable checkout ID", externalReference);
      return jsonResponse({
        error: "The provider accepted the request but did not return a tracking ID. Contact support before paying again.",
        supportReference: externalReference
      }, 502);
    }

    let lockUpdated = false;
    try {
      await updateAttemptLock(userId, externalReference, checkoutRequestId);
      lockUpdated = true;
    } catch (error) {
      console.error("Could not persist checkout ID to payment lock", error?.message || error, externalReference);
    }

    const createdAt = new Date().toISOString();
    const pendingUrl = new URL(restUrl("pending_payments"));
    pendingUrl.searchParams.set("on_conflict", "checkout_request_id");
    const pendingResponse = await fetch(pendingUrl.toString(), {
      method: "POST",
      headers: {
        ...serviceHeaders(),
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal"
      },
      body: JSON.stringify({
        user_id: userId,
        plan,
        amount,
        external_reference: externalReference,
        payhero_reference: phData.reference || phData.transaction_reference || null,
        checkout_request_id: checkoutRequestId,
        status: "pending"
      })
    });
    if (!pendingResponse.ok) {
      await pendingResponse.text(); // Drain the body without logging potentially sensitive provider/database details.
      console.error("Could not persist pending payment", pendingResponse.status, externalReference);
      return jsonResponse({
        error: "Payment may have been initiated, but tracking could not be saved. Do not pay again; contact support.",
        status: "pending",
        checkoutRequestId,
        plan,
        createdAt,
        supportReference: externalReference
      }, 500);
    }

    const savedPending = await findPendingByCheckoutId(checkoutRequestId);
    if (!savedPending || savedPending.user_id !== userId || savedPending.external_reference !== externalReference ||
      savedPending.plan !== plan || Number(savedPending.amount) !== amount) {
      console.error("Saved payment did not match the initiating attempt", externalReference, checkoutRequestId);
      return jsonResponse({
        error: "Payment may have been initiated, but tracking could not be verified. Do not pay again; contact support.",
        status: "pending",
        checkoutRequestId,
        plan,
        createdAt,
        supportReference: externalReference
      }, 500);
    }

    if (!lockUpdated) {
      try { await updateAttemptLock(userId, externalReference, checkoutRequestId); }
      catch (error) { console.error("Payment is saved but its lock could not be updated", error?.message || error, externalReference); }
    }

    // Match the browser contract: index.html polls using data.checkoutRequestId.
    return jsonResponse({ success: true, checkoutRequestId, plan, createdAt });
  } catch (error) {
    console.error("STK push error", error?.message || error, externalReference || "no-reference");
    if (reservationCreated && !providerCallStarted && userId && externalReference) {
      const released = await releaseAttemptLock(userId, externalReference);
      return jsonResponse({
        error: "Payment service is temporarily unavailable. Please try again later.",
        safeToRetry: released
      }, 500);
    }
    return jsonResponse({
      error: providerCallStarted
        ? "Payment may have been initiated. Do not pay again; contact support."
        : "Payment service is temporarily unavailable. Please try again later.",
      ...(providerCallStarted && externalReference ? { supportReference: externalReference } : {}),
      ...(!providerCallStarted ? { safeToRetry: true } : {})
    }, 500);
  }
});
