// Initiates an M-Pesa STK push via PayHero.
// Prices are defined server-side; the browser supplies only phone and plan.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAYHERO_USERNAME = Deno.env.get("PAYHERO_API_USERNAME");
const PAYHERO_PASSWORD = Deno.env.get("PAYHERO_API_PASSWORD");
const PAYHERO_CHANNEL_ID = Deno.env.get("PAYHERO_CHANNEL_ID");
const PAYHERO_CALLBACK_URL = Deno.env.get("PAYHERO_CALLBACK_URL");

const PLAN_AMOUNTS = {
  daily: 100,
  weekly: 500
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

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
    const sb = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: userData, error: userError } = await sb.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Not signed in." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { phone, plan } = await req.json();
    const amount = PLAN_AMOUNTS[plan];
    if (!phone || !amount) {
      return new Response(JSON.stringify({ error: "Invalid phone or plan." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const externalReference = `FP-${userData.user.id.slice(0, 8)}-${Date.now()}`;
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
      return new Response(JSON.stringify({
        error: phData?.error_message || "Could not start payment."
      }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    await sb.from("pending_payments").insert({
      user_id: userData.user.id,
      plan,
      amount,
      external_reference: externalReference,
      checkout_request_id: phData.CheckoutRequestID,
      status: "pending"
    });

    return new Response(JSON.stringify({
      checkoutRequestId: phData.CheckoutRequestID
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
