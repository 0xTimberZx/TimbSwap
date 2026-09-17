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
//   RESEND_API_KEY              optional; if set, a confirmation email is sent per NEW signup
//   WAITLIST_FROM               optional; sender, default "TimbSwap <hello@timbswap.xyz>"
//                               (the domain must be verified in Resend with SPF/DKIM)
//   WAITLIST_UNSUB_MAILTO       optional; unsubscribe inbox, default "hello@timbswap.xyz"
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
// Secrets pasted from a phone often arrive wrapped in smart quotes or with stray
// whitespace; a non-ASCII byte in the Authorization header makes fetch() throw
// before Resend is ever reached. Trim the usual junk and refuse the rest loudly.
function cleanSecret(name: string): string {
  const raw = (Deno.env.get(name) ?? "").trim().replace(/^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g, "").trim();
  if (raw && !/^[\x21-\x7e]+$/.test(raw)) {
    console.error(`${name} contains non-ASCII or whitespace characters — re-set it with a clean paste`);
    return "";
  }
  return raw;
}
const RESEND_KEY   = cleanSecret("RESEND_API_KEY");
const MAIL_FROM    = Deno.env.get("WAITLIST_FROM") ?? "TimbSwap <hello@timbswap.xyz>";
const UNSUB_MAILTO = Deno.env.get("WAITLIST_UNSUB_MAILTO") ?? "hello@timbswap.xyz";

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

// ── Confirmation email ───────────────────────────────────────────────────────
// Transactional (single send on a NEW signup). Honest, testnet-framed: no payment,
// token-price, or guaranteed-airdrop-value language. Mirrors dev-docs/WAITLIST_EMAIL.md.
const MAIL_SUBJECT = "You're on the TimbSwap mainnet list ✓";

function confirmText(unsub: string): string {
  return `You're on the list ✓

Thanks for signing up for the TimbSwap mainnet launch. You'll be among the first
to know when we go live — and mainnet opens only after our independent audit
clears. We won't launch real funds before that.

While you wait, the game is already live and free on Arbitrum Sepolia testnet:

  1. Grab free test tokens   https://timbswap.xyz/faucet
  2. Play a round            https://timbswap.xyz/compete
  3. Climb the leaderboard   https://timbswap.xyz/quests

Why bother on testnet? Your volume and streaks build Timber Points, and the
wallets active on testnet are who we prioritize for the mainnet transition and
the airdrop allowlist. Playing now counts.

How the game works: trade like you would anywhere. Every eligible trade also
enters the round — call six characters, and if the live meter lands on them, you
split the pot. The prize is funded by yield, not your deposit. What you put in
stays yours.

Every round settles on-chain — winning strings, entries, and payouts are all
public: https://timbswap.xyz/analytics

Stay safe: we will never DM you first and never ask for your seed phrase or
private keys. The only official sources are timbswap.xyz, our Telegram, and our
X account. Anyone else is an impersonator.

— The TimbSwap team

Open-source · Non-custodial · Permissionless
Litepaper: https://timbswap.xyz/litepaper
Bug bounty: https://timbswap.xyz/gov/#bounty

You're receiving this because you joined the mainnet waitlist at timbswap.xyz.
Unsubscribe: ${unsub}`;
}

