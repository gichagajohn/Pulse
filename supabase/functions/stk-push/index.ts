// Dependency-free M-Pesa STK initiation via PayHero and Supabase REST/Auth.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PAYHERO_USERNAME = Deno.env.get("PAYHERO_API_USERNAME");
const PAYHERO_PASSWORD = Deno.env.get("PAYHERO_API_PASSWORD");
const PAYHERO_CHANNEL_ID = Deno.env.get("PAYHERO_CHANNEL_ID");
const PAYHERO_CALLBACK_URL = Deno.env.get("PAYHERO_CALLBACK_URL");

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization." }, 401);

    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: SUPABASE_SERVICE_ROLE_KEY }
    });
    if (!userResponse.ok) return jsonResponse({ error: "Unauthorized." }, 401);
    const user = await userResponse.json();

    const { plan, phone } = await req.json();
    if (!['daily', 'weekly'].includes(plan)) return jsonResponse({ error: "Invalid plan." }, 400);
    if (!phone) return jsonResponse({ error: "Phone number required." }, 400);

    let formattedPhone = phone.replace(/\D/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
    else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;
    if (formattedPhone.length !== 12) return jsonResponse({ error: "Invalid phone number." }, 400);

    const amount = plan === 'daily' ? 100 : 500;
    const externalReference = `FP-${user.id.slice(0, 8)}-${Date.now()}`;
    const authToken = btoa(`${PAYHERO_USERNAME}:${PAYHERO_PASSWORD}`);

    const stkResponse = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${authToken}` },
      body: JSON.stringify({
        amount,
        phone_number: formattedPhone,
        channel_id: parseInt(PAYHERO_CHANNEL_ID),
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
      console.error("PayHero non-JSON response", stkResponse.status, stkText.slice(0, 500));
      return jsonResponse({ error: "Payment provider returned an invalid response. Please try again." }, 502);
    }
    if (!stkResponse.ok || !phData.success || phData.error_code) {
      console.error("PayHero rejected STK", stkResponse.status, phData.error_code || phData.error_message || "Unknown error");
      return jsonResponse({ error: "Could not initiate M-Pesa payment. Please check your number and try again." }, 400);
    }
    if (!phData.CheckoutRequestID) return jsonResponse({ error: "Payment provider did not return a checkout ID." }, 502);

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
        payhero_reference: phData.reference || phData.transaction_reference || null,
        checkout_request_id: phData.CheckoutRequestID,
        status: "pending"
      })
    });
    if (!pendingResponse.ok) {
      const details = await pendingResponse.text();
      console.error("Could not persist pending payment", pendingResponse.status, details.slice(0, 500));
      return jsonResponse({ error: "Payment was initiated but tracking could not be saved. Contact support before paying again." }, 500);
    }

    // Match the browser contract: index.html polls using data.checkoutRequestId.
    return jsonResponse({ success: true, checkoutRequestId: phData.CheckoutRequestID });
  } catch (error) {
    console.error("STK push error", error?.message || error);
    return jsonResponse({ error: error.message }, 500);
  }
});
