// Dependency-free M-Pesa STK initiation via PayHero and Supabase REST/Auth.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PAYHERO_USERNAME = Deno.env.get("PAYHERO_API_USERNAME");
const PAYHERO_PASSWORD = Deno.env.get("PAYHERO_API_PASSWORD");
const PAYHERO_CHANNEL_ID = Deno.env.get("PAYHERO_CHANNEL_ID");
const PAYHERO_CALLBACK_URL = Deno.env.get("PAYHERO_CALLBACK_URL");

const PLAN_AMOUNTS = { daily: 100, weekly: 500 };
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return "254" + digits.slice(1);
  if (digits.startsWith("7") || digits.startsWith("1")) return "254" + digits;
  return digits;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Not signed in." }, 401);

    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader }
    });
    if (!userResponse.ok) return jsonResponse({ error: "Not signed in." }, 401);
    const user = await userResponse.json();
    if (!user?.id) return jsonResponse({ error: "Not signed in." }, 401);

    const { phone, plan } = await req.json();
    const amount = PLAN_AMOUNTS[plan];
    if (!phone || !amount) return jsonResponse({ error: "Invalid phone or plan." }, 400);

    const externalReference = `FP-${user.id.slice(0, 8)}-${Date.now()}`;
    const authToken = btoa(`${PAYHERO_USERNAME}:${PAYHERO_PASSWORD}`);
    const phRes = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${authToken}`
      },
      body: JSON.stringify({
        amount,
        phone_number: normalizePhone(phone),
        channel_id: Number(PAYHERO_CHANNEL_ID),
        provider: "m-pesa",
        external_reference: externalReference,
        callback_url: PAYHERO_CALLBACK_URL
      })
    });

    const phData = await phRes.json();
    if (!phRes.ok || !phData?.success) {
      return jsonResponse({
        error: phData?.error_message || "Could not start payment."
      }, 502);
    }

    const pendingResponse = await fetch(`${SUPABASE_URL}/rest/v1/pending_payments`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        user_id: user.id,
        plan,
        amount,
        external_reference: externalReference,
        checkout_request_id: phData.CheckoutRequestID,
        status: "pending"
      })
    });

    if (!pendingResponse.ok) {
      console.error("Pending payment insert failed", pendingResponse.status, externalReference);
      return jsonResponse({
        error: "PayHero accepted the request, but the payment could not be recorded. Contact support before retrying.",
        reference: externalReference
      }, 500);
    }

    return jsonResponse({ checkoutRequestId: phData.CheckoutRequestID });
  } catch (err) {
    console.error("STK push error", err);
    return jsonResponse({ error: "Payment service is temporarily unavailable." }, 500);
  }
});
