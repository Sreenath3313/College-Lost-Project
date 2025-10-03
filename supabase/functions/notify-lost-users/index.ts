// deno-lint-ignore-file no-explicit-any
// Edge Function: notify-lost-users
// Sends email notifications to users who posted lost items in the same category

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Supabase credentials
const SUPABASE_URL = "https://lhnrkyfqiulvwvkdxipa.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxobnJreWZxaXVsdnd2a2R4aXBhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1OTQ4MjMwNywiZXhwIjoyMDc1MDU4MzA3fQ.BE23gtZOSIgIUsLbX_DJ-Fu9n3xGq_E-Be9MNt5cw-A";

// Optional: Replace with your Resend API key + email sender
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM =
  Deno.env.get("EMAIL_FROM") || "Campus Finder <onboarding@resend.dev>";

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { ...corsHeaders } });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const {
      category,
      foundItemId,
      foundByUserId,
      foundItemTitle,
    }: {
      category: string;
      foundItemId?: string;
      foundByUserId?: string;
      foundItemTitle?: string;
    } = await req.json();

    if (!category) {
      return new Response(JSON.stringify({ error: "Missing category" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Connect with service role key
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch active lost items matching the category
    const { data: lostItems, error: lostErr } = await supabase
      .from("items")
      .select("user_id, contact_info")
      .eq("type", "lost")
      .eq("category", category)
      .eq("status", "active");

    if (lostErr) {
      console.error("Error querying lost items:", lostErr);
      return new Response(JSON.stringify({ error: "Query failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (!lostItems || lostItems.length === 0) {
      return new Response(JSON.stringify({ message: "No matching lost items" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Determine the found poster's email (to avoid emailing themselves)
    let foundPosterEmail: string | null = null;
    if (foundByUserId) {
      const { data: foundUserData } = await supabase.auth.admin.getUserById(
        foundByUserId,
      );
      foundPosterEmail = foundUserData?.user?.email ?? null;
    }

    // Collect recipient emails
    const recipientEmails = new Set<string>();
    for (const item of lostItems as Array<
      { user_id: string; contact_info: string | null }
    >) {
      if (item.contact_info && item.contact_info.includes("@")) {
        if (
          !foundPosterEmail ||
          item.contact_info.toLowerCase() !== foundPosterEmail.toLowerCase()
        ) {
          recipientEmails.add(item.contact_info.trim());
        }
      }
    }

    // Also include the account email for each unique user_id
    const uniqueUserIds = Array.from(new Set(lostItems.map((i: any) => i.user_id)));
    const adminLookups = await Promise.all(
      uniqueUserIds.map((uid) => supabase.auth.admin.getUserById(uid)),
    );

    for (const result of adminLookups) {
      const email = result.data?.user?.email;
      if (
        email &&
        (!foundPosterEmail || email.toLowerCase() !== foundPosterEmail.toLowerCase())
      ) {
        recipientEmails.add(email.trim());
      }
    }

    if (recipientEmails.size === 0) {
      return new Response(JSON.stringify({ message: "No recipients" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const to = Array.from(recipientEmails);

    const subject = `A found item was posted in ${category}`;
    const siteUrl = Deno.env.get("SITE_URL") || "https://";
    const html = `
      <div>
        <p>Hello,</p>
        <p>Someone just reported a <strong>found</strong> item in the category <strong>${category}</strong>.</p>
        ${foundItemTitle ? `<p>Item: <strong>${foundItemTitle}</strong></p>` : ""}
        <p>Visit Campus Finder to view details and reach out:</p>
        <p><a href="${siteUrl}" target="_blank" rel="noopener noreferrer">Open Campus Finder</a></p>
        ${foundItemId ? `<p>Reference ID: ${foundItemId}</p>` : ""}
      </div>
    `;

    // Send via Resend API if configured
    if (RESEND_API_KEY) {
      const resendResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
      });

      if (!resendResp.ok) {
        const text = await resendResp.text();
        console.error("Resend API error:", resendResp.status, text);
        return new Response(JSON.stringify({ error: "Email send failed", details: text }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const resendJson = await resendResp.json();

      return new Response(
        JSON.stringify({
          message: "Notifications sent",
          recipients: to.length,
          resend: resendJson,
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // Fallback if no RESEND_API_KEY set
    return new Response(
      JSON.stringify({
        message: "Notifications prepared (email not sent, no RESEND_API_KEY)",
        recipients: to.length,
        recipientsList: to,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("notify-lost-users error:", err);
    return new Response(JSON.stringify({ error: "Unexpected error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
