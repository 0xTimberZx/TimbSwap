// TimbSwap faucet — claim gatekeeper edge function (Supabase, Deno).
//
// The faucet page posts { address, cfTurnstileToken } to the same-origin Worker
// route POST /api/faucet-claim (workers/timbswap-api.js), which relays here with
// an optional shared secret (X-Proxy-Secret). This function NEVER sends anything
// on-chain — it validates, reserves a claim slot, and returns 202. The keeper
// (scripts/faucet-worker.js) is the only thing that touches a hot wallet and
// calls GasFaucet.dispense().
//
// Flow:
//   1. verify the Cloudflare Turnstile token (anti-bot friction)
//   2. validate the address; read the TESTNET chain for a live Active ticket
//      (GameRegistry.activeTicketOf → effectiveStatus == Active) — never a mirror
//   3. read TimbYieldVault.weightOf(ticketId) (soft observability, never blocks)
//   4. reserve_faucet_claim(address, ticketId, weight) — advisory-locked 24h
//      cooldown + enqueue a `reserved` row (service_role, bypasses RLS)
//   5. if AIRDROP_ENABLED, enqueue_airdrop(address, round) for the mainnet-TIMB
//      leg — best-effort; a failure here never fails the faucet claim
//   6. 202 { queued } — the keeper dispenses within seconds
//
// Secrets (Supabase → Project Settings → Edge Functions):
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (auto-injected) — bypasses RLS
//   FAUCET_RPC_URL             Arbitrum Sepolia RPC (read-only eligibility calls)
//   GAME_REGISTRY_ADDR         GameRegistry on Sepolia (eligibility oracle)
//   TIMB_YIELD_VAULT_ADDR      TimbYieldVault on Sepolia (weightOf soft-check)
//   TURNSTILE_SECRET           Cloudflare Turnstile secret key
//   FAUCET_PROXY_SECRET        optional; if set, only requests carrying the
//                              matching X-Proxy-Secret header are accepted
//   AIRDROP_ENABLED            "true" to enqueue the mainnet-TIMB leg (Phase 2)
//   AIRDROP_ROUND              airdrop round id (default "1")
//
// Deploy: supabase functions deploy faucet-claim --no-verify-jwt
// (public like waitlist; Turnstile + the Worker + the SQL cooldown are the guard.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.4";

const SB_URL        = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RPC_URL       = Deno.env.get("FAUCET_RPC_URL") ?? "";
const REGISTRY_ADDR = Deno.env.get("GAME_REGISTRY_ADDR") ?? "";
const YIELD_ADDR    = Deno.env.get("TIMB_YIELD_VAULT_ADDR") ?? "";
const TS_SECRET     = Deno.env.get("TURNSTILE_SECRET") ?? "";
const PROXY_SECRET  = Deno.env.get("FAUCET_PROXY_SECRET") ?? "";
const AIRDROP_ON    = (Deno.env.get("AIRDROP_ENABLED") ?? "").toLowerCase() === "true";
const AIRDROP_ROUND = Number(Deno.env.get("AIRDROP_ROUND") ?? "1");

const ALLOWED_ORIGINS = new Set([
  "https://timbswap.xyz",
  "https://www.timbswap.xyz",
  "https://0xtimberzx.github.io",
]);

// Mirror of GameRegistry.TicketStatus — Active is index 1.
const TICKET_ACTIVE = 1n;

const REGISTRY_ABI = [
  "function activeTicketOf(address wallet) external view returns (uint256)",
  "function effectiveStatus(uint256 ticketId) external view returns (uint8)",
];
const YIELD_ABI = [
  "function weightOf(uint256 ticketId) external view returns (uint256)",
];

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

function cors(origin: string) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://timbswap.xyz";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "content-type, x-proxy-secret, x-real-ip",
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

// Cloudflare Turnstile server-side verification.
async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  if (!TS_SECRET) return true; // not configured → skip (dev); set it in prod
  try {
    const form = new URLSearchParams();
    form.set("secret", TS_SECRET);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const out = await r.json();
    return out?.success === true;
  } catch (_e) {
    return false; // verification unreachable → fail closed
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST")    return json({ ok: false, error: "POST only" }, 405, origin);

  // If a proxy secret is configured, only the Worker (which carries it) is trusted.
  if (PROXY_SECRET && req.headers.get("X-Proxy-Secret") !== PROXY_SECRET) {
    return json({ ok: false, error: "forbidden" }, 401, origin);
  }
  if (!RPC_URL || !REGISTRY_ADDR) {
    return json({ ok: false, error: "Faucet is not configured yet." }, 503, origin);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad request" }, 400, origin); }

  // ── Address ──
  const raw = String(body?.address ?? "").trim();
  if (!WALLET_RE.test(raw)) {
    return json({ ok: false, error: "Enter a valid wallet address." }, 422, origin);
  }
  let address: string;
  try { address = ethers.getAddress(raw); } catch { return json({ ok: false, error: "Enter a valid wallet address." }, 422, origin); }

  // ── Turnstile ──
  const ip = req.headers.get("X-Real-IP") || req.headers.get("CF-Connecting-IP") || "";
  const token = String(body?.cfTurnstileToken ?? body?.turnstileToken ?? "");
  if (!(await verifyTurnstile(token, ip))) {
    return json({ ok: false, error: "Human check failed — please retry the challenge." }, 403, origin);
  }

  // ── Eligibility: a live Active ticket on the target (testnet) chain ──
  let ticketId: bigint;
  let weight = 0n;
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const registry = new ethers.Contract(REGISTRY_ADDR, REGISTRY_ABI, provider);
    ticketId = await registry.activeTicketOf(address);
    if (ticketId === 0n) {
      return json({ ok: false, error: "No active ticket for this address. Enter a round first." }, 403, origin);
    }
    const status: bigint = BigInt(await registry.effectiveStatus(ticketId));
    if (status !== TICKET_ACTIVE) {
      return json({ ok: false, error: "Your ticket isn't Active right now." }, 403, origin);
    }
    // Soft observability weight — never blocks a claim.
    if (YIELD_ADDR) {
      try {
        const vault = new ethers.Contract(YIELD_ADDR, YIELD_ABI, provider);
        weight = await vault.weightOf(ticketId);
      } catch (_e) { weight = 0n; }
    }
  } catch (_e) {
    return json({ ok: false, error: "Couldn't read the chain just now — try again shortly." }, 502, origin);
  }

  // ── Reserve the 24h slot (advisory-locked, service_role) ──
  const sb = createClient(SB_URL, SB_SERVICE);
  const { data: claimId, error: rpcErr } = await sb.rpc("reserve_faucet_claim", {
    p_address: address.toLowerCase(),
    p_ticket_id: ticketId.toString(),
    p_reserve_weight: weight.toString(),
  });
  if (rpcErr) {
    return json({ ok: false, error: "Couldn't reserve a claim right now — try again." }, 500, origin);
  }
  if (claimId === null || claimId === undefined) {
    return json({ ok: false, error: "Already claimed. Come back in about 24h." }, 429, origin);
  }

  // ── Mainnet-TIMB leg (Phase 2): enqueue, best-effort ──
  if (AIRDROP_ON) {
    try {
      await sb.rpc("enqueue_airdrop", { p_address: address.toLowerCase(), p_round: AIRDROP_ROUND });
    } catch (_e) { /* airdrop is a bonus leg — never fail the faucet claim */ }
  }

  return json({ ok: true, status: "queued", claimId }, 202, origin);
});