function confirmHtml(unsub: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta name="color-scheme" content="dark light"/>
<title>You're on the TimbSwap mainnet list</title></head>
<body style="margin:0;padding:0;background:#0b0f0d;color:#e8f0ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">You're confirmed for the mainnet call. Testnet is live now — grab tokens and take a round.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f0d;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#111714;border:1px solid #1e2a24;border-radius:14px;overflow:hidden;">
<tr><td style="padding:28px 32px 8px;"><span style="font-size:20px;font-weight:700;color:#e8f0ec;">&#x2B21; TimbSwap</span></td></tr>
<tr><td style="padding:8px 32px 4px;"><div style="font-size:12px;letter-spacing:.12em;color:#14f195;font-weight:700;">YOU'RE ON THE LIST &#10003;</div>
<h1 style="margin:10px 0 0;font-size:26px;line-height:1.25;color:#ffffff;font-weight:700;">Match the meter,<br/><span style="color:#14f195;">win the pot.</span></h1></td></tr>
<tr><td style="padding:16px 32px 4px;font-size:15px;line-height:1.6;color:#c3d1c9;">
<p style="margin:0 0 14px;">Thanks for joining the TimbSwap mainnet waitlist. You'll be among the first to know when we go live &mdash; and mainnet opens only <strong style="color:#e8f0ec;">after our independent audit clears</strong>. We won't launch real funds before that.</p>
<p style="margin:0 0 8px;">While you wait, the game is already live and free on Arbitrum Sepolia testnet:</p></td></tr>
<tr><td style="padding:6px 32px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="padding:10px 0;border-bottom:1px solid #1a241f;font-size:15px;color:#e8f0ec;"><span style="color:#14f195;font-weight:700;">1.</span>&nbsp; Grab free test tokens &nbsp;<a href="https://timbswap.xyz/faucet" style="color:#14f195;text-decoration:none;">timbswap.xyz/faucet &#8599;</a></td></tr>
<tr><td style="padding:10px 0;border-bottom:1px solid #1a241f;font-size:15px;color:#e8f0ec;"><span style="color:#14f195;font-weight:700;">2.</span>&nbsp; Play a round &nbsp;<a href="https://timbswap.xyz/compete" style="color:#14f195;text-decoration:none;">timbswap.xyz/compete &#8599;</a></td></tr>
<tr><td style="padding:10px 0;font-size:15px;color:#e8f0ec;"><span style="color:#14f195;font-weight:700;">3.</span>&nbsp; Climb the leaderboard &nbsp;<a href="https://timbswap.xyz/quests" style="color:#14f195;text-decoration:none;">timbswap.xyz/quests &#8599;</a></td></tr></table></td></tr>
<tr><td align="center" style="padding:20px 32px 8px;"><a href="https://timbswap.xyz/compete" style="display:inline-block;background:#14f195;color:#062015;font-weight:700;font-size:15px;text-decoration:none;padding:13px 28px;border-radius:10px;">Take a round &rarr;</a></td></tr>
<tr><td style="padding:14px 32px 4px;font-size:14px;line-height:1.6;color:#9fb2a8;">
<p style="margin:0 0 12px;"><strong style="color:#c3d1c9;">Why bother on testnet?</strong> Your volume and streaks build Timber Points, and testnet-active wallets are who we prioritize for the mainnet transition and the airdrop allowlist. Playing now counts.</p>
<p style="margin:0 0 12px;"><strong style="color:#c3d1c9;">How it works:</strong> trade like you would anywhere. Every eligible trade also enters the round &mdash; call six characters, and if the live meter lands on them, you split the pot. The prize is funded by yield, not your deposit. What you put in stays yours.</p>
<p style="margin:0;">Every round settles on-chain &mdash; winning strings, entries, and payouts are all public. <a href="https://timbswap.xyz/analytics" style="color:#14f195;text-decoration:none;">See the round history &#8599;</a></p></td></tr>
<tr><td style="padding:16px 32px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e1512;border:1px solid #24322b;border-radius:10px;"><tr><td style="padding:14px 16px;font-size:13px;line-height:1.55;color:#9fb2a8;"><strong style="color:#e8f0ec;">Stay safe:</strong> we will <strong style="color:#e8f0ec;">never</strong> DM you first and never ask for your seed phrase or private keys. The only official sources are timbswap.xyz, our Telegram, and our X account. Anyone else is an impersonator &mdash; report and block them.</td></tr></table></td></tr>
<tr><td style="padding:22px 32px 28px;border-top:1px solid #1a241f;">
<p style="margin:0 0 8px;font-size:13px;color:#7d8f86;">Open-source &middot; Non-custodial &middot; Permissionless</p>
<p style="margin:0 0 14px;font-size:13px;color:#7d8f86;"><a href="https://timbswap.xyz/litepaper" style="color:#9fb2a8;text-decoration:none;">Litepaper</a> &nbsp;&middot;&nbsp; <a href="https://timbswap.xyz/gov/#bounty" style="color:#9fb2a8;text-decoration:none;">Bug bounty</a></p>
<p style="margin:0;font-size:12px;color:#5f6f67;line-height:1.5;">You're receiving this because you joined the mainnet waitlist at timbswap.xyz.<br/><a href="${unsub}" style="color:#7d8f86;text-decoration:underline;">Unsubscribe</a></p></td></tr>
</table></td></tr></table></body></html>`;
}

async function sendConfirmation(to: string) {
  if (!RESEND_KEY) { console.log("resend skipped: no usable RESEND_API_KEY"); return; }
  const unsub = `mailto:${UNSUB_MAILTO}?subject=${encodeURIComponent("Unsubscribe " + to)}`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [to],
        subject: MAIL_SUBJECT,
        html: confirmHtml(unsub),
        text: confirmText(unsub),
        headers: { "List-Unsubscribe": `<${unsub}>` },
      }),
    });
    const body = await r.text().catch(() => "");
    console.log(`resend ${r.status} ${to.replace(/^(.{2}).*(@.*)$/, "$1…$2")} ${body.slice(0, 300)}`);
  } catch (e) { console.error("resend fetch failed", String(e)); /* a failed email must not fail the signup */ }
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
    await sendConfirmation(email);
  }

  return json({ ok: true, status }, 200, origin);
});
