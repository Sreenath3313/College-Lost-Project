// deno-lint-ignore-file no-explicit-any
// Edge Function: notify-lost-users
// Sends email notifications to users who posted lost items in the same category

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "Campus Finder <onboarding@resend.dev>";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: "Missing Supabase service credentials" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: "Missing RESEND_API_KEY" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch active lost items that may match the category
    // Then enforce case-sensitive matching in-function
    const { data: lostItems, error: lostErr } = await supabase
      .from("items")
      .select("user_id, contact_info, category, type")
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

    // Enforce case-sensitive matching for both type and category to be safe
    const strictMatches = (lostItems || []).filter(
      (it: any) => it?.type === "lost" && it?.category === category
    );

    if (!strictMatches || strictMatches.length === 0) {
      return new Response(JSON.stringify({ message: "No matching lost items" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Determine the found poster's email (to avoid emailing themselves)
    let foundPosterEmail: string | null = null;
    if (foundByUserId) {
      const { data: foundUserData } = await supabase.auth.admin.getUserById(foundByUserId);
      foundPosterEmail = foundUserData?.user?.email ?? null;
    }

    // Collect recipient emails
    const recipientEmails = new Set<string>();

    // Use contact_info if it looks like an email
    for (const item of strictMatches as Array<{ user_id: string; contact_info: string | null }>) {
      if (item.contact_info && item.contact_info.includes("@")) {
        if (!foundPosterEmail || item.contact_info.toLowerCase() !== foundPosterEmail.toLowerCase()) {
          recipientEmails.add(item.contact_info.trim());
        }
      }
    }

    // Also include the account email for each unique user_id
    const uniqueUserIds = Array.from(new Set(strictMatches.map((i: any) => i.user_id)));
    const adminLookups = await Promise.all(
      uniqueUserIds.map((uid) => supabase.auth.admin.getUserById(uid))
    );

    for (const result of adminLookups) {
      const email = result.data?.user?.email;
      if (email && (!foundPosterEmail || email.toLowerCase() !== foundPosterEmail.toLowerCase())) {
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
      JSON.stringify({ message: "Notifications sent", recipients: to.length, resend: resendJson }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (err) {
    console.error("notify-lost-users error:", err);
    return new Response(JSON.stringify({ error: "Unexpected error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
