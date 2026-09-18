// points-scorer.js
// TimbSwap Timber Points (TP) — incremental scoring keeper.
//
// Design: dev-docs/INCENTIVES.md. Deploy: dev-docs/QUESTS_DEPLOY.md.
//
// Reads NEW on-chain activity since the season's cursors and folds it into the
// Supabase points ledger, then recomputes display_tp. Fully incremental: each run
// only scans blocks/rounds after last_scored_block / last_processed_round, so an
// hourly cron stays cheap even over a 6-week season.
//
//   Repeat play  ← GameRegistry.getRoundEntrants(round) for each newly settled round
//   Volume       ← Pair Swap events, attributed to the REAL trader (tx.from, not the
//                  event's `sender` which is the router)
//   Wins         ← TimbPrize WinningsClaimed events
//   Participation← stake / LP-farm / boost / lock events (the indexed user IS the
//                  real actor — no tx.from needed): feed the diversity bonus
//
// The TP formula lives in SQL (points_recompute); this keeper only feeds aggregates.
//
// Env (GitHub Actions secrets — see .github/workflows/points-scorer.yml):
//   ARB_RPC / ARB_SEPOLIA_RPC   RPC URL (prefer a keyed endpoint for wide getLogs)
//   SUPABASE_URL                https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY        service_role key (bypasses RLS)
//   TELEGRAM_BOT_TOKEN          ops alerts (optional)
//   TELEGRAM_CHAT_ID            ops chat (optional)

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

// POINTS_RPC wins when set: getLogs over wide ranges needs an endpoint without a
// per-call block cap (free-tier keyed RPCs often allow 10 blocks). The workflow
// defaults it to the official public Arbitrum Sepolia RPC.
const RPC_URL  = process.env.POINTS_RPC || process.env.ARB_RPC || process.env.ARB_SEPOLIA_RPC;
const SB_URL   = process.env.SUPABASE_URL;
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_OPS   = process.env.TELEGRAM_CHAT_ID;

const CHUNK_BLOCKS   = Number(process.env.POINTS_CHUNK_BLOCKS || 5000);   // getLogs window (public RPC-safe)
const MAX_ROUNDS_RUN = Number(process.env.POINTS_MAX_ROUNDS  || 200);     // rounds folded per run

const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

