// TimbSwap first-party API Worker — Cloudflare Worker on route `timbswap.xyz/api/*`.
//
// Why this exists: the app's on-chain reads were third-party to timbswap.xyz
// (Alchemy). Brave Shields / adblockers throttle or block third-party requests,
// which made reads dash intermittently in Brave. Served from the SITE'S OWN ORIGIN
// under /api/*, they are first-party — Brave never touches them. Same-origin also
// means the browser skips CORS entirely.
//
// Routes (POST):
//   /api/rpc              → Alchemy JSON-RPC (single + batch). Env: ALCHEMY_RPC_URL
//   /api/waitlist         → Supabase `waitlist` edge fn. Var: WAITLIST_UPSTREAM;
//                           optional secret: WAITLIST_PROXY_SECRET. Adds the
//                           caller's real IP + country as X-Real-IP / X-Client-Country.
//   /api/quests           → Supabase `quests` edge fn (read-only leaderboard).
//                           Var: QUESTS_UPSTREAM.
// Anything else falls through to the origin (GitHub Pages).
//
// The /api/debughub_events telemetry sink was REMOVED for the capped beta: the
// client SDK is localStorage-only (config.js), so nothing calls it, and leaving an
// unauthenticated service-role write sink reachable was pointless surface. Its
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secrets are now unused — delete them in
// the Cloudflare dashboard. See config.js and SECURITY.md before re-adding a sink.
//
// Secrets / vars (wrangler secret put / [vars] in wrangler.toml):
//   ALCHEMY_RPC_URL             keyed Alchemy Arbitrum-One URL (public anyway)
//   WAITLIST_UPSTREAM           (var) Supabase waitlist function URL
//   WAITLIST_PROXY_SECRET       (secret, optional) shared with the waitlist fn
//   QUESTS_UPSTREAM             (var) Supabase quests function URL
//
// Route + deploy: see workers/README.md.

const ALLOWED_ORIGINS = new Set([
  "https://timbswap.xyz",
  "https://www.timbswap.xyz",
  "https://0xtimberzx.github.io",
]);
const MAX_BODY_BYTES = 128 * 1024; // RPC batches + signup rows are small; generous cap

function cors(origin) {
  // Same-origin calls send no Origin and need no CORS; echo an allowed Origin for
  // any cross-origin caller (e.g. the GitHub Pages mirror) and default otherwise.
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://timbswap.xyz";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

async function readBody(request, origin) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return { err: json({ error: "Payload too large" }, 413, origin) };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { err: json({ error: "Payload too large" }, 413, origin) };
  }
  return { text };
}

// Relay a POST body to a Supabase edge function, echoing its JSON response.
// Optional extraHeaders are merged into the upstream request.
async function relay(upstream, text, origin, extraHeaders) {
  try {
    const up = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json", ...(extraHeaders || {}) },
      body: text,
    });
    return new Response(await up.text(), {
      status: up.status,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  } catch {
    return json({ error: "upstream unreachable" }, 502, origin);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get("Origin") || "";

    // ── /api/waitlist → relay to the Supabase `waitlist` edge function, same-origin
    // so Brave treats the signup POST as first-party. We add the caller's real IP
    // and country (Cloudflare knows them; the upstream function does not) and an
    // optional shared secret so the public function only trusts proxied calls. ──
    if (path === "/api/waitlist") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      if (request.method !== "POST")    return json({ error: "POST only" }, 405, origin);
      if (!env.WAITLIST_UPSTREAM)       return json({ error: "waitlist unavailable" }, 503, origin);

      const { text, err } = await readBody(request, origin);
      if (err) return err;

      const headers = {
        "X-Real-IP": request.headers.get("CF-Connecting-IP") || "",
        "X-Client-Country": (request.cf && request.cf.country) || "",
      };
      if (env.WAITLIST_PROXY_SECRET) headers["X-Proxy-Secret"] = env.WAITLIST_PROXY_SECRET;
      return relay(env.WAITLIST_UPSTREAM, text, origin, headers);
    }

    // ── /api/quests → relay to the Supabase `quests` edge function (read-only
    // leaderboard). Same-origin so Brave doesn't drop it; no secret needed. ──
    if (path === "/api/quests") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      if (request.method !== "POST")    return json({ error: "POST only" }, 405, origin);
      if (!env.QUESTS_UPSTREAM)         return json({ error: "quests unavailable" }, 503, origin);

      const { text, err } = await readBody(request, origin);
      if (err) return err;
      return relay(env.QUESTS_UPSTREAM, text || "{}", origin);
    }

    // Only /api/rpc remains; everything else (incl. the removed /api/debughub_events)
    // falls through to the static site (origin), which 404s the dead telemetry path.
    if (path !== "/api/rpc") {
      return fetch(request);
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST")    return json({ error: "POST only" }, 405, origin);

    const { text, err } = await readBody(request, origin);
    if (err) return err;

    // ── /api/rpc → Alchemy (relay the JSON-RPC body verbatim; single + batch) ──
    try {
      const up = await fetch(env.ALCHEMY_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      });
      return new Response(await up.text(), {
        status: up.status,
        headers: { ...cors(origin), "Content-Type": "application/json" },
      });
    } catch {
      return json({ error: "upstream unreachable" }, 502, origin);
    }
  },
};
