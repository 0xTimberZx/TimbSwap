// TimbSwap RPC proxy — forwards JSON-RPC to Alchemy from a Brave-allowed origin.
//
// Brave Shields blocks g.alchemy.com directly, so every on-chain READ dashed in
// Brave even with the RPC healthy. But Brave ALLOWS functions.supabase.co (the
// same reason the faucet-claim function works in Brave while REST telemetry is
// blocked). The app points its read provider here; this function relays the
// JSON-RPC body to a SINGLE Alchemy backend, so reads stay consistent — no
// divergent-head fake reverts (see config.js §#360) — and survive Shields.
//
// verify_jwt is OFF: ethers POSTs plain JSON-RPC with no auth header.
// Env: ALCHEMY_RPC_URL overrides the upstream (defaults to the public keyed URL
// already shipped in config.js — a frontend RPC is public regardless).
// Deploy: supabase functions deploy rpc --no-verify-jwt

const DEFAULT_UPSTREAM = "https://arb-mainnet.g.alchemy.com/v2/REPLACE_WITH_MAINNET_ALCHEMY_KEY";
const UPSTREAM = Deno.env.get("ALCHEMY_RPC_URL") || DEFAULT_UPSTREAM;

// Shared comma-separated allowlist (per-website, never per-wallet). Default "*"
// so reads work out of the box; pin FAUCET_ALLOWED_ORIGIN to lock it down.
const ALLOWED_ORIGINS = (Deno.env.get("FAUCET_ALLOWED_ORIGIN") || "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

function corsFor(req: Request): Record<string, string> {
  let allow = "*";
  if (!(ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === "*")) {
    const reqOrigin = req.headers.get("origin") || "";
    allow = ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405, headers: { ...cors, "content-type": "application/json" },
    });
  }

  // Relay the raw JSON-RPC body verbatim (supports single AND batch requests).
  let body: string;
  try { body = await req.text(); } catch {
    return new Response(JSON.stringify({ error: "bad body" }), {
      status: 400, headers: { ...cors, "content-type": "application/json" },
    });
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, "content-type": "application/json" },
    });
  } catch (_) {
    return new Response(JSON.stringify({ error: "upstream unreachable" }), {
      status: 502, headers: { ...cors, "content-type": "application/json" },
    });
  }
});
