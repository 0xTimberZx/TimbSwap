// TimbSwap Timber Points — public leaderboard read (Supabase Edge Function, Deno).
//
// The /quests page posts (optionally { address }) to the same-origin Worker route
// POST /api/quests (workers/timbswap-api.js), which relays here. Read-only: returns
// the active season, the top-N leaderboard, and — if an address is given — that
// wallet's row + rank. Uses the service role (RLS is closed on points tables), so
// the anon key never touches them directly.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (both auto-injected).
// Deploy: supabase functions deploy quests --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL     = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOP_N = 100;

const ALLOWED_ORIGINS = new Set([
  "https://timbswap.xyz",
  "https://www.timbswap.xyz",
  "https://0xtimberzx.github.io",
]);
function cors(origin: string) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://timbswap.xyz";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST")    return json({ ok: false, error: "POST only" }, 405, origin);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const wanted = String(body?.address ?? "").trim().toLowerCase();

  const sb = createClient(SB_URL, SB_SERVICE);

  const { data: seasons } = await sb
    .from("seasons").select("id,slug,name,status,start_round,last_processed_round")
    .eq("status", "active").order("id", { ascending: false }).limit(1);

  if (!seasons || !seasons.length) {
    return json({ ok: true, season: null, leaderboard: [] }, 200, origin);
  }
  const season = seasons[0];

  const { data: rows } = await sb
    .from("points_wallets")
    .select("address,display_tp,rounds_played,swap_count,best_streak,wins,diversity")
    .eq("season_id", season.id).is("sybil_flag", null).gt("display_tp", 0)
    .order("display_tp", { ascending: false }).limit(TOP_N);

  const leaderboard = (rows ?? []).map((r, i) => ({ rank: i + 1, ...r }));

  let you: unknown = null;
  if (WALLET_RE.test(wanted)) {
    const { data: mine } = await sb
      .from("points_wallets")
      .select("address,display_tp,rounds_played,swap_count,best_streak,wins,diversity,sybil_flag")
      .eq("season_id", season.id).eq("address", wanted).limit(1);
    if (mine && mine.length) {
      const { data: rank } = await sb.rpc("points_wallet_rank", { p_season: season.id, p_address: wanted });
      const m: any = mine[0];
      you = {
        rank: typeof rank === "number" ? rank : 0,
        address: m.address, display_tp: m.display_tp, rounds_played: m.rounds_played,
        swap_count: m.swap_count, best_streak: m.best_streak, wins: m.wins,
        diversity: m.diversity, flagged: m.sybil_flag != null,
      };
    } else {
      you = { rank: 0, address: wanted, display_tp: 0, rounds_played: 0, swap_count: 0, best_streak: 0, wins: 0, diversity: false, flagged: false };
    }
  }

  return json({
    ok: true,
    season: { name: season.name, slug: season.slug, status: season.status,
              start_round: season.start_round, last_round: season.last_processed_round },
    leaderboard, you,
  }, 200, origin);
});