function cfgSrc() { return fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8"); }
function addrFromConfig(key) {
  const m = cfgSrc().match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error(`Address "${key}" not found in config.js`);
  return ethers.getAddress(m[1]);
}
// Optional lookup: returns null (skip) instead of throwing when a contract
// isn't present in config.js — so a not-yet-wired module doesn't fail the run.
function optAddr(key) { try { return addrFromConfig(key); } catch { return null; } }

async function tg(chatId, text) {
  if (!TG_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (_e) { /* ops ping is best-effort */ }
}
const ops = (m) => tg(TG_OPS, m);

async function sbGet(pathq) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathq}`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`supabase GET ${pathq}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function sbPatch(pathq, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathq}`, {
    method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase PATCH ${pathq}: ${res.status} ${await res.text()}`);
}
async function sbRpc(fn, args) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: sbHeaders, body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`supabase RPC ${fn}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Chunked queryFilter so a public RPC's getLogs range cap can't blow up.
async function scanEvents(contract, filter, fromBlock, toBlock) {
  const out = [];
  for (let a = fromBlock; a <= toBlock; a += CHUNK_BLOCKS) {
    const b = Math.min(a + CHUNK_BLOCKS - 1, toBlock);
    try {
      out.push(...await contract.queryFilter(filter, a, b));
    } catch (e) {
      // ethers hides the RPC's own message behind "could not coalesce error";
      // surface it so a getLogs cap / unsupported method is diagnosable from the run log.
      const inner = e?.error?.message || e?.info?.error?.message || e?.info?.responseBody || "";
      throw new Error(`getLogs ${a}-${b}: ${e.shortMessage || e.message}${inner ? " — " + String(inner).slice(0, 300) : ""}`);
    }
  }
  return out;
}

async function main() {
  if (!RPC_URL) throw new Error("Missing POINTS_RPC / ARB_RPC / ARB_SEPOLIA_RPC");
  let scanOk = true; // a failed event scan must not advance last_scored_block
  if (!SB_URL || !SB_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");

  // Active season + cursors.
  const seasons = await sbGet("seasons?status=eq.active&order=id.desc&limit=1");
  if (!seasons.length) { console.log("[points] no active season — nothing to do."); return; }
  const s = seasons[0];
  if (s.start_block == null || s.start_round == null) {
    console.log(`[points] season ${s.slug} active but start_block/start_round unset — skipping.`); return;
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const optContract = (key, abi) => { const a = optAddr(key); return a ? new ethers.Contract(a, abi, provider) : null; };

  const PRIZE    = new ethers.Contract(addrFromConfig("TimbPrize"), [
    "function currentRound() view returns (uint256)",
    "event WinningsClaimed(address indexed winner, uint256 indexed round, uint256 amount)",
  ], provider);
  const REGISTRY = new ethers.Contract(addrFromConfig("GameRegistry"), [
    "function getRoundEntrants(uint256 round) view returns (address[])",
  ], provider);
  const PAIR     = new ethers.Contract(addrFromConfig("TimbsEthPair"), [
    "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  ], provider);

  const chainHead = await provider.getBlockNumber();
  const toBlock   = s.end_block != null ? Math.min(Number(s.end_block), chainHead) : chainHead;
  const fromBlock = (s.last_scored_block != null ? Number(s.last_scored_block) + 1 : Number(s.start_block));

  // ── 1) Repeat play: fold newly settled rounds ──
  let roundsAdded = 0;
  let lastRound = s.last_processed_round != null ? Number(s.last_processed_round) : (Number(s.start_round) - 1);
  try {
    const currentRound = Number(await PRIZE.currentRound());
    const endRound = Math.min(currentRound - 1, lastRound + MAX_ROUNDS_RUN); // settled rounds only; bounded backfill
    for (let r = lastRound + 1; r <= endRound; r++) {
      let entrants = [];
      try { entrants = await REGISTRY.getRoundEntrants(r); } catch (e) {
        console.warn(`[points] getRoundEntrants(${r}) failed: ${e.shortMessage || e.message}`); break;
      }
      const uniq = [...new Set(entrants.map(a => a.toLowerCase()))];
      if (uniq.length) await sbRpc("points_apply_round", { p_season: s.id, p_round: r, p_addresses: uniq });
      lastRound = r; roundsAdded++;
    }
  } catch (e) { console.warn("[points] round pass:", e.shortMessage || e.message); }

  // ── 2) Volume + wins + participation flags (same incremental block window) ──
  let swapsAdded = 0;
  if (toBlock >= fromBlock) {
    // Volume: Swap events attributed to tx.from (the real trader).
    try {
      const evs = await scanEvents(PAIR, PAIR.filters.Swap(), fromBlock, toBlock);
      const txFromCache = new Map();
      const perTrader = new Map(); // addr -> { n, fb }
      for (const ev of evs) {
        let from = txFromCache.get(ev.transactionHash);
        if (from === undefined) {
          try { const tx = await provider.getTransaction(ev.transactionHash); from = tx && tx.from ? tx.from.toLowerCase() : null; }
          catch { from = null; }
          txFromCache.set(ev.transactionHash, from);
        }
        if (!from) continue;
        const cur = perTrader.get(from) || { n: 0, fb: ev.blockNumber };
        cur.n += 1; cur.fb = Math.min(cur.fb, ev.blockNumber);
        perTrader.set(from, cur);
      }
      const rows = [...perTrader.entries()].map(([a, v]) => ({ a, n: v.n, fb: v.fb }));
      if (rows.length) await sbRpc("points_apply_swaps", { p_season: s.id, p_rows: rows });
      swapsAdded = evs.length;
    } catch (e) { scanOk = false; console.warn("[points] swap pass:", e.shortMessage || e.message); }

    // Wins: WinningsClaimed.
    try {
      const claims = await scanEvents(PRIZE, PRIZE.filters.WinningsClaimed(), fromBlock, toBlock);
      const perWinner = new Map();
      for (const ev of claims) {
        const w = ev.args.winner.toLowerCase();
        perWinner.set(w, (perWinner.get(w) || 0) + 1);
      }
      const winRows = [...perWinner.entries()].map(([a, n]) => ({ a, n }));
      if (winRows.length) await sbRpc("points_apply_wins", { p_season: s.id, p_rows: winRows });
    } catch (e) { scanOk = false; console.warn("[points] win pass:", e.shortMessage || e.message); }

    // Participation flags: stake / LP-farm / boost / lock. The indexed user/locker
    // is the real actor, so no tx.from mapping is needed. Missing modules skip.
    try {
      const flags = new Map(); // addr -> {stake,lp,lock}
      const mark = (addr, key) => { const a = addr.toLowerCase(); const cur = flags.get(a) || {}; cur[key] = true; flags.set(a, cur); };

      const staking = optContract("TimbStaking", ["event Staked(address indexed user, uint256 amount)"]);
      if (staking) (await scanEvents(staking, staking.filters.Staked(), fromBlock, toBlock)).forEach(ev => mark(ev.args.user, "stake"));

      const farm = optContract("TimbFarm", ["event Staked(address indexed user, uint256 lpAmount)"]);
      if (farm) (await scanEvents(farm, farm.filters.Staked(), fromBlock, toBlock)).forEach(ev => mark(ev.args.user, "lp"));

      const boost = optContract("TimbBoostFarm", ["event Deposited(address indexed user, uint256 indexed pid, uint256 lpAmount)"]);
      if (boost) (await scanEvents(boost, boost.filters.Deposited(), fromBlock, toBlock)).forEach(ev => mark(ev.args.user, "lp"));

      const lock = optContract("TimbLockVault", ["event Locked(uint256 indexed lockId, address indexed locker, address indexed token, uint256 amount, uint256 unlockAt, bool isTimbs)"]);
      if (lock) (await scanEvents(lock, lock.filters.Locked(), fromBlock, toBlock)).forEach(ev => mark(ev.args.locker, "lock"));

      const rows = [...flags.entries()].map(([a, f]) => ({ a, stake: !!f.stake, lp: !!f.lp, lock: !!f.lock }));
      if (rows.length) await sbRpc("points_apply_flags", { p_season: s.id, p_rows: rows });
    } catch (e) { scanOk = false; console.warn("[points] flags pass:", e.shortMessage || e.message); }
  }

  // ── 3) Recompute display_tp + advance cursors ──
  const walletsTotal = await sbRpc("points_recompute", { p_season: s.id });
  // Only advance the block cursor when every event scan succeeded; otherwise the
  // window is retried next run instead of being silently skipped.
  const cursor = { last_processed_round: lastRound, updated_at: new Date().toISOString() };
  if (scanOk) cursor.last_scored_block = toBlock;
  await sbPatch(`seasons?id=eq.${s.id}`, cursor);
  await fetch(`${SB_URL}/rest/v1/points_runs`, {
    method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      season_id: s.id, from_block: fromBlock, to_block: toBlock,
      rounds_added: roundsAdded, swaps_added: swapsAdded, wallets_total: walletsTotal,
      note: `blocks ${fromBlock}–${toBlock}, +${roundsAdded} rounds`,
    }),
  }).catch(() => {});

  console.log(`[points] ${s.slug}: +${roundsAdded} rounds, ${swapsAdded} swap events, ${walletsTotal} wallets scored (blocks ${fromBlock}–${toBlock}).`);
  if (!scanOk) throw new Error(`event scan failed for blocks ${fromBlock}–${toBlock}; cursor not advanced — will retry next run`);
}

main().catch(async (err) => {
  console.error("[points] Fatal:", err.message);
  await ops(`💥 Points scorer error\n${err.message}`);
  process.exit(1);
});
