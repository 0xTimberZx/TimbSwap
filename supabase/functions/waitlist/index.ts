// TimbSwap mainnet waitlist — capture-layer edge function (Supabase, Deno).
//
// The landing page posts { email, wallet?, telegram?, source?, ref?, landing?, utm{} }
// to the same-origin Worker route POST /api/waitlist (workers/timbswap-api.js),
// which relays here, adding the caller's real IP (X-Real-IP) and country
// (X-Client-Country) and an optional shared secret (X-Proxy-Secret).
//
// Storage, dedupe, and per-IP rate limiting all live in the add_to_waitlist()
// SQL function (migrations/20260912000000_waitlist.sql), which runs under the
// service role and bypasses RLS. RLS is ON with no anon policy, so a signup row
// is never readable with the publishable key.
//
// Secrets (Supabase → Project Settings → Edge Functions):
//   SUPABASE_URL                (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY   (auto-injected) — bypasses RLS
//   WAITLIST_IP_SALT            random string; salts the stored IP hash (never store the raw IP)
//   WAITLIST_PROXY_SECRET       optional; if set, only requests carrying the matching
//                               X-Proxy-Secret header are accepted (keeps the public
//                               function from being spammed directly)
//   TELEGRAM_BOT_TOKEN          optional; same bot as the settler / faucet
//   WAITLIST_TG_CHAT_ID         optional; a private founder chat that gets a ping per new signup
//
// Deploy: supabase functions deploy waitlist --no-verify-jwt
// (public like telegram-webhook; the Worker + the SQL rate-limit are the guard.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL       = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IP_SALT      = Deno.env.get("WAITLIST_IP_SALT") ?? "timbswap-waitlist";
const PROXY_SECRET = Deno.env.get("WAITLIST_PROXY_SECRET") ?? "";
const TG_TOKEN     = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TG_CHAT      = Deno.env.get("WAITLIST_TG_CHAT_ID") ?? "";

const ALLOWED_ORIGINS = new Set([
  "https://timbswap.xyz",
  "https://www.timbswap.xyz",
  "https://0xtimberzx.github.io",
]);

function cors(origin: string) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://timbswap.xyz";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "content-type, x-proxy-secret, x-real-ip, x-client-country",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function notifyFounder(text: string) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch (_e) { /* a failed ping must not fail the signup */ }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST")    return json({ ok: false, error: "POST only" }, 405, origin);

  // If a proxy secret is configured, only the Worker (which carries it) is trusted.
  if (PROXY_SECRET && req.headers.get("X-Proxy-Secret") !== PROXY_SECRET) {
    return json({ ok: false, error: "forbidden" }, 401, origin);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad request" }, 400, origin); }

  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: "Please enter a valid email address." }, 422, origin);
  }

  // Wallet + telegram are optional; an invalid wallet is dropped, not rejected.
  let wallet: string | null = null;
  const wraw = String(body?.wallet ?? "").trim();
  if (wraw && WALLET_RE.test(wraw)) wallet = wraw.toLowerCase();

  let telegram: string | null = null;
  const traw = String(body?.telegram ?? "").trim().replace(/^@+/, "");
  if (traw) telegram = traw.slice(0, 40);

  const source  = String(body?.source ?? "landing").slice(0, 40);
  const ref     = String(body?.ref ?? "").slice(0, 300);
  const landing = String(body?.landing ?? "").slice(0, 200);
  const utm     = body?.utm ?? {};
  const utmSource   = String(utm?.source   ?? "").slice(0, 80);
  const utmMedium   = String(utm?.medium   ?? "").slice(0, 80);
  const utmCampaign = String(utm?.campaign ?? "").slice(0, 120);

  const country = String(req.headers.get("X-Client-Country") ?? "").slice(0, 8);
  const rawIp   = req.headers.get("X-Real-IP") || req.headers.get("CF-Connecting-IP") || "";
  const ipHash  = rawIp ? await sha256Hex(IP_SALT + "|" + rawIp) : "";

  const sb = createClient(SB_URL, SB_SERVICE);
  const { data, error } = await sb.rpc("add_to_waitlist", {
    p_email: email,
    p_wallet: wallet,
    p_telegram: telegram,
    p_source: source,
    p_ref: ref,
    p_landing: landing,
    p_utm_source: utmSource,
    p_utm_medium: utmMedium,
    p_utm_campaign: utmCampaign,
    p_country: country,
    p_ip_hash: ipHash,
  });

  if (error) {
    return json({ ok: false, error: "Couldn't save that just now — please try again." }, 500, origin);
  }

  const status = String(data ?? "new");
  if (status === "rate_limited") {
    return json({ ok: false, error: "Too many signups from your network — try again shortly." }, 429, origin);
  }

  if (status === "new") {
    const extras = [wallet ? "wallet ✓" : null, telegram ? "tg ✓" : null].filter(Boolean).join(" · ");
    const src = utmSource ? ` [${utmSource}]` : "";
    await notifyFounder(`🌱 New mainnet signup${src}${country ? " · " + country : ""}\n${email}${extras ? "\n" + extras : ""}`);
  }

  return json({ ok: true, status }, 200, origin);
});
